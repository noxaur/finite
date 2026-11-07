import { create, props } from "@stylexjs/stylex";

const styles = create({
  page: {
    padding: "24px",
  },
});

export default function About() {
  return (
    <section {...props(styles.page)}>
      <h1>Framework about</h1>
      <p>Server-rendered with StyleX.</p>
    </section>
  );
}
