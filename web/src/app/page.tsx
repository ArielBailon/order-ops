import { Console } from '@/components/console';

export default function Home() {
  // The shared demo password is public on purpose (shown on the login screen); null when unset.
  return <Console demoPassword={process.env.DEMO_PASSWORD || null} />;
}
