/**
 * #621: converting untrusted HTML or Markdown to ProseMirror JSON must never make the server send a network
 * request.
 *
 * `generateJSON` parses a whole document with happy-dom, so a connected `<iframe src>`, `<link rel=stylesheet>`
 * or `<link rel=preload>` is loaded exactly as a browser would load it. `/v1` page writes, MCP page tools and
 * the importers all reach this parser with content a caller wrote, which made it an SSRF primitive.
 *
 * Two detectors run for every case:
 *   - a real HTTP listener on 127.0.0.1: the proof that bytes left the parser;
 *   - a spy on `http.request`/`https.request` that records every attempt and refuses any target other than
 *     that listener, so no case can reach a real host even if the hardening regresses.
 *
 * A control case shows a default happy-dom window does fetch, so the detectors are not vacuous. A separate block
 * pins the parse and serialize output for ordinary media content, so the hardening is proven to change nothing
 * a page author can see.
 */
import * as childProcess from 'child_process';
import * as http from 'http';
import * as https from 'https';
import type { AddressInfo } from 'net';
import { markdownToHtml } from '@docmost/editor-ext';
import {
  htmlToJson,
  jsonToHtml,
  tiptapExtensions,
} from '../../../../collaboration/collaboration.util';
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { Window } from 'happy-dom';
import BrowserFrameFactory from 'happy-dom/lib/browser/utilities/BrowserFrameFactory.js';
import { createNetworkIsolatedWindow, generateJSON } from './generateJSON';

/** Long enough for a loopback request to land; the parse itself is synchronous. */
const SETTLE_MS = 300;
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

// Shared by every block below, so no case in this file can reach a real host.
let server: http.Server;
let origin: string;
/** Requests the listener actually received, since the last reset. */
const received: string[] = [];
/** Every request the process tried to open, since the last reset (listener or not). */
const attempted: string[] = [];
/** Everything the listener received over the whole file (catches a request that lands late). */
const receivedEver: string[] = [];
const spies: jest.SpyInstance[] = [];

const describeTarget = (args: unknown[]): string => {
  const [first] = args;
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.href;
  const o = (first ?? {}) as Record<string, unknown>;
  return `${o.protocol ?? ''}//${o.hostname ?? o.host ?? ''}:${o.port ?? ''}${o.path ?? ''}`;
};

const guard = (mod: typeof http | typeof https, name: 'request' | 'get') => {
  const original = mod[name] as (...a: unknown[]) => unknown;
  spies.push(
    jest.spyOn(mod, name).mockImplementation(((...args: unknown[]) => {
      const target = describeTarget(args);
      attempted.push(target);
      if (!target.includes(new URL(origin).host)) {
        throw new Error(`#621 test guard: refused a request to ${target}`);
      }
      return original.apply(mod, args);
    }) as never),
  );
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    received.push(`${req.method} ${req.url}`);
    receivedEver.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!DOCTYPE html><html><body>ok</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  guard(http, 'request');
  guard(http, 'get');
  guard(https, 'request');
  guard(https, 'get');
});

afterAll(async () => {
  spies.forEach((s) => s.mockRestore());
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received.length = 0;
  attempted.length = 0;
});

const expectNoEgress = async () => {
  await settle();
  expect({ received, attempted }).toEqual({ received: [], attempted: [] });
};

describe('#621 happy-dom parsing never reaches the network', () => {
  // Each case uses its own path, so a failure names the element that fetched.
  const htmlCases: Array<[string, (o: string) => string]> = [
    ['iframe src', (o) => `<iframe src="${o}/iframe"></iframe>`],
    [
      'youtube iframe (a node the schema keeps)',
      (o) =>
        `<div data-youtube-video><iframe src="${o}/youtube"></iframe></div>`,
    ],
    [
      'iframe srcdoc with nested loaders',
      (o) =>
        `<iframe srcdoc="<link rel='stylesheet' href='${o}/srcdoc-css'><iframe src='${o}/srcdoc-iframe'></iframe><script>fetch('${o}/srcdoc-script')</script>"></iframe>`,
    ],
    ['link rel=stylesheet', (o) => `<link rel="stylesheet" href="${o}/css">`],
    [
      'link rel=preload as=fetch',
      (o) => `<link rel="preload" as="fetch" href="${o}/preload-fetch">`,
    ],
    [
      'link rel=preload as=style',
      (o) => `<link rel="preload" as="style" href="${o}/preload-style">`,
    ],
    [
      'link rel=preload as=script',
      (o) => `<link rel="preload" as="script" href="${o}/preload-script">`,
    ],
    [
      'link rel=modulepreload',
      (o) => `<link rel="modulepreload" href="${o}/modulepreload.js">`,
    ],
    ['script src', (o) => `<script src="${o}/script.js"></script>`],
    [
      'script type=module src',
      (o) => `<script type="module" src="${o}/module.js"></script>`,
    ],
    ['inline script', (o) => `<script>fetch('${o}/inline-script')</script>`],
    [
      'inline event handlers',
      (o) =>
        `<img src="x" onerror="fetch('${o}/onerror')"><svg onload="fetch('${o}/svg-onload')"></svg><body onload="fetch('${o}/body-onload')">`,
    ],
    [
      'img / srcset / picture',
      (o) =>
        `<img src="${o}/img.png" srcset="${o}/img-2x.png 2x"><picture><source srcset="${o}/picture.webp"><img src="${o}/picture.png"></picture>`,
    ],
    [
      'video / audio / source / track',
      (o) =>
        `<video src="${o}/video.mp4" poster="${o}/poster.png"><source src="${o}/source.mp4"><track src="${o}/track.vtt"></video><audio src="${o}/audio.mp3"></audio>`,
    ],
    ['object data', (o) => `<object data="${o}/object"></object>`],
    ['embed src', (o) => `<embed src="${o}/embed">`],
    [
      'meta refresh',
      (o) => `<meta http-equiv="refresh" content="0;url=${o}/refresh">`,
    ],
    [
      'base href + relative loaders',
      (o) =>
        `<base href="${o}/base/"><iframe src="iframe-rel"></iframe><link rel="stylesheet" href="css-rel"><img src="img-rel.png">`,
    ],
    [
      'CSS @import and url()',
      (o) =>
        `<style>@import url("${o}/import.css"); p { background: url("${o}/bg.png") }</style><p style="background-image:url('${o}/inline-bg.png')">x</p>`,
    ],
    [
      'svg image / use',
      (o) =>
        `<svg><image href="${o}/svg-image.png"></image><use href="${o}/svg-use#x"></use></svg>`,
    ],
    [
      'anchor ping / form / input image',
      (o) =>
        `<a href="${o}/a" ping="${o}/ping">x</a><form action="${o}/form"><input type="image" src="${o}/input.png"></form>`,
    ],
    [
      'a whole document (the importers pass one)',
      (o) =>
        `<!DOCTYPE html><html><head><base href="${o}/doc-base/"><link rel="stylesheet" href="${o}/doc-css"><meta http-equiv="refresh" content="0;url=${o}/doc-refresh"></head><body><iframe src="${o}/doc-iframe"></iframe><p>hi</p></body></html>`,
    ],
  ];

  it.each(htmlCases)('HTML: %s', async (_name, build) => {
    expect(() => htmlToJson(build(origin))).not.toThrow();
    await expectNoEgress();
  });

  it('Markdown: raw HTML and images pass through marked to the parser without a fetch', async () => {
    const md = [
      '# Title',
      '',
      `![img](${origin}/md-img.png)`,
      '',
      `<iframe src="${origin}/md-iframe"></iframe>`,
      '',
      `<link rel="stylesheet" href="${origin}/md-css">`,
      '',
      `<link rel="preload" as="fetch" href="${origin}/md-preload">`,
    ].join('\n');
    const html = await markdownToHtml(md);
    // The markdown path really does hand these elements to the parser.
    expect(html).toContain(`<iframe src="${origin}/md-iframe">`);
    expect(() => htmlToJson(html)).not.toThrow();
    await expectNoEgress();
  });

  it('serializing stored JSON back to HTML fetches nothing', async () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'youtube', attrs: { src: `${origin}/ser-youtube` } },
        { type: 'image', attrs: { src: `${origin}/ser-image.png` } },
        { type: 'video', attrs: { src: `${origin}/ser-video.mp4` } },
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      ],
    };
    expect(() => jsonToHtml(doc)).not.toThrow();
    await expectNoEgress();
  });
});

describe('#621 the parse window refuses requests at its fetch layer', () => {
  // The loaders are switched off above. This proves the layer under them refuses as well, so a loader a later
  // happy-dom adds or turns back on still cannot reach the network.

  it('control: a default happy-dom window loads what it parses (the detectors work)', async () => {
    // The pre-#621 setup, left open so the loads are not raced by teardown.
    const w = new Window();
    try {
      new w.DOMParser().parseFromString(
        `<!DOCTYPE html><html><body><iframe src="${origin}/control-iframe"></iframe><link rel="stylesheet" href="${origin}/control-css"></body></html>`,
        'text/html',
      );
      await settle();
    } finally {
      await w.happyDOM.close();
    }
    expect([...received].sort()).toEqual([
      'GET /control-css',
      'GET /control-iframe',
    ]);
    receivedEver.length = 0; // the control's requests are the only ones this file expects
  });

  it('an async fetch resolves to a network error without a request', async () => {
    const w = createNetworkIsolatedWindow();
    try {
      const res = await w.fetch(`${origin}/isolated-fetch`);
      expect({ type: res.type, ok: res.ok, status: res.status }).toEqual({
        type: 'error',
        ok: false,
        status: 0,
      });
    } finally {
      await w.happyDOM.close();
    }
    await expectNoEgress();
  });

  it('a synchronous request is refused before happy-dom spawns its request process', async () => {
    // happy-dom sends a synchronous request from a child process while this one blocks, so a regression here
    // would deadlock against the in-process listener instead of failing. The spy fails it fast instead.
    const spawn = jest
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation(() => {
        throw new Error(
          '#621 test guard: refused a synchronous request process',
        );
      });
    const w = createNetworkIsolatedWindow();
    try {
      const xhr = new w.XMLHttpRequest();
      const errors: string[] = [];
      xhr.addEventListener('error', (e: any) => errors.push(e.error?.message));
      xhr.open('GET', `${origin}/isolated-sync-xhr`, false);
      xhr.send();
      // Refused by our interceptor, not by happy-dom's same-origin check or the guard above.
      expect(errors).toEqual([
        `Network access is disabled for HTML parsing: ${origin}/isolated-sync-xhr`,
      ]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
      await w.happyDOM.close();
    }
    await expectNoEgress();
  });
});

describe('#621 the hardening leaves ordinary content unchanged', () => {
  // Real-looking hosts. The file-level guard refuses them, and after the fix nothing asks for them.
  const SAMPLE = [
    '<h2>Media</h2>',
    '<p>Intro <a href="https://example.com/page">link</a> text.</p>',
    '<img src="https://example.com/files/pic.png" alt="A picture" width="320" height="200">',
    '<div data-youtube-video><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5" width="640" height="480"></iframe></div>',
    '<video src="https://example.com/files/clip.mp4"></video>',
    '<div data-type="embed" data-src="https://www.figma.com/file/abc" data-provider="figma"></div>',
    '<iframe src="https://example.com/bare-iframe"></iframe>',
    '<embed src="https://example.com/files/doc.pdf">',
    '<object data="https://example.com/files/obj"></object>',
    '<p>End</p>',
  ].join('');

  it('generateJSON output matches the pre-fix output, with no request', async () => {
    expect(generateJSON(SAMPLE, tiptapExtensions)).toEqual(EXPECTED_JSON);
    await expectNoEgress();
  });

  it('serializing that JSON matches the pre-fix HTML', () => {
    expect(jsonToHtml(EXPECTED_JSON)).toEqual(EXPECTED_HTML);
  });
});

/**
 * #626: before, the parse ran in a DOMParser document, where every connected `<iframe srcdoc>` made happy-dom build a
 * child window and `document.write()` the srcdoc into it (~0.3 ms of blocking CPU per iframe, with no setting to
 * turn it off). `generateJSON` now parses into a detached `<html>` element: happy-dom runs the same
 * document-structure parser, but nothing is connected, so nothing is loaded or built.
 */
describe('#626 the parse builds no child window', () => {
  let createChildFrame: jest.SpyInstance;
  beforeEach(() => {
    createChildFrame = jest.spyOn(BrowserFrameFactory, 'createChildFrame');
  });
  afterEach(() => createChildFrame.mockRestore());

  const SRCDOC = `<p>a</p><iframe srcdoc="<p>inner</p><iframe srcdoc='<p>deeper</p>'></iframe>"></iframe><iframe srcdoc="x"></iframe><p>b</p>`;

  it('control: a DOMParser document of the same HTML does build child windows (the spy works)', async () => {
    const w = createNetworkIsolatedWindow();
    try {
      new w.DOMParser().parseFromString(`<!DOCTYPE html><html><body>${SRCDOC}</body></html>`, 'text/html');
      expect(createChildFrame).toHaveBeenCalled();
    } finally {
      await w.happyDOM.close();
    }
  });

  it('generateJSON builds none, and keeps the content around the iframes', () => {
    const json = generateJSON(SRCDOC, tiptapExtensions);
    expect(createChildFrame).not.toHaveBeenCalled();
    expect(JSON.stringify(json)).toContain('"text":"a"');
    expect(JSON.stringify(json)).toContain('"text":"b"');
    expect(JSON.stringify(json)).not.toContain('inner');
  });
});

describe('#626 the detached parse gives the same output as the document parse it replaced', () => {
  /** The pre-#626 parse, kept here as the oracle. */
  const documentParse = async (html: string) => {
    const w = createNetworkIsolatedWindow();
    try {
      const doc = new w.DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
      return PMDOMParser.fromSchema(getSchema(tiptapExtensions)).parse(doc.body as unknown as Node).toJSON();
    } finally {
      await w.happyDOM.close();
    }
  };
  const same = async (html: string) => {
    let expected: unknown;
    try {
      expected = await documentParse(html);
    } catch {
      return; // the old parse threw on this input; there is no output to preserve
    }
    expect({ html, json: generateJSON(html, tiptapExtensions) }).toEqual({ html, json: expected });
    // Let each window's asynchronous close() finish before the next parse (many windows at once exhaust the heap).
    await new Promise((r) => setImmediate(r));
  };

  const TRICKY = [
    '<!DOCTYPE html><html><head><title>T</title><meta charset="utf-8"><style>p{}</style></head><body class="b"><h1>Hi</h1><p>x</p></body></html>',
    '<html><body><p>a</p></body></html><p>after</p>',
    'text before<html><head></head><body>in body</body></html>text after',
    '<head><title>only head</title></head><p>p</p>',
    '<p>a</p><body><p>b</p></body><p>c</p>',
    '<tr><td>stray</td></tr>',
    '<td>a</td><td>b</td>',
    '<table><td>no tr</td></table>',
    '<table><div>moved</div><tr><td>x</td></tr></table>',
    '<li>stray li</li><ul><li>a<li>b</ul>',
    '<p>a<p>b<a href=x>1<a href=y>2</a></a><b><p>mis</b>nest</p>',
    '<!-- c --><p>x</p><!--x',
    '<!DOCTYPE html><p>x</p><!DOCTYPE html><p>y</p>',
    '<p>&amp;&lt;&nbsp;&#x1F600;&bogus;</p>',
    '<svg><circle r=1></circle></svg><script>alert(1)</script><template><p>t</p></template><p>x</p>',
    '<pre><code class="language-js">const a = 1;\n</code></pre><p>line<br>break</p>',
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>t</p></li></ul>',
    '<details><summary>s</summary><div>d</div></details><div data-type="callout" data-callout-type="info"><p>c</p></div>',
    '<p style="text-align:center;color:red"><span style="color:#f00">c</span></p>',
    '',
    'plain text only',
    '<base href="https://example.com/"><a href="rel">r</a><p>unclosed <b>bold <i>it</p><p>next</p>',
  ];

  it.each(TRICKY.map((h) => [h]))('%j', async (html) => {
    await same(html);
  });

  it('Markdown output (tables, code, task lists, raw HTML) parses the same', async () => {
    const md = [
      '# T',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | **2** |',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '> quote with [link](https://example.com)',
      '',
      '<div data-type="callout"><p>raw</p></div>',
    ].join('\n');
    await same(await markdownToHtml(md));
  });

  it('300 seeded tag-soup documents (no <template>) parse the same', async () => {
    // <template> is left out: in malformed soup its content can differ, and there the old parse sometimes threw.
    const TAGS = ['p', 'div', 'span', 'b', 'i', 'a', 'h1', 'h2', 'ul', 'ol', 'li', 'table', 'tbody', 'tr', 'td', 'th',
      'blockquote', 'pre', 'code', 'br', 'hr', 'img', 'iframe', 'video', 'html', 'head', 'body', 'title', 'style',
      'script', 'svg', 'details', 'summary', 'form', 'input', 'sup', 'sub', 'mark', 'figure', 'dl', 'dt', 'dd'];
    const ATTRS = ['', ' class="c"', ' href="https://example.com/x"', ' src="a.png"', ' srcdoc="<p>i</p>"',
      ' style="color:red"', ' data-type="taskList"', ' data-type="callout"', ' data-youtube-video', ' colspan=2', " title='t>'"];
    const TEXT = ['x', 'hello world', '&amp;', '&lt;', ' ', '\n', '<', '>', '"', '<!--c-->', '<!--', '-->', '<!DOCTYPE html>', '</', '/>'];
    let seed = 626;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const gen = (depth = 0): string => {
      let s = '';
      for (let i = 1 + rnd(6); i > 0; i--) {
        if (rnd(10) < 3 || depth > 5) {
          s += TEXT[rnd(TEXT.length)];
          continue;
        }
        const t = TAGS[rnd(TAGS.length)];
        s += `<${t}${ATTRS[rnd(ATTRS.length)]}>${gen(depth + 1)}`;
        if (rnd(5) !== 0) s += `</${rnd(5) === 0 ? TAGS[rnd(TAGS.length)] : t}>`;
      }
      return s;
    };
    for (let i = 0; i < 300; i++) await same(gen());
  }, 60_000);
});

// Last in the file on purpose: a request that lands after its own test's wait still fails the file.
describe('#621 late arrivals', () => {
  it('no request reached the listener at any point (apart from the control)', async () => {
    await settle();
    expect(receivedEver).toEqual([]);
  });
});

// Captured from the unmodified generateJSON/getHTMLFromFragment (before #621) and pinned here.
const EXPECTED_JSON: Record<string, any> = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: {
        id: null,
        indent: 0,
        textAlign: null,
        level: 2,
      },
      content: [
        {
          type: 'text',
          text: 'Media',
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: {
        id: null,
        indent: 0,
        textAlign: null,
      },
      content: [
        {
          type: 'text',
          text: 'Intro ',
        },
        {
          type: 'text',
          marks: [
            {
              type: 'link',
              attrs: {
                href: 'https://example.com/page',
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: null,
                title: null,
                internal: false,
              },
            },
          ],
          text: 'link',
        },
        {
          type: 'text',
          text: ' text.',
        },
      ],
    },
    {
      type: 'image',
      attrs: {
        src: 'https://example.com/files/pic.png',
        width: 320,
        height: 200,
        align: 'center',
        alt: 'A picture',
        size: null,
        aspectRatio: null,
        placeholder: null,
      },
    },
    {
      type: 'youtube',
      attrs: {
        src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        start: 5,
        width: 640,
        height: 480,
      },
    },
    {
      type: 'video',
      attrs: {
        src: 'https://example.com/files/clip.mp4',
        width: null,
        height: null,
        size: null,
        align: 'center',
        aspectRatio: null,
        placeholder: null,
      },
    },
    {
      type: 'embed',
      attrs: {
        src: 'https://www.figma.com/file/abc',
        provider: 'figma',
        align: 'center',
        width: 800,
        height: 600,
      },
    },
    {
      type: 'paragraph',
      attrs: {
        id: null,
        indent: 0,
        textAlign: null,
      },
      content: [
        {
          type: 'text',
          text: 'End',
        },
      ],
    },
  ],
};

const EXPECTED_HTML = [
  '<h2 xmlns="http://www.w3.org/1999/xhtml">Media</h2>',
  '<p xmlns="http://www.w3.org/1999/xhtml">Intro <a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/page">link</a> text.</p>',
  '<img xmlns="http://www.w3.org/1999/xhtml" src="https://example.com/files/pic.png" width="320" height="200" data-align="center" alt="A picture" />',
  '<div xmlns="http://www.w3.org/1999/xhtml" data-youtube-video=""><iframe width="640" height="480" allowfullscreen="true" autoplay="false" disablekbcontrols="false" enableiframeapi="false" endtime="0" ivloadpolicy="0" loop="false" modestbranding="false" origin="" playlist="" rel="1" src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=5&amp;rel=1" start="5"></iframe></div>',
  '<video xmlns="http://www.w3.org/1999/xhtml" controls="true" src="https://example.com/files/clip.mp4" data-align="center"><source src="https://example.com/files/clip.mp4" data-align="center" /></video>',
  '<div xmlns="http://www.w3.org/1999/xhtml" data-type="embed" data-src="https://www.figma.com/file/abc" data-provider="figma" data-align="center" data-width="800" data-height="600"><a href="https://www.figma.com/file/abc" target="blank">https://www.figma.com/file/abc</a></div>',
  '<p xmlns="http://www.w3.org/1999/xhtml">End</p>',
].join('');
