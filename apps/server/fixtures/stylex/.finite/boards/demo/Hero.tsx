import * as stylex from "@stylexjs/stylex";
import { Link } from "react-router";

const styles = stylex.create({
  hero: {
    padding: "32px",
    backgroundColor: "#0a7f3e",
  },
  title: {
    fontSize: "30px",
  },
});

export default function Hero() {
  return (
    <section {...stylex.props(styles.hero)}>
      <h1 {...stylex.props(styles.title)}>A prototype hero</h1>
      <Link to="/about">Read more</Link>
    </section>
  );
}
