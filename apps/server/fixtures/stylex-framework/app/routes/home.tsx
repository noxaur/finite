import * as stylex from "@stylexjs/stylex";
import { Link } from "react-router";

const styles = stylex.create({
  main: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    padding: "24px",
  },
  heading: {
    fontSize: "28px",
    color: "#0a7f3e",
  },
});

export default function Home() {
  return (
    <main {...stylex.props(styles.main)}>
      <h1 {...stylex.props(styles.heading)}>Framework home</h1>
      <Link to="/about">About</Link>
    </main>
  );
}
