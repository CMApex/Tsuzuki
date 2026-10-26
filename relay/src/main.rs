// SPDX-License-Identifier: AGPL-3.0-or-later

use std::{net::SocketAddr, path::PathBuf};

use tsuzuki_relay::{app, Config};

const USAGE: &str = "\
tsuzuki-relay — zero-knowledge sync relay for Tsuzuki

Configuration (environment variables):
  TSUZUKI_BIND             address to listen on            (default 127.0.0.1:8787)
  TSUZUKI_DATA             data directory                  (default ./tsuzuki-data)
  TSUZUKI_MAX_BLOB_MB      max snapshot size per device    (default 16)
  TSUZUKI_MAX_DEVICES      max devices per vault           (default 16)
  TSUZUKI_REGISTER_TOKEN   if set, required to create new vaults (recommended when exposed publicly)
  RUST_LOG                 log filter                       (default info)

Source: https://github.com/CMApex/Tsuzuki (AGPL-3.0-or-later; GET / says so too)

Put it behind HTTPS (Caddy, nginx, Tailscale serve, …). Browsers will only
talk to plain http:// relays on localhost.
";

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn env_num(name: &str, default: usize) -> usize {
    match std::env::var(name) {
        Ok(v) if !v.is_empty() => v.parse().unwrap_or_else(|_| {
            eprintln!("{name} must be a number, got {v:?}");
            std::process::exit(2);
        }),
        _ => default,
    }
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|a| a == "-h" || a == "--help") {
        print!("{USAGE}");
        return;
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let bind: SocketAddr = env_or("TSUZUKI_BIND", "127.0.0.1:8787")
        .parse()
        .unwrap_or_else(|e| {
            eprintln!("TSUZUKI_BIND: {e}");
            std::process::exit(2);
        });
    let cfg = Config {
        data_dir: PathBuf::from(env_or("TSUZUKI_DATA", "./tsuzuki-data")),
        max_blob_bytes: env_num("TSUZUKI_MAX_BLOB_MB", 16) * 1024 * 1024,
        max_devices: env_num("TSUZUKI_MAX_DEVICES", 16),
        register_token: std::env::var("TSUZUKI_REGISTER_TOKEN")
            .ok()
            .filter(|t| !t.is_empty()),
    };
    if let Err(e) = std::fs::create_dir_all(cfg.data_dir.join("vaults")) {
        eprintln!("can't create data dir {}: {e}", cfg.data_dir.display());
        std::process::exit(1);
    }
    if cfg.register_token.is_none() && !bind.ip().is_loopback() {
        tracing::warn!("listening on a non-loopback address without TSUZUKI_REGISTER_TOKEN: anyone who can reach this relay can create vaults");
    }

    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("can't bind {bind}: {e}");
            std::process::exit(1);
        });
    tracing::info!(
        "tsuzuki-relay listening on http://{bind} (data: {})",
        cfg.data_dir.display()
    );
    axum::serve(listener, app(cfg))
        .with_graceful_shutdown(shutdown())
        .await
        .expect("server error");
}

async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
