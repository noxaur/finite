import { Card } from "../components/Card.tsx";

const items = ["One", "Two", "Three"];

export default function Home() {
  return (
    <main className="flex flex-col gap-2">
      <h1 className="text-2xl font-bold">Welcome home</h1>
      {items.map((item) => (
        <Card key={item} title={item} />
      ))}
    </main>
  );
}
