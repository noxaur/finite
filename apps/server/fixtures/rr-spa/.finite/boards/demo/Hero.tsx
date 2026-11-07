import { Link } from "react-router";

export default function Hero() {
  return (
    <section className="bg-[#0a7f3e] p-8">
      <h1 className="text-3xl">A prototype hero</h1>
      <Link to="/about">Read more</Link>
    </section>
  );
}
