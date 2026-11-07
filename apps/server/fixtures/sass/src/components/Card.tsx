import styles from "./Card.module.scss";

export function Card({ title, note }: { title: string; note: string }) {
  return (
    <article className={styles.card}>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.note}>{note}</p>
    </article>
  );
}
