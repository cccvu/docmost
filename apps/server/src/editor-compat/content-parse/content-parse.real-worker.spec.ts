/**
 * #626: the REAL conversion worker (the parsers, loaded through ts-node from `src`, as `dist` would load the compiled
 * file). Its output must be exactly what the in-process conversion gives, and what used to block the event loop
 * for seconds must now leave it free.
 *
 * Run in CI via the `docmost-authz` job's jest glob (`… src/editor-compat …`).
 */
import { markdownToHtml } from '@docmost/editor-ext';
import { htmlToJson } from '../../collaboration/collaboration.util';
import {
  CONTENT_PARSE_LIMITS,
  closeContentParser,
  ContentParsePool,
  ContentTooComplexException,
  parseUntrustedContent,
  spawnContentParseWorker,
  untrustedMarkdownToHtml,
  type ContentParseLimits,
} from './content-parse.service';

// ts-node compiles the collaboration graph when a worker starts; allow for a slow CI runner.
const STARTUP_MS = 90_000;
jest.setTimeout(180_000);

const pools: ContentParsePool[] = [];
const pool = (limits: Partial<ContentParseLimits>) => {
  const p = new ContentParsePool({ ...CONTENT_PARSE_LIMITS, startupMs: STARTUP_MS, ...limits }, spawnContentParseWorker);
  pools.push(p);
  return p;
};
afterAll(async () => {
  await Promise.all([closeContentParser(), ...pools.map((p) => p.close())]);
});

/** Unique ids are random per conversion; compare everything else. */
const withoutIds = (json: unknown): unknown =>
  JSON.parse(JSON.stringify(json), (key, value) => (key === 'id' && typeof value === 'string' ? undefined : value));

/** The largest gap between main-thread timer ticks while `work` runs. */
const maxLoopLag = async (work: () => unknown): Promise<number> => {
  let last = Date.now();
  let worst = 0;
  const tick = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);
  try {
    await Promise.resolve().then(work).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30)); // let a tick land after synchronous work
  } finally {
    clearInterval(tick);
  }
  return worst;
};

const HTML = [
  '<h2>Media</h2>',
  '<p>Intro <a href="https://example.com/page">link</a> and <b>bold</b> <i>italic</i> <code>code</code>.</p>',
  '<img src="https://example.com/files/pic.png" alt="A picture" width="320" height="200">',
  '<ul><li><p>one</p><ul><li><p>nested</p></li></ul></li></ul>',
  '<table><tr><th><p>h</p></th></tr><tr><td><p>c</p></td></tr></table>',
  '<div data-type="callout" data-callout-type="info"><p>callout</p></div>',
  '<iframe srcdoc="<p>not content</p>"></iframe>',
  '<pre><code class="language-ts">const a = 1;</code></pre>',
].join('');

const MARKDOWN = ['# Title', '', 'Some *text* and a [link](https://example.com).', '', '- [x] done', '- [ ] todo', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '```js', 'x()', '```'].join('\n');

describe('#626 the real worker converts exactly as the in-process path did', () => {
  it('HTML → JSON', async () => {
    const json = await parseUntrustedContent(HTML, 'html');
    expect(withoutIds(json)).toEqual(withoutIds(htmlToJson(HTML)));
    expect(JSON.stringify(json)).toContain('"id":'); // unique ids are still assigned
  });

  it('Markdown → JSON', async () => {
    const json = await parseUntrustedContent(MARKDOWN, 'markdown');
    expect(withoutIds(json)).toEqual(withoutIds(htmlToJson(await markdownToHtml(MARKDOWN))));
  });

  it('Markdown → HTML (the importers)', async () => {
    await expect(untrustedMarkdownToHtml(MARKDOWN)).resolves.toBe(await markdownToHtml(MARKDOWN));
  });

  it('an <iframe srcdoc> bomb converts quickly and yields none of the srcdoc content', async () => {
    const bomb = '<p>before</p>' + '<iframe srcdoc="<p>inner</p>"></iframe>'.repeat(2_000) + '<p>after</p>';
    const json = JSON.stringify(await parseUntrustedContent(bomb, 'html'));
    expect(json).toContain('"text":"before"');
    expect(json).toContain('"text":"after"');
    expect(json).not.toContain('inner');
  });
});

describe('#626 the real worker enforces the bounds', () => {
  it('more nodes than the cap → 422', async () => {
    const small = pool({ maxNodes: 500 });
    await expect(small.parse('<p>x</p>'.repeat(1_000), 'html', 'user:A')).rejects.toBeInstanceOf(ContentTooComplexException);
    await expect(small.parse('<p>x</p>'.repeat(10), 'html', 'user:A')).resolves.toMatchObject({ type: 'doc' });
  });

  it.each([
    ['HTML nested 30,000 deep', '<div>'.repeat(30_000) + 'x', 'html'],
    ['Markdown quotes nested 5,000 deep', '> '.repeat(5_000) + 'x', 'markdown'],
  ] as const)('%s → 422 at once (it used to be a 500 from a stack overflow)', async (_name, content, format) => {
    const started = Date.now();
    await expect(parseUntrustedContent(content, format)).rejects.toBeInstanceOf(ContentTooComplexException);
    // A stack overflow, not the deadline: the worker's stack matches the main thread's.
    expect(Date.now() - started).toBeLessThan(CONTENT_PARSE_LIMITS.deadlineMs);
  });

  it('a payload that blocked the event loop for seconds now leaves it free, and is refused at the deadline', async () => {
    // Control: the in-process parse of a tenth of the payload blocks the event loop for over a second.
    const control = '<p>' + '<span></span>'.repeat(5_000) + '</p>';
    expect(await maxLoopLag(() => htmlToJson(control))).toBeGreaterThan(1_000);

    const quick = pool({ deadlineMs: 3_000 });
    await quick.parse('<p>warm</p>', 'html', 'user:A'); // load the parsers first, so the deadline is the parse's
    const payload = '<p>' + '<span></span>'.repeat(50_000) + '</p>'; // ~650 KB; ~15 s to parse in-process
    let outcome: unknown;
    const lag = await maxLoopLag(() =>
      quick.parse(payload, 'html', 'user:A').catch((e) => {
        outcome = e;
      }),
    );
    expect(outcome).toBeInstanceOf(ContentTooComplexException);
    expect(lag).toBeLessThan(250);
  });
});
