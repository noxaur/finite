import { create, props } from "@stylexjs/stylex";
import { Card } from "../components/Card.tsx";

const items = ["One", "Two", "Three"];

const styles = create({
  main: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  heading: {
    fontSize: "24px",
    fontWeight: "700",
  },
});

export default function Home() {
  return (
    <main {...props(styles.main)}>
      <h1 {...props(styles.heading)}>Welcome home</h1>
      {items.map((item, i) => (
        <Card key={item} title={item} featured={i === 0} />
      ))}
    </main>
  );
}
