import * as stylex from "@stylexjs/stylex";
import { Link } from "react-router";
import { colors } from "../tokens.stylex";

const styles = stylex.create({
  card: {
    padding: "16px",
    borderRadius: "8px",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: colors.line,
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
