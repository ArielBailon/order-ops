export type Inline = { type: 'text' | 'strong' | 'code'; text: string };

export type Block =
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'heading'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] };

const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const HEADING = /^#{1,3}\s+(.*)$/;
// Never spans a line, so an unclosed marker (common while a reply streams in) stays literal.
const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`/g;

/**
 * Parses the small markdown subset the agent writes (paragraphs, lists, headings, bold, inline
 * code) into blocks of plain strings. Everything else, HTML included, stays text: the caller
 * renders the strings as React text, so nothing in a reply is ever interpreted as markup.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Extract<Block, { type: 'list' }> | null = null;

  const flush = () => {
    if (paragraph.length)
      blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join('\n')) });
    if (list) blocks.push(list);
    paragraph = [];
    list = null;
  };

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const heading = HEADING.exec(line);
    if (!line.trim()) {
      flush();
    } else if (heading) {
      flush();
      blocks.push({ type: 'heading', inlines: parseInline(heading[1]) });
    } else if (bullet || numbered) {
      const ordered = numbered !== null;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { type: 'list', ordered, start: numbered ? Number(numbered[1]) : 1, items: [] };
      }
      list.items.push(parseInline(bullet?.[1] ?? numbered?.[2] ?? ''));
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

function parseInline(text: string): Inline[] {
  const inlines: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) inlines.push({ type: 'text', text: text.slice(last, match.index) });
    inlines.push(
      match[1] !== undefined
        ? { type: 'strong', text: match[1] }
        : { type: 'code', text: match[2] },
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) inlines.push({ type: 'text', text: text.slice(last) });
  return inlines;
}
