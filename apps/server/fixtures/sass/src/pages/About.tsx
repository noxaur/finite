import styles from "./About.module.scss";

export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p className={styles.lede}>
        A fixture with a Sass module, a Less module and a global Sass sheet.
      </p>
    </main>
  );
}
