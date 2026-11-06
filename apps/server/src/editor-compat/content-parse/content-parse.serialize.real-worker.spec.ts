/**
 * #716 — the REAL conversion worker serializes a stored page for the export: its output is exactly the in-process
 * composition (upstream's), and the main thread stays free while a ~1 MiB page serializes. Prints the timings (WS5
 * step 0's in-worker leg). Gated (src/editor-compat).
 */
import { htmlToMarkdown } from '@docmost/editor-ext';
import { jsonToHtml } from '../../collaboration/collaboration.util';
import {
  CONTENT_PARSE_LIMITS,
  ContentParsePool,
  ContentTooComplexException,
  spawnContentParseWorker,
} from './content-parse.service';
import { serializeForExport } from './content-parse.worker';

const STARTUP_MS = 90_000; // ts-node compiles the collaboration graph when a worker starts
jest.setTimeout(180_000);

const pool = new ContentParsePool({ ...CONTENT_PARSE_LIMITS, startupMs: STARTUP_MS }, spawnContentParseWorker);
afterAll(() => pool.close());
const queue = { principal: 'user:serialize-spec', budgetKey: 'user:serialize-spec:export' };

/** A deterministic realistic page (paragraphs with marks and links, headings, lists, tables with column widths). */
function realisticDoc(blocks: number, seed = 7): { type: string; content: unknown[] } {
  const words = 'the of and to in is that for it as was with be by on not this are or from at which but have an'.split(' ');
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const text = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ');
  const para = () => ({
    type: 'paragraph',
    content: [
      { type: 'text', text: text(12) + ' ' },
      { type: 'text', text: text(2), marks: [{ type: 'bold' }] },
      { type: 'text', text: ' ' + text(6), marks: rnd() < 0.3 ? [{ type: 'link', attrs: { href: `https://e.org/${text(1)}` } }] : [] },
    ],
  });
  const content: unknown[] = [];
  for (let i = 0; i < blocks; i++) {
    const r = rnd();
    if (r < 0.6) content.push(para());
    else if (r < 0.75) content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: text(4) }] });
    else if (r < 0.9) content.push({ type: 'bulletList', content: [1, 2, 3].map(() => ({ type: 'listItem', content: [para()] })) });
    else
      content.push({
        type: 'table',
        content: [1, 2].map(() => ({
          type: 'tableRow',
          content: [1, 2, 3].map(() => ({ type: 'tableCell', attrs: { colwidth: [100] }, content: [para()] })),
        })),
      });
  }
  return { type: 'doc', content };
}

const maxLoopLag = async (work: Promise<unknown>): Promise<number> => {
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    await work;
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    clearInterval(tick);
  }
  return worst;
};

describe('serialize in the real worker (#716)', () => {
  it('is byte-identical to the in-process composition, which is upstream’s (colgroup strip, then Turndown)', async () => {
    for (const seed of [1, 2]) {
      const doc = realisticDoc(120, seed);
      const html = jsonToHtml(doc);
      expect(html).toMatch(/<colgroup/);
      await expect(pool.serialize(doc, 'html', queue)).resolves.toBe(html);
      const md = await pool.serialize(doc, 'markdown', queue);
      expect(md).toBe(serializeForExport(doc, 'markdown', CONTENT_PARSE_LIMITS.maxChars));
      expect(md).toBe(htmlToMarkdown(html.replace(/<colgroup[^>]*>[\s\S]*?<\/colgroup>/gim, '')));
    }
  });

  it('caps the output with an O(1) length check (422 in the pool), before and after Turndown', async () => {
    const doc = realisticDoc(40, 3);
    const html = jsonToHtml(doc);
    expect(serializeForExport(doc, 'html', html.length)).toBe(html);
    expect(serializeForExport(doc, 'html', html.length - 1)).toBeNull();
    expect(serializeForExport(doc, 'markdown', html.length - 1)).toBeNull(); // refused before Turndown runs
    const md = serializeForExport(doc, 'markdown', html.length) as string;
    expect(md.length).toBeLessThan(html.length);
    // Markdown can be LONGER than its HTML (escaping): the cap is checked again after Turndown.
    const stars = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '*'.repeat(1_000) }] }] };
    const starsHtml = jsonToHtml(stars);
    const starsMd = serializeForExport(stars, 'markdown', 10_000) as string;
    expect(starsMd.length).toBeGreaterThan(starsHtml.length);
    expect(serializeForExport(stars, 'html', starsHtml.length)).toBe(starsHtml);
    expect(serializeForExport(stars, 'markdown', starsHtml.length)).toBeNull();
    const small = new ContentParsePool({ ...CONTENT_PARSE_LIMITS, startupMs: STARTUP_MS, maxChars: 100 }, spawnContentParseWorker);
    try {
      await expect(small.serialize(doc, 'html', queue)).rejects.toBeInstanceOf(ContentTooComplexException);
    } finally {
      await small.close();
    }
  });

  it('leaves the main thread free while a ~1 MiB page serializes to Markdown (timings printed)', async () => {
    await pool.serialize(realisticDoc(5), 'html', queue); // warm: the worker's load is not the measurement
    const doc = realisticDoc(4_000, 11);
    const jsonBytes = Buffer.byteLength(JSON.stringify(doc));
    const t0 = Date.now();
    let out = '';
    const lag = await maxLoopLag(pool.serialize(doc, 'markdown', queue).then((md) => (out = md)));
    const ms = Date.now() - t0;
    const t1 = Date.now();
    await pool.serialize(doc, 'html', queue);
    const htmlMs = Date.now() - t1;
    console.log(
      `#716 serialize (real worker): ${(jsonBytes / 1048576).toFixed(2)} MiB JSON → markdown ${ms} ms, html ${htmlMs} ms; ` +
        `main-thread max lag ${lag} ms`,
    );
    expect(out.length).toBeGreaterThan(300_000);
    expect(lag).toBeLessThan(250); // the structured clone is the only main-thread share (~20 ms per 2.7 MB)
  });
});
