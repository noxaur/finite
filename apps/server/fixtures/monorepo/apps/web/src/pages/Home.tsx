import { Badge } from "@fixture/ui";
import { useEffect, useState } from "react";

export default function Home() {
  const [hello, setHello] = useState("Loading…");
  useEffect(() => {
    fetch(`http://127.0.0.1:${import.meta.env.API_PORT}/hello`)
      .then((response) => response.text())
      .then(setHello, () => setHello("The api isn't running"));
  }, []);
  return (
    <main className="flex flex-col gap-2 p-6">
      <h1 className="text-2xl font-bold">Monorepo home</h1>
      <p data-testid="hello">{hello}</p>
      <Badge>from @fixture/ui</Badge>
    </main>
  );
}
