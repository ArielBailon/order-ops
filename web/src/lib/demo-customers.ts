/** The seeded customers the console can log in as. Operators and viewers are never offered. */
export const DEMO_CUSTOMERS = [
  { name: 'Ana Torres', email: 'ana@example.com' },
  { name: 'Ben Carter', email: 'ben@example.com' },
  { name: 'Cora Diaz', email: 'cora@example.com' },
] as const;

export function isDemoCustomer(email: unknown): email is string {
  return DEMO_CUSTOMERS.some((customer) => customer.email === email);
}

/** The seeded operator; only the operator page logs in as this account. */
export const DEMO_OPERATOR = {
  name: 'Sam Operator',
  email: 'operator@example.com',
} as const;

/** The seeded read-only viewer; only the dashboard logs in as this account. */
export const DEMO_VIEWER = {
  name: 'Vic Viewer',
  email: 'viewer@example.com',
} as const;
