import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';

const text = (value: string) => ({ type: 'text', text: value });
const strong = (value: string) => ({ type: 'strong', text: value });

describe('parseMarkdown', () => {
  it('returns no blocks for an empty reply', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });

  it('keeps plain text as one paragraph', () => {
    expect(parseMarkdown('Your order has shipped.')).toEqual([
      { type: 'paragraph', inlines: [text('Your order has shipped.')] },
    ]);
  });

  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('First line\nsame paragraph\n\nSecond')).toEqual([
      { type: 'paragraph', inlines: [text('First line\nsame paragraph')] },
      { type: 'paragraph', inlines: [text('Second')] },
    ]);
  });

  it('parses - and * bullets into one list with bold labels', () => {
    expect(
      parseMarkdown("Here's a summary:\n\n- **Return window:** 30 days\n* **Refunds:** 5 days"),
    ).toEqual([
      { type: 'paragraph', inlines: [text("Here's a summary:")] },
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [
          [strong('Return window:'), text(' 30 days')],
          [strong('Refunds:'), text(' 5 days')],
        ],
      },
    ]);
  });

  it('parses numbered lists and keeps the first number', () => {
    expect(parseMarkdown('3. Pack it\n4. Ship it')).toEqual([
      { type: 'list', ordered: true, start: 3, items: [[text('Pack it')], [text('Ship it')]] },
    ]);
  });

  it('ends a list at the next plain line', () => {
    expect(parseMarkdown('- one\nLet me know.')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [[text('one')]] },
      { type: 'paragraph', inlines: [text('Let me know.')] },
    ]);
  });

  it('shows headings as their own block', () => {
    expect(parseMarkdown('### Order ORD-1002\nShipped')).toEqual([
      { type: 'heading', inlines: [text('Order ORD-1002')] },
      { type: 'paragraph', inlines: [text('Shipped')] },
    ]);
  });

  it('parses inline code inside a list item', () => {
    expect(parseMarkdown('- id `ref_123` is **pending**')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [[text('id '), { type: 'code', text: 'ref_123' }, text(' is '), strong('pending')]],
      },
    ]);
  });

  it('leaves an unclosed ** or backtick as literal text (mid-stream)', () => {
    expect(parseMarkdown('- **Return win')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [[text('**Return win')]] },
    ]);
    expect(parseMarkdown('use `ref_')).toEqual([
      { type: 'paragraph', inlines: [text('use `ref_')] },
    ]);
  });

  it('keeps HTML and links as plain text', () => {
    expect(parseMarkdown('<b>hi</b> <script>alert(1)</script>')).toEqual([
      { type: 'paragraph', inlines: [text('<b>hi</b> <script>alert(1)</script>')] },
    ]);
    expect(parseMarkdown('[link](http://x)')).toEqual([
      { type: 'paragraph', inlines: [text('[link](http://x)')] },
    ]);
  });
});
