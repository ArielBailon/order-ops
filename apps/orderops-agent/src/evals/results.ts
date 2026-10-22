import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResultFile } from './cli.js';

// No side effects on import: the gateway bundles this module (the observability API reads
// the same files), so it must not run anything when loaded.

/** The newest run of each provider, in provider-name order. */
export function latestPerProvider(results: ResultFile[]): ResultFile[] {
  const latest = new Map<string, ResultFile>();
  for (const result of results) {
    const current = latest.get(result.provider);
    if (!current || result.runAt > current.runAt)
      latest.set(result.provider, result);
  }
  return [...latest.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

/** Every `*.json` result in a directory; a missing directory has none. */
export async function readResults(dir: string): Promise<ResultFile[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    names.map(
      async (name) =>
        JSON.parse(await readFile(join(dir, name), 'utf8')) as ResultFile,
    ),
  );
}
