import { Badge } from "../components/Badge";
import { Card } from "../components/Card";

export default function Home() {
  return (
    <main>
      <h1>Sass and Less</h1>
      <Card title="Scss module" note="Nested and compiled by sass." />
      <Badge>Less module</Badge>
    </main>
  );
}
