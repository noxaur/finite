import * as stylex from "@stylexjs/stylex";
import { Link, Outlet } from "react-router";

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    padding: "24px",
  },
  nav: {
    display: "flex",
    gap: "12px",
  },
});

export function Layout() {
  return (
    <div {...stylex.props(styles.page)}>
      <nav {...stylex.props(styles.nav)}>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </div>
  );
}
