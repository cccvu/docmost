/**
 * #626 — the worker thread that converts untrusted HTML/Markdown.
 *
 * Fork-owned. Runs the SAME conversions the engine always ran (`markdownToHtml`, `htmlToJson`), but off the main
 * thread, so the parent (`content-parse.service.ts`) can bound them: a deadline enforced with `terminate()` (which
 * stops even a synchronous parse), a heap cap (`resourceLimits`), and the node and character caps below. Loaded once and reused:
 * loading the parsers takes ~0.5–1.4 s, too much to pay on every write.
 *
 * Protocol: posts `{ ready: true }` once loaded, then answers each `ParseRequest` with one `ParseReply` carrying the
 * same `id`. Never throws across the boundary: every failure is a reply.
 */
import { parentPort } from 'node:worker_threads';
import { markdownToHtml } from '@docmost/editor-ext';
import { htmlToJson } from '../../collaboration/collaboration.util';

export type ParseFormat = 'html' | 'markdown';

export type ParseRequest =
  /** HTML or Markdown → ProseMirror JSON, as a page write stores it. */
  | { id: number; op: 'to-json'; format: ParseFormat; content: string; maxNodes: number; maxChars: number }
  /** Markdown → HTML only: the importers rewrite the HTML before it is converted to JSON. */
  | { id: number; op: 'markdown-to-html'; content: string; maxChars: number };

export type ParseReply =
  | { id: number; ok: true; result: unknown; nodes?: number }
  | { id: number; ok: false; reason: 'invalid' }
  | { id: number; ok: false; reason: 'too_complex'; detail: 'nodes' | 'chars' | 'depth' };

export type WorkerMessage = { ready: true } | ParseReply;

/** Nodes in a ProseMirror JSON tree, counting no further than `limit + 1`. */
export function countNodes(json: unknown, limit: number): number {
  let count = 0;
  const stack: unknown[] = [json];
  while (stack.length > 0 && count <= limit) {
    const node = stack.pop() as { content?: unknown } | null;
    if (!node || typeof node !== 'object') continue;
    count++;
    // A loop, not `push(...content)`: spreading a 100k-child array overflows the call stack.
    if (Array.isArray(node.content)) for (const child of node.content) stack.push(child);
  }
  return count;
}

/**
 * Characters in every string of a JSON value (text, attribute values, marks), counting no further than `limit + 1`.
 * The node cap does not bound this: a Markdown reference definition or an `<a href>` around many blocks repeats one
 * long string in every node that uses it. In here those copies share one string; the copy back to the main thread,
 * and everything after it (Yjs, the database, the importers' cheerio passes), duplicates each one.
 */
export function countChars(json: unknown, limit: number): number {
  let count = 0;
  const stack: unknown[] = [json];
  while (stack.length > 0 && count <= limit) {
    const value = stack.pop();
    if (typeof value === 'string') count += value.length;
    else if (Array.isArray(value)) for (const item of value) stack.push(item);
    else if (value && typeof value === 'object') for (const key in value) stack.push((value as Record<string, unknown>)[key]);
  }
  return count;
}

async function convert(req: ParseRequest): Promise<ParseReply> {
  try {
    if (req.op === 'markdown-to-html') {
      const html = await markdownToHtml(req.content);
      if (html.length > req.maxChars) return { id: req.id, ok: false, reason: 'too_complex', detail: 'chars' };
      return { id: req.id, ok: true, result: html };
    }
    const html = req.format === 'markdown' ? await markdownToHtml(req.content) : req.content;
    const json = htmlToJson(html as string);
    const nodes = countNodes(json, req.maxNodes);
    if (nodes > req.maxNodes) return { id: req.id, ok: false, reason: 'too_complex', detail: 'nodes' };
    if (countChars(json, req.maxChars) > req.maxChars) return { id: req.id, ok: false, reason: 'too_complex', detail: 'chars' };
    return { id: req.id, ok: true, result: json, nodes };
  } catch (err) {
    // Deep nesting overflows the parsers' recursion: that is the input's complexity, not a malformed document.
    if (err instanceof RangeError && /call stack/i.test(err.message)) {
      return { id: req.id, ok: false, reason: 'too_complex', detail: 'depth' };
    }
    // A string past V8's maximum length: the input expanded beyond any cap before it could be counted.
    if (err instanceof RangeError && /invalid (string|array) length/i.test(err.message)) {
      return { id: req.id, ok: false, reason: 'too_complex', detail: 'chars' };
    }
    return { id: req.id, ok: false, reason: 'invalid' };
  }
}

if (parentPort) {
  const port = parentPort;
  port.on('message', async (req: ParseRequest) => {
    const reply = await convert(req);
    // Let the parse window's asynchronous close() finish before the next job starts.
    await new Promise<void>((resolve) => setImmediate(resolve));
    port.postMessage(reply);
  });
  port.postMessage({ ready: true } satisfies WorkerMessage);
}
