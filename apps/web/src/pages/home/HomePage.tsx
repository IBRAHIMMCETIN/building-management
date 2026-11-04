import { ApiStatus } from '../../components/ApiStatus';
import styles from './HomePage.module.css';

export function HomePage() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Aidat Yönetim</h1>
      <ApiStatus />
    </main>
  );
}
