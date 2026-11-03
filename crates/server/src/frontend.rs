//! Serves the built frontend, a Next.js static export: one HTML file per
//! route, plus `404.html`.

use axum::{
    Router,
    extract::Request,
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
};
use tower_http::services::{ServeDir, ServeFile};

/// Next.js puts a content hash in every name under `/_next/static/`, so a
/// file there never changes.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Everything else, the HTML above all, names the build's chunks. Without a
/// `Cache-Control` the browser caches it on a guess from `Last-Modified`, so
/// after an update the desktop app loaded the old page and its chunks 404'd.
/// `no-cache` makes it ask each time; an unchanged file answers 304.
const REVALIDATE: &str = "no-cache";

/// Adds the frontend in `dir` to `router` as its fallback.
pub fn serve(router: Router, dir: &str) -> Router {
    let not_found = format!("{dir}/404.html");
    let files = Router::new()
        .fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(not_found)))
        .layer(middleware::from_fn(cache_control));
    router.fallback_service(files)
}

async fn cache_control(req: Request, next: Next) -> Response {
    let policy = if req.uri().path().starts_with("/_next/static/") {
        IMMUTABLE
    } else {
        REVALIDATE
    };
    let mut res = next.run(req).await;
    // A missing chunk 404s; caching that for a year would outlive the fix.
    let policy = if res.status().is_success() || res.status().as_u16() == 304 {
        policy
    } else {
        REVALIDATE
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;

    async fn cache_header(dir: &std::path::Path, path: &str) -> (u16, String) {
        let app = serve(Router::new(), dir.to_str().unwrap());
        let res = app
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let policy = res.headers()[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .to_owned();
        (res.status().as_u16(), policy)
    }

    #[tokio::test]
    async fn html_revalidates_and_hashed_chunks_are_immutable() {
        let dir = std::env::temp_dir().join(format!("finite-frontend-{}", uuid::Uuid::new_v4()));
        let chunks = dir.join("_next/static/chunks");
        std::fs::create_dir_all(&chunks).unwrap();
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
        std::fs::write(dir.join("404.html"), "missing").unwrap();
        std::fs::write(chunks.join("abc123.js"), "").unwrap();

        assert_eq!(cache_header(&dir, "/").await, (200, REVALIDATE.into()));
        assert_eq!(
            cache_header(&dir, "/_next/static/chunks/abc123.js").await,
            (200, IMMUTABLE.into())
        );
        // An old page asking for the last build's chunk.
        assert_eq!(
            cache_header(&dir, "/_next/static/chunks/old.js").await,
            (404, REVALIDATE.into())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
