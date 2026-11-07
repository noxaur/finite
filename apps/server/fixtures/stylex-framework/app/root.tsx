import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

const styles = stylex.create({
  body: {
    margin: "0",
    fontFamily: "system-ui, sans-serif",
  },
});

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        {/* StyleX's dev stylesheet, and the runtime that refetches it on HMR and disables the link. */}
        {import.meta.env.DEV && (
          <link rel="stylesheet" href="/virtual:stylex.css" suppressHydrationWarning />
        )}
        {import.meta.env.DEV && <script type="module" src="/@id/virtual:stylex:runtime" />}
      </head>
      <body {...stylex.props(styles.body)}>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
