import type { Metadata } from 'next';
import { Dashboard } from '@/components/dashboard';

export const metadata: Metadata = {
  title: 'Observability dashboard - OrderOps demo',
};

export default function DashboardPage() {
  // Server-only setting; the client only gets the URL itself, never other env values.
  return <Dashboard langfuseProjectUrl={process.env.LANGFUSE_PROJECT_URL} />;
}
