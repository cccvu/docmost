import { EventEmitter } from 'node:events';
import { HttpException, InternalServerErrorException, Logger } from '@nestjs/common';

/** #716 — one export's build scope and its page serializations. Fork-owned; gated (src/editor-compat). */

const serialize = jest.fn();
jest.mock('../content-parse/content-parse.service', () => {
  const actual = jest.requireActual('../content-parse/content-parse.service');
  return { ...actual, serializePageContent: (...a: unknown[]) => serialize(...a) };
});

import {
  ContentParseBusyException,
  ContentTooComplexException,
  ConversionBudgetExhaustedException,
} from '../content-parse/content-parse.service';
import {
  ExportCancelledException,
  exportBuildMsLeft,
  renderExportPage,
  throwIfExportBuildStopped,
  withExportConversion,
} from './export-conversion';
import { ExportBuildTimeoutException, ExportTooLargeException } from './export-limits';

const DOC = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] };
const ZIP = { label: 'page:root', userId: 'u1', zip: true };
const ONE = { label: 'page:root', userId: 'u1', zip: false };

/** A clock the test moves. */
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

beforeEach(() => {
  serialize.mockReset().mockImplementation(async (_json: unknown, format: string) => `<${format}>`);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('withExportConversion (#716)', () => {
  it('fails closed without a human: 500, and nothing runs', async () => {
    const fn = jest.fn(async () => 'ran');
    for (const userId of [undefined, null, '']) {
      await expect(withExportConversion({ ...ZIP, userId }, fn, { socket: null })).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    }
    expect(fn).not.toHaveBeenCalled();
  });

  it('a zip takes ONE batch turn for all its pages: the human’s turn, their own :export budget key', async () => {
    await withExportConversion(ZIP, async () => {
      await renderExportPage(DOC, 'markdown', 'A');
      await renderExportPage(DOC, 'markdown', 'B');
      await renderExportPage(DOC, 'html', 'C');
    }, { socket: null });
    const queues = serialize.mock.calls.map((c) => c[2]);
    expect(queues).toHaveLength(3);
    for (const q of queues) {
      expect(q).toMatchObject({ principal: 'user:u1', budgetKey: 'user:u1:export', batch: true });
      expect(q.waitMs).toBeLessThanOrEqual(8_000); // the interactive wait, never the 60 s batch wait
    }
    // One budget turn shared by every page: gated once, then charged (and bounded by the I3 overdraft).
    expect(new Set(queues.map((q) => q.budgetTurn)).size).toBe(1);
  });

  it('a single page is interactive (no batch turn), still on the :export key', async () => {
    await withExportConversion(ONE, () => renderExportPage(DOC, 'markdown', 'A'), { socket: null });
    const q = serialize.mock.calls[0][2];
    expect(q).toMatchObject({ principal: 'user:u1', budgetKey: 'user:u1:export' });
    expect(q.batch).toBeUndefined();
  });

  it('cuts each page’s wait to the build time left, and stops at the deadline (503 export_timeout)', async () => {
    const c = clock();
    const err = await withExportConversion(
      ZIP,
      async () => {
        await renderExportPage(DOC, 'markdown', 'A');
        c.advance(40_000);
        expect(exportBuildMsLeft()).toBe(5_000);
        await renderExportPage(DOC, 'markdown', 'B');
        c.advance(5_000);
        await renderExportPage(DOC, 'markdown', 'C'); // past the deadline: never serialized
      },
      { buildMs: 45_000, now: c.now, socket: null },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ExportBuildTimeoutException);
    expect((err as HttpException).getStatus()).toBe(503);
    expect(serialize.mock.calls.map((x) => x[2].waitMs)).toEqual([8_000, 5_000]);
  });

  it('#716 review: the deadline runs from the export\'s start (startedAt), so the work before the build counts', async () => {
    const c = clock();
    const startedAt = c.now();
    c.advance(30_000); // the subtree read, the PDP filter and the content load took 30 s before the build began
    const waits: number[] = [];
    serialize.mockImplementation(async (_j: unknown, f: string, q: { waitMs: number }) => (waits.push(q.waitMs), `<${f}>`));
    await withExportConversion({ ...ZIP, startedAt }, async () => {
      expect(exportBuildMsLeft()).toBe(15_000);
      await renderExportPage(DOC, 'html', 'A');
      c.advance(15_000);
      await renderExportPage(DOC, 'html', 'B'); // the 45 s are up: never serialized
    }, { now: c.now, socket: null }).then(
      () => {
        throw new Error('expected export_timeout');
      },
      (e) => expect(e).toBeInstanceOf(ExportBuildTimeoutException),
    );
    expect(waits).toEqual([8_000]);
  });

  it('#716 review: a single-page export has its own 9 s build (it is relayed inside the 20 s content-write timeout)', async () => {
    const c = clock();
    const startedAt = c.now();
    await withExportConversion({ ...ONE, startedAt }, async () => {
      expect(exportBuildMsLeft()).toBe(9_000);
      c.advance(4_000);
      await renderExportPage(DOC, 'markdown', 'A');
    }, { now: c.now, socket: null });
    expect(serialize.mock.calls[0][2].waitMs).toBe(5_000); // the wait is cut to what is left of the 9 s
    await withExportConversion(ZIP, async () => expect(exportBuildMsLeft()).toBe(45_000), { now: c.now, socket: null });
  });

  it('a turn missed because the build ran out of time is the build’s timeout, not engine_busy', async () => {
    const c = clock();
    serialize.mockImplementationOnce(async () => {
      c.advance(45_000);
      throw new ContentParseBusyException();
    });
    const err = await withExportConversion(ZIP, () => renderExportPage(DOC, 'html', 'A'), {
      buildMs: 45_000,
      now: c.now,
      socket: null,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ExportBuildTimeoutException);
  });

  it('stops at the next page once the client has gone, and leaves no listener on the socket', async () => {
    const socket = Object.assign(new EventEmitter(), { destroyed: false });
    const err = await withExportConversion(
      ZIP,
      async () => {
        await renderExportPage(DOC, 'html', 'A');
        socket.emit('close');
        await renderExportPage(DOC, 'html', 'B');
      },
      { socket: socket as never },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ExportCancelledException);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(socket.listenerCount('close')).toBe(0);

    const kept = Object.assign(new EventEmitter(), { destroyed: false }); // a keep-alive socket that stays open
    await withExportConversion(ZIP, () => renderExportPage(DOC, 'html', 'A'), { socket: kept as never });
    expect(kept.listenerCount('close')).toBe(0);

    const gone = Object.assign(new EventEmitter(), { destroyed: true }); // already closed when the build starts
    await expect(
      withExportConversion(ZIP, () => renderExportPage(DOC, 'html', 'A'), { socket: gone as never }),
    ).rejects.toBeInstanceOf(ExportCancelledException);
  });

  it('outside a build, the checks are no-ops (an attachment plan used alone)', () => {
    expect(() => throwIfExportBuildStopped()).not.toThrow();
    expect(exportBuildMsLeft()).toBe(Infinity);
  });
});

describe('renderExportPage (#716)', () => {
  it('outside withExportConversion it fails closed (a programming error, never an actorless conversion)', async () => {
    await expect(renderExportPage(DOC, 'html', 'A')).rejects.toThrow(/outside withExportConversion/);
    expect(serialize).not.toHaveBeenCalled();
  });

  it('a page past the worker’s bounds is 422 export_too_large reason page', async () => {
    serialize.mockRejectedValueOnce(new ContentTooComplexException());
    const err = await withExportConversion(ONE, () => renderExportPage(DOC, 'markdown', 'A'), { socket: null }).catch((e) => e);
    expect(err).toBeInstanceOf(ExportTooLargeException);
    expect((err as ExportTooLargeException).reason).toBe('page');
  });

  it('503 engine_busy, 429 conversion_budget_exhausted and a 500 pass through unchanged', async () => {
    for (const e of [new ContentParseBusyException(), new ConversionBudgetExhaustedException(12), new InternalServerErrorException()]) {
      serialize.mockRejectedValueOnce(e);
      const err = await withExportConversion(ONE, () => renderExportPage(DOC, 'html', 'A'), { socket: null }).catch((x) => x);
      expect(err).toBe(e);
    }
  });

  it('HTML is upstream’s document template around the worker’s HTML; Markdown is the worker’s output as is', async () => {
    serialize.mockImplementation(async (_j: unknown, format: string) => (format === 'html' ? '<p>x</p>' : 'x\n'));
    const [html, md, other] = await withExportConversion(
      ONE,
      async () => [
        await renderExportPage(DOC, 'html', 'My page'),
        await renderExportPage(DOC, 'markdown', 'My page'),
        await renderExportPage(DOC, 'pdf', 'My page'),
      ],
      { socket: null },
    );
    expect(html).toBe(`<!DOCTYPE html>
      <html>
        <head>
         <title>My page</title>
        </head>
        <body><p>x</p></body>
      </html>`);
    expect(md).toBe('x\n');
    expect(other).toBeUndefined(); // as upstream: no other format
    expect(serialize).toHaveBeenCalledTimes(2);
  });
});
