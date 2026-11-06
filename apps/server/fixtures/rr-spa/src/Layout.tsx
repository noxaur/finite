import { Link, Outlet } from "react-router";

export function Layout() {
  return (
    <div className="flex flex-col gap-4 p-6">
      <nav className="flex gap-3">
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
      </nav>
      <Outlet />
    </div>
  );
}
