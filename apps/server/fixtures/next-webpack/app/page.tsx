import Link from "next/link";
import { Counter } from "./_components/Counter";

declare const __BUNDLER__: string;

export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold text-brand">Home</h1>
      <p>Built with {__BUNDLER__}</p>
      <Link href="/about" className="underline">
        About
      </Link>
      <Counter />
    </main>
  );
}
