use axum::{Json, Router, extract::Query, routing::get};
use serde::{Deserialize, Serialize};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

#[derive(Serialize)]
pub struct Health {
    status: &'static str,
    version: &'static str,
}

#[derive(Deserialize)]
pub struct GreetParams {
    name: Option<String>,
}

#[derive(Serialize)]
pub struct Greeting {
    message: String,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn greet(Query(params): Query<GreetParams>) -> Json<Greeting> {
    let name = params.name.as_deref().map(str::trim).unwrap_or_default();
    let name = if name.is_empty() { "world" } else { name };
    Json(Greeting {
        message: format!("Hello, {name}! (from Rust)"),
    })
}

/// Builds the router. Routes the frontend calls live under `/api`, matching
/// `apps/web/src/api/Api.ts`.
pub fn app(static_dir: Option<&str>) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/greet", get(greet));

    let router = Router::new().nest("/api", api);

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
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn get_json(uri: &str) -> serde_json::Value {
        let res = app(None)
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert!(res.status().is_success());
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn health_is_ok() {
        assert_eq!(get_json("/api/health").await["status"], "ok");
    }

    #[tokio::test]
    async fn greet_uses_name() {
        assert_eq!(
            get_json("/api/greet?name=Ada").await["message"],
            "Hello, Ada! (from Rust)"
        );
    }

    #[tokio::test]
    async fn greet_defaults_to_world() {
        assert_eq!(
            get_json("/api/greet?name=%20").await["message"],
            "Hello, world! (from Rust)"
        );
    }
}
