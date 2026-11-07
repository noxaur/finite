import * as stylex from "@stylexjs/stylex";
import { Link } from "react-router";

const styles = stylex.create({
  card: {
    padding: "16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "#c8d3d6",
    backgroundColor: {
      default: "#f7f9fa",
      ":hover": "#e3f1f3",
    },
  },
  featured: {
    borderColor: "#95ced7",
  },
  title: {
    margin: "0",
    fontWeight: "600",
  },
});

export function Card({ title, featured = false }: { title: string; featured?: boolean }) {
  return (
    <div {...stylex.props(styles.card, featured && styles.featured)}>
      <h2 {...stylex.props(styles.title)}>{title}</h2>
      <Link to={`/users/${title}`}>Open</Link>
    </div>
  );
}
