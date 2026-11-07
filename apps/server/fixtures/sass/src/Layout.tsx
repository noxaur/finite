import { Link, Outlet } from "react-router";

export function Layout() {
  return (
    <>
      <nav>
        <Link to="/">Home</Link> <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </>
  );
}
