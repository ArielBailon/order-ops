import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';

export interface PolicyMetadata {
  source: string;
  section: string;
}

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 100,
});

/** One document per `##` section (title kept in the text), further split only when long. */
export async function loadPolicyChunks(
  dir: string,
): Promise<Document<PolicyMetadata>[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  const chunks: Document<PolicyMetadata>[] = [];

  for (const file of files) {
    const source = basename(file, '.md');
    const markdown = await readFile(join(dir, file), 'utf8');
    const [title, ...sections] = markdown.split(/^## /m);
    const heading = title.replace(/^#\s*/, '').trim();

    for (const section of sections) {
      const [name, ...body] = section.split('\n');
      const text = body.join('\n').trim();
      if (!text) continue;
      const pieces = await splitter.splitText(
        `${heading}: ${name.trim()}\n${text}`,
      );
      for (const pageContent of pieces)
        chunks.push(
          new Document({
            pageContent,
            metadata: { source, section: name.trim() },
          }),
        );
    }
  }
  return chunks;
}
