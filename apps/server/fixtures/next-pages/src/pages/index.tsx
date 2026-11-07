import Link from "next/link";
import styles from "../styles/Home.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Home</h1>
      <Link href="/about">About</Link>
    </main>
  );
}
