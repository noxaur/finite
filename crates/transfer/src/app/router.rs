//! The router an exported app uses. Everything else in the project (the
//! scaffold, the screens, the CSS, the assets) is the same for every
//! router, so a router is these four functions, and [`RouterKind`] lists
//! them the way [`crate::Format`] lists formats.

/// An npm package and the exact version the project pins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Package {
    pub name: &'static str,
    pub version: &'static str,
}

/// A route's screen component, for [`Router::files`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Page {
    /// Where the router serves it: `/`, or `/` and segments of letters,
    /// digits and `-._~`. Never repeated. The first page is `/`.
    pub path: String,
    /// The default export of its module, a valid identifier.
    pub component: String,
    /// The module to import it from, relative to `src/`, without an
    /// extension: `./pages/PageCart`.
    pub module: String,
}

/// A file the router writes: a path from the project's root, and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct File {
    pub path: String,
    pub text: String,
}

pub trait Router: Sync {
    /// Short and lowercase, like `react-router`.
    fn name(&self) -> &'static str;

    /// The packages it needs, beyond React, Vite and TypeScript.
    fn packages(&self) -> &'static [Package];

    /// The prop of its link component that holds where to go: `to` for
    /// React Router and TanStack Router, `href` for Next.
    fn link_prop(&self) -> &'static str;

    /// The files that set up routing for `pages`. It must write
    /// `src/link.ts`, which exports the link component as `Link`, and
    /// `src/router.tsx`, which exports `App`, the element `src/main.tsx`
    /// renders. Screens import `Link` from `link.ts` and nothing from the
    /// router itself.
    fn files(&self, pages: &[Page]) -> Vec<File>;
}

/// The routers an app can use. Each variant names its adapter in
/// [`RouterKind::router`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RouterKind {
    /// React Router 7 in its declarative mode.
    #[default]
    ReactRouter,
}

impl RouterKind {
    pub const ALL: [RouterKind; 1] = [RouterKind::ReactRouter];

    pub fn router(self) -> &'static dyn Router {
        match self {
            RouterKind::ReactRouter => &ReactRouter,
        }
    }

    /// The router named `name`.
    pub fn named(name: &str) -> Option<RouterKind> {
        Self::ALL.into_iter().find(|r| r.router().name() == name)
    }
}

struct ReactRouter;

impl Router for ReactRouter {
    fn name(&self) -> &'static str {
        "react-router"
    }

    fn packages(&self) -> &'static [Package] {
        &[Package {
            name: "react-router",
            version: "7.18.5",
        }]
    }

    fn link_prop(&self) -> &'static str {
        "to"
    }

    fn files(&self, pages: &[Page]) -> Vec<File> {
        let mut router = String::from(
            "import { useEffect } from \"react\";\nimport { BrowserRouter, Route, Routes, useLocation } from \"react-router\";\n",
        );
        for page in pages {
            router.push_str(&format!(
                "import {} from \"{}\";\n",
                page.component, page.module
            ));
        }
        router.push_str(
            "\nfunction ScrollToTop() {\n  const { pathname } = useLocation();\n  useEffect(() => {\n    window.scrollTo(0, 0);\n  }, [pathname]);\n  return null;\n}\n\nexport function App() {\n  return (\n    <BrowserRouter>\n      <ScrollToTop />\n      <Routes>\n",
        );
        for page in pages {
            router.push_str(&format!(
                "        <Route path=\"{}\" element={{<{} />}} />\n",
                page.path, page.component
            ));
        }
        router.push_str("      </Routes>\n    </BrowserRouter>\n  );\n}\n");
        vec![
            File {
                path: "src/link.ts".into(),
                text: "export { Link } from \"react-router\";\n".into(),
            },
            File {
                path: "src/router.tsx".into(),
                text: router,
            },
        ]
    }
}
