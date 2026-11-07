import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  hero: {
    padding: "32px",
    backgroundColor: "#95ced7",
  },
});

export default function Hero() {
  return (
    <section {...stylex.props(styles.hero)}>
      <h1>A prototype hero</h1>
    </section>
  );
}
