use std::sync::Arc;

use axum::{Json, Router, routing::get};
use serde::Serialize;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

pub mod api;
pub mod cluster;
pub mod guard;
pub mod hub;
pub mod mcp;
pub mod relay;
pub mod router;
pub mod screenshot;
pub mod store;

pub use hub::Hub;

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Builds the router:
///
/// - `/api/*` for the web app, matching `apps/web/src/api/Api.ts`
/// - `/mcp` for agents (MCP over Streamable HTTP)
/// - the built frontend, when `static_dir` is set
pub fn app(hub: Arc<Hub>, static_dir: Option<&str>) -> Router {
    let allowed: std::sync::Arc<[String]> = hub.cluster().allowed_hosts().into();
    let api = Router::new()
        .route("/health", get(health))
        .merge(api::routes())
        .with_state(hub.clone())
        .layer(axum::middleware::from_fn_with_state(
            allowed,
            guard::known_hosts,
        ));

    let router = Router::new()
        .nest("/api", api)
        .nest_service("/mcp", mcp::service(hub));

    let router = match static_dir {
        // A Next.js static export: one HTML file per route, plus `404.html`.
        Some(dir) => {
            let not_found = format!("{dir}/404.html");
            router.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(not_found)))
        }
        None => router,
    };

    router.layer(TraceLayer::new_for_http())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use axum::{
        body::Body,
        http::{Request, header},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_app() -> Router {
        app(Hub::new(Arc::new(MemoryStore::default())).unwrap(), None)
    }

    async fn call(app: &Router, req: Request<Body>) -> (axum::http::StatusCode, serde_json::Value) {
        let res = app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    #[tokio::test]
    async fn health_is_ok() {
        let (_, body) = call(
            &test_app(),
            Request::get("/api/health").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(body["status"], "ok");
    }

    #[tokio::test]
    async fn create_and_fetch_design() {
        let app = test_app();
        let req = Request::post("/api/designs")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"Landing"}"#))
            .unwrap();
        let (status, created) = call(&app, req).await;
        assert_eq!(status, 201);
        assert_eq!(created["name"], "Landing");

        let id = created["id"].as_str().unwrap();
        let (_, snapshot) = call(
            &app,
            Request::get(format!("/api/designs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(snapshot["seq"], 0);
        assert_eq!(snapshot["nodes"], serde_json::json!([]));

        let (_, list) = call(
            &app,
            Request::get("/api/designs").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(list.as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unknown_design_is_404() {
        let (status, _) = call(
            &test_app(),
            Request::get("/api/designs/nope")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, 404);
    }
}
