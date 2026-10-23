import type { Metadata } from 'next';
import { OperatorConsole } from '@/components/operator-console';

export const metadata: Metadata = {
  title: 'Operator console - OrderOps demo',
};

export default function OperatorPage() {
  return <OperatorConsole />;
}
