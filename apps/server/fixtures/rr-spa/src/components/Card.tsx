import { Link } from "react-router";

export function Card({ title }: { title: string }) {
  return (
    <div className="rounded-lg border p-4">
      <h2 className="font-semibold">{title}</h2>
      <Link to={`/users/${title}`}>Open</Link>
    </div>
  );
}
