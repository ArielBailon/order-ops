import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicyChunks } from './policy-chunks.js';

describe('loadPolicyChunks', () => {
  it('creates one chunk per section with source and section metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policies-'));
    await writeFile(
      join(dir, 'demo.md'),
      '# Demo Policy\n\n## First\n\nAlpha text.\n\n## Second\n\nBeta text.\n',
    );

    const chunks = await loadPolicyChunks(dir);

    expect(chunks.map((c) => c.metadata)).toEqual([
      { source: 'demo', section: 'First' },
      { source: 'demo', section: 'Second' },
    ]);
    expect(chunks[0].pageContent).toBe('Demo Policy: First\nAlpha text.');
  });

  it('splits a long section into several chunks and skips empty sections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policies-'));
    const long = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i}.`,
    ).join(' ');
    await writeFile(
      join(dir, 'long.md'),
      `# Long\n\n## Big\n\n${long}\n\n## Empty\n\n`,
    );

    const chunks = await loadPolicyChunks(dir);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.metadata.section === 'Big')).toBe(true);
    expect(chunks.every((c) => c.pageContent.length > 0)).toBe(true);
  });

  it('loads the shipped policy docs', async () => {
    const dir = fileURLToPath(new URL('../../policies', import.meta.url));
    const chunks = await loadPolicyChunks(dir);

    const sources = new Set(chunks.map((c) => c.metadata.source));
    expect(sources).toEqual(new Set(['returns', 'shipping', 'warranty']));
  });
});
