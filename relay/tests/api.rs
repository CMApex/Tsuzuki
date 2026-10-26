// SPDX-License-Identifier: AGPL-3.0-or-later

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use tower::ServiceExt;
use tsuzuki_relay::{app, Config, REGISTER_HEADER};

const VAULT: &str = "vault_AAAAAAAAAAAAAAAAAA";
const DEV_A: &str = "deviceAAAAAAAAAA";
const DEV_B: &str = "deviceBBBBBBBBBB";
const TOKEN: &str = "token-0123456789abcdefghijkl";

fn relay(dir: &tempfile::TempDir, tweak: impl FnOnce(&mut Config)) -> Router {
    let mut cfg = Config {
        data_dir: dir.path().to_path_buf(),
        max_blob_bytes: 1024,
        max_devices: 2,
        register_token: None,
    };
    tweak(&mut cfg);
    app(cfg)
}

async fn call(
    app: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: &[u8],
    extra: &[(&str, &str)],
) -> (StatusCode, Vec<u8>, Option<String>) {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(t) = token {
        req = req.header(header::AUTHORIZATION, format!("Bearer {t}"));
    }
    for (k, v) in extra {
        req = req.header(*k, *v);
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_vec())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let etag = res
        .headers()
        .get(header::ETAG)
        .map(|v| v.to_str().unwrap().trim_matches('"').to_string());
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, bytes, etag)
}

fn blob_url(dev: &str) -> String {
    format!("/v1/vaults/{VAULT}/blobs/{dev}")
}

fn list_url() -> String {
    format!("/v1/vaults/{VAULT}/blobs")
}

#[tokio::test]
async fn round_trip_with_etags() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});

    // Vault doesn't exist yet.
    assert_eq!(
        call(&r, "GET", &list_url(), Some(TOKEN), b"", &[]).await.0,
        StatusCode::NOT_FOUND
    );

    // First upload creates it (trust on first use).
    let (s, _, etag) = call(
        &r,
        "PUT",
        &blob_url(DEV_A),
        Some(TOKEN),
        b"ciphertext-1",
        &[],
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let etag = etag.unwrap();

    let (s, body, _) = call(&r, "GET", &list_url(), Some(TOKEN), b"", &[]).await;
    assert_eq!(s, StatusCode::OK);
    let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(list["blobs"][0]["device"], DEV_A);
    assert_eq!(list["blobs"][0]["etag"], etag.as_str());
    assert_eq!(list["blobs"][0]["size"], 12);

    let (s, body, got) = call(&r, "GET", &blob_url(DEV_A), Some(TOKEN), b"", &[]).await;
    assert_eq!(
        (s, body.as_slice(), got.as_deref()),
        (StatusCode::OK, &b"ciphertext-1"[..], Some(etag.as_str()))
    );

    let inm = format!("\"{etag}\"");
    let (s, body, _) = call(
        &r,
        "GET",
        &blob_url(DEV_A),
        Some(TOKEN),
        b"",
        &[("if-none-match", &inm)],
    )
    .await;
    assert_eq!(s, StatusCode::NOT_MODIFIED);
    assert!(body.is_empty());

    // Overwrite changes the etag (and the list reflects it).
    let (_, _, etag2) = call(
        &r,
        "PUT",
        &blob_url(DEV_A),
        Some(TOKEN),
        b"ciphertext-2",
        &[],
    )
    .await;
    assert_ne!(etag2.as_deref(), Some(etag.as_str()));
    let (_, body, _) = call(&r, "GET", &list_url(), Some(TOKEN), b"", &[]).await;
    let list: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(list["blobs"][0]["etag"], etag2.unwrap().as_str());
}

#[tokio::test]
async fn wrong_or_missing_token_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), b"x", &[]).await;

    let wrong = "token-WRONG-WRONG-WRONG-WRONG";
    assert_eq!(
        call(&r, "GET", &list_url(), Some(wrong), b"", &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&r, "GET", &list_url(), None, b"", &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_A), Some(wrong), b"evil", &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &r,
            "DELETE",
            &format!("/v1/vaults/{VAULT}"),
            Some(wrong),
            b"",
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    // Data untouched.
    assert_eq!(
        call(&r, "GET", &blob_url(DEV_A), Some(TOKEN), b"", &[])
            .await
            .1,
        b"x"
    );
    // The token itself is never stored, only its hash.
    let auth = std::fs::read_to_string(dir.path().join("vaults").join(VAULT).join("auth")).unwrap();
    assert!(!auth.contains(TOKEN));
    assert_eq!(auth.len(), 64);
}

#[tokio::test]
async fn ids_are_validated_against_traversal() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    for path in [
        format!("/v1/vaults/{VAULT}/blobs/..%2F..%2Fauth%2F%2F%2F%2F%2F"),
        format!("/v1/vaults/{VAULT}/blobs/short"),
        "/v1/vaults/..%2F..%2F..%2Fetc%2Fpasswd/blobs/deviceAAAAAAAAAA".to_string(),
        format!("/v1/vaults/{VAULT}/blobs/device.AAAAAAAAAAAAA"),
    ] {
        let (s, _, _) = call(&r, "PUT", &path, Some(TOKEN), b"x", &[]).await;
        assert!(
            s == StatusCode::BAD_REQUEST || s == StatusCode::NOT_FOUND,
            "{path} -> {s}"
        );
    }
    assert!(
        !dir.path().join("vaults").join(VAULT).exists(),
        "nothing created"
    );
}

#[tokio::test]
async fn limits_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), &[0u8; 2048], &[])
            .await
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), b"", &[])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), b"a", &[]).await;
    call(&r, "PUT", &blob_url(DEV_B), Some(TOKEN), b"b", &[]).await;
    let third = "deviceCCCCCCCCCC";
    assert_eq!(
        call(&r, "PUT", &blob_url(third), Some(TOKEN), b"c", &[])
            .await
            .0,
        StatusCode::CONFLICT
    );
    // Existing devices can still update at the cap.
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_B), Some(TOKEN), b"b2", &[])
            .await
            .0,
        StatusCode::OK
    );
    // Removing a device frees a slot.
    assert_eq!(
        call(&r, "DELETE", &blob_url(DEV_B), Some(TOKEN), b"", &[])
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        call(&r, "PUT", &blob_url(third), Some(TOKEN), b"c", &[])
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn registration_token_gates_new_vaults_only() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |c| c.register_token = Some("let-me-in".into()));
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), b"x", &[])
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            &blob_url(DEV_A),
            Some(TOKEN),
            b"x",
            &[(REGISTER_HEADER, "nope")]
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &r,
            "PUT",
            &blob_url(DEV_A),
            Some(TOKEN),
            b"x",
            &[(REGISTER_HEADER, "let-me-in")]
        )
        .await
        .0,
        StatusCode::OK
    );
    // Once the vault exists, normal auth is enough.
    assert_eq!(
        call(&r, "PUT", &blob_url(DEV_B), Some(TOKEN), b"y", &[])
            .await
            .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn delete_vault_removes_everything() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    call(&r, "PUT", &blob_url(DEV_A), Some(TOKEN), b"x", &[]).await;
    assert_eq!(
        call(
            &r,
            "DELETE",
            &format!("/v1/vaults/{VAULT}"),
            Some(TOKEN),
            b"",
            &[]
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    assert!(!dir.path().join("vaults").join(VAULT).exists());
    assert_eq!(
        call(&r, "GET", &list_url(), Some(TOKEN), b"", &[]).await.0,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn cors_preflight_allows_extension_origins() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    let req = Request::builder()
        .method("OPTIONS")
        .uri(list_url())
        .header("origin", "moz-extension://1234-abcd")
        .header("access-control-request-method", "PUT")
        .header(
            "access-control-request-headers",
            "authorization,content-type",
        )
        .body(Body::empty())
        .unwrap();
    let res = r.oneshot(req).await.unwrap();
    assert!(res.status().is_success());
    assert_eq!(res.headers()["access-control-allow-origin"], "*");
}

#[tokio::test]
async fn root_points_to_source() {
    let dir = tempfile::tempdir().unwrap();
    let r = relay(&dir, |_| {});
    let (s, body, _) = call(&r, "GET", "/", None, b"", &[]).await;
    assert_eq!(s, StatusCode::OK);
    let text = String::from_utf8(body).unwrap();
    assert!(text.contains(tsuzuki_relay::SOURCE_URL) && text.contains("AGPL-3.0-or-later"));
}
