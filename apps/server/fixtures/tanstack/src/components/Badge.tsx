import { Link } from "@tanstack/react-router";

export function Badge() {
  return (
    <Link to="/about">
      <span className="badge">About</span>
    </Link>
  );
}
