import { Outlet } from "react-router";

export default function Shell() {
  return (
    <div className="shell">
      <Outlet />
    </div>
  );
}
