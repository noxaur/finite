import styles from "./Badge.module.less";

export function Badge({ children }: { children: string }) {
  return <span className={styles.badge}>{children}</span>;
}
