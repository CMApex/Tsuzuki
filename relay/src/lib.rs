//! Tsuzuki relay: a deliberately dumb, zero-knowledge blob store.
//!
//! Layout on disk:
//!
//! ```text
//! <data>/vaults/<vault-id>/auth                 hex SHA-256 of the vault's bearer token
//! <data>/vaults/<vault-id>/blobs/<device>.bin   one encrypted snapshot per device
//! ```
//!
//! The relay never sees a key. It authenticates requests with a bearer token
//! that clients derive from their passphrase (it stores only the token's hash,
//! trust-on-first-use), stores opaque ciphertext, and hands it back. Clients
//! do all merging. A malicious relay can withhold or replay blobs, but it
//! cannot read or forge them, and replaying old data is harmless because the
//! client-side merge is a last-writer-wins CRDT.

use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{fs, sync::Mutex};
use tower_http::cors::{Any, CorsLayer};

pub const REGISTER_HEADER: &str = "x-tsuzuki-register";

#[derive(Clone, Debug)]
pub struct Config {
    pub data_dir: PathBuf,
    pub max_blob_bytes: usize,
    pub max_devices: usize,
    /// If set, creating a *new* vault requires this value in `x-tsuzuki-register`.
    /// Existing vaults keep working without it. Set this on any internet-facing relay.
    pub register_token: Option<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("./tsuzuki-data"),
            max_blob_bytes: 16 * 1024 * 1024,
            max_devices: 16,
            register_token: None,
        }
    }
}

struct AppState {
    cfg: Config,
    /// Serializes vault creation so two first-uploads can't race on the auth file.
    create_lock: Mutex<()>,
    /// ETag cache keyed by blob path, invalidated by (len, mtime).
    etags: Mutex<HashMap<PathBuf, (u64, SystemTime, String)>>,
}

type Shared = Arc<AppState>;

pub fn app(cfg: Config) -> Router {
    let max = cfg.max_blob_bytes;
    let state = Arc::new(AppState {
        cfg,
        create_lock: Mutex::new(()),
        etags: Mutex::new(HashMap::new()),
    });

    // Browser extensions call the relay cross-origin. Requests are authenticated
    // by bearer token, not cookies, so a wildcard origin is safe here.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
            HeaderName::from_static(REGISTER_HEADER),
        ])
        .expose_headers([header::ETAG])
        .max_age(Duration::from_secs(3600));

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/vaults/{vault}", delete(delete_vault))
        .route("/v1/vaults/{vault}/blobs", get(list_blobs))
        .route(
            "/v1/vaults/{vault}/blobs/{device}",
            get(get_blob).put(put_blob).delete(delete_blob),
        )
        .layer(DefaultBodyLimit::max(max))
        .layer(cors)
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum ApiError {
    BadRequest(&'static str),
    Unauthorized,
    Forbidden(&'static str),
    NotFound,
    Conflict(&'static str),
    Internal(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            ApiError::Forbidden(m) => (StatusCode::FORBIDDEN, m),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found"),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m),
            ApiError::Internal(detail) => {
                tracing::error!("internal error: {detail}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error")
            }
        };
        (status, Json(serde_json::json!({ "error": msg }))).into_response()
    }
}

fn io_err(e: std::io::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}

// ---------------------------------------------------------------------------
// Validation & auth
// ---------------------------------------------------------------------------

/// Vault and device ids: 16–64 URL-safe characters. Rules out path traversal by construction.
pub fn valid_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    let token = value
        .strip_prefix("Bearer ")
        .ok_or(ApiError::Unauthorized)?;
    if !(16..=256).contains(&token.len()) {
        return Err(ApiError::Unauthorized);
    }
    Ok(token)
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

struct VaultPaths {
    root: PathBuf,
    auth: PathBuf,
    blobs: PathBuf,
}

fn vault_paths(st: &AppState, vault: &str) -> Result<VaultPaths, ApiError> {
    if !valid_id(vault) {
        return Err(ApiError::BadRequest("invalid vault id"));
    }
    let root = st.cfg.data_dir.join("vaults").join(vault);
    Ok(VaultPaths {
        auth: root.join("auth"),
        blobs: root.join("blobs"),
        root,
    })
}

fn blob_path(p: &VaultPaths, device: &str) -> Result<PathBuf, ApiError> {
    if !valid_id(device) {
        return Err(ApiError::BadRequest("invalid device id"));
    }
    Ok(p.blobs.join(format!("{device}.bin")))
}

/// Check the bearer token against an existing vault.
async fn authorize(
    st: &AppState,
    vault: &str,
    headers: &HeaderMap,
) -> Result<VaultPaths, ApiError> {
    let paths = vault_paths(st, vault)?;
    let token = bearer(headers)?;
    let stored = match fs::read_to_string(&paths.auth).await {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(ApiError::NotFound),
        Err(e) => return Err(io_err(e)),
    };
    if ct_eq(stored.trim(), &sha256_hex(token.as_bytes())) {
        Ok(paths)
    } else {
        Err(ApiError::Unauthorized)
    }
}

/// Like `authorize`, but creates the vault (trust on first use) if it doesn't exist.
async fn authorize_or_create(
    st: &AppState,
    vault: &str,
    headers: &HeaderMap,
) -> Result<VaultPaths, ApiError> {
    match authorize(st, vault, headers).await {
        Err(ApiError::NotFound) => {}
        other => return other,
    }
    let _guard = st.create_lock.lock().await;
    // Someone may have created it while we waited.
    match authorize(st, vault, headers).await {
        Err(ApiError::NotFound) => {}
        other => return other,
    }
    if let Some(required) = &st.cfg.register_token {
        let given = headers
            .get(REGISTER_HEADER)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !ct_eq(given, required) {
            return Err(ApiError::Forbidden(
                "registration token required to create a vault",
            ));
        }
    }
    let paths = vault_paths(st, vault)?;
    let token = bearer(headers)?;
    fs::create_dir_all(&paths.blobs).await.map_err(io_err)?;
    write_atomic(&paths.auth, sha256_hex(token.as_bytes()).as_bytes()).await?;
    tracing::info!("created vault {}…", &vault[..6]);
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async fn write_atomic(path: &FsPath, data: &[u8]) -> Result<(), ApiError> {
    let mut nonce = [0u8; 8];
    // Not security-relevant, just a unique temp name.
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    nonce.copy_from_slice(&(t as u64).to_le_bytes());
    let tmp = path.with_extension(format!("tmp-{}", hex::encode(nonce)));
    fs::write(&tmp, data).await.map_err(io_err)?;
    if let Err(e) = fs::rename(&tmp, path).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(io_err(e));
    }
    Ok(())
}

fn etag_of(data: &[u8]) -> String {
    sha256_hex(data)[..32].to_string()
}

async fn cached_etag(
    st: &AppState,
    path: &FsPath,
    len: u64,
    mtime: SystemTime,
) -> Result<String, ApiError> {
    if let Some((l, m, tag)) = st.etags.lock().await.get(path) {
        if *l == len && *m == mtime {
            return Ok(tag.clone());
        }
    }
    let data = fs::read(path).await.map_err(io_err)?;
    let tag = etag_of(&data);
    st.etags
        .lock()
        .await
        .insert(path.to_path_buf(), (len, mtime, tag.clone()));
    Ok(tag)
}

fn millis(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn quoted(etag: &str) -> HeaderValue {
    HeaderValue::from_str(&format!("\"{etag}\"")).expect("hex etag is a valid header")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct BlobInfo {
    device: String,
    etag: String,
    size: u64,
    updated_ms: u64,
}

async fn list_blobs(
    State(st): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let paths = authorize(&st, &vault, &headers).await?;
    let mut out = Vec::new();
    let mut dir = match fs::read_dir(&paths.blobs).await {
        Ok(d) => d,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok(Json(serde_json::json!({ "blobs": out })))
        }
        Err(e) => return Err(io_err(e)),
    };
    while let Some(entry) = dir.next_entry().await.map_err(io_err)? {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(device) = name.strip_suffix(".bin") else {
            continue;
        };
        if !valid_id(device) {
            continue;
        }
        let meta = match entry.metadata().await {
            Ok(m) => m,
            Err(e) if e.kind() == ErrorKind::NotFound => continue, // deleted mid-listing
            Err(e) => return Err(io_err(e)),
        };
        let mtime = meta.modified().map_err(io_err)?;
        let etag = match cached_etag(&st, &entry.path(), meta.len(), mtime).await {
            Ok(t) => t,
            Err(_) => continue,
        };
        out.push(BlobInfo {
            device: device.to_string(),
            etag,
            size: meta.len(),
            updated_ms: millis(mtime),
        });
    }
    out.sort_by(|a, b| a.device.cmp(&b.device));
    Ok(Json(serde_json::json!({ "blobs": out })))
}

async fn get_blob(
    State(st): State<Shared>,
    Path((vault, device)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let paths = authorize(&st, &vault, &headers).await?;
    let path = blob_path(&paths, &device)?;
    let data = match fs::read(&path).await {
        Ok(d) => d,
        Err(e) if e.kind() == ErrorKind::NotFound => return Err(ApiError::NotFound),
        Err(e) => return Err(io_err(e)),
    };
    let etag = etag_of(&data);
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.trim_matches('"') == etag)
        .unwrap_or(false);
    let mut res = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        (StatusCode::OK, data).into_response()
    };
    let h = res.headers_mut();
    h.insert(header::ETAG, quoted(&etag));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(res)
}

async fn put_blob(
    State(st): State<Shared>,
    Path((vault, device)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    // Validate ids before possibly creating a vault.
    let paths = vault_paths(&st, &vault)?;
    let path = blob_path(&paths, &device)?;
    if body.is_empty() {
        return Err(ApiError::BadRequest("empty body"));
    }
    let paths = authorize_or_create(&st, &vault, &headers).await?;

    if fs::metadata(&path).await.is_err() {
        let mut count = 0usize;
        if let Ok(mut dir) = fs::read_dir(&paths.blobs).await {
            while let Ok(Some(e)) = dir.next_entry().await {
                if e.file_name().to_string_lossy().ends_with(".bin") {
                    count += 1;
                }
            }
        }
        if count >= st.cfg.max_devices {
            return Err(ApiError::Conflict("too many devices in this vault"));
        }
    }

    fs::create_dir_all(&paths.blobs).await.map_err(io_err)?;
    write_atomic(&path, &body).await?;
    let etag = etag_of(&body);
    let mut res = (StatusCode::OK, Json(serde_json::json!({ "etag": etag }))).into_response();
    res.headers_mut().insert(header::ETAG, quoted(&etag));
    Ok(res)
}

async fn delete_blob(
    State(st): State<Shared>,
    Path((vault, device)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let paths = authorize(&st, &vault, &headers).await?;
    let path = blob_path(&paths, &device)?;
    match fs::remove_file(&path).await {
        Ok(()) => {
            st.etags.lock().await.remove(&path);
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Err(ApiError::NotFound),
        Err(e) => Err(io_err(e)),
    }
}

async fn delete_vault(
    State(st): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    let paths = authorize(&st, &vault, &headers).await?;
    fs::remove_dir_all(&paths.root).await.map_err(io_err)?;
    st.etags
        .lock()
        .await
        .retain(|p, _| !p.starts_with(&paths.root));
    tracing::info!("deleted vault {}…", &vault[..6]);
    Ok(StatusCode::NO_CONTENT)
}
