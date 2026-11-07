import { useRouter } from "next/router";
import styles from "../../styles/Home.module.css";

export default function Post() {
  const { id } = useRouter().query;
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Post {id}</h1>
    </main>
  );
}
