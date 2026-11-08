// #731 F1: `yieldToEventLoop` must let I/O that ARRIVED during a heavy step be handled before the next step, also when
// that step runs in a poll-phase callback (a database reply, a socket frame), which is where a content write's steps
// usually run. Real sockets, no fakes: the scenario is the event loop's own phase order.
import { AddressInfo, createServer, connect, Server, Socket } from 'node:net';
import { yieldToEventLoop } from './yield-to-event-loop';
import { yieldToEventLoop as handlersYield } from './replace-update';

/** The pre-#731 F1 yield: one `setImmediate`. Kept here only to prove the scenario tells the two apart. */
const singleImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Busy-wait: the "heavy synchronous step" (and ample time for the kernel to deliver a loopback write already made). */
const spin = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

interface Pair {
  client: Socket;
  server: Socket;
}

describe('yieldToEventLoop (#731 F1): a full loop turn, I/O poll included', () => {
  let srv: Server;
  const pairs: Pair[] = [];

  /** A connected loopback TCP pair (no Nagle delay: a write is sent at once). */
  const pair = async (): Promise<Pair> => {
    const accepted = new Promise<Socket>((r) => srv.once('connection', r));
    const client = connect((srv.address() as AddressInfo).port, '127.0.0.1');
    client.setNoDelay(true);
    await new Promise((r) => client.once('connect', r));
    const p = { client, server: await accepted };
    pairs.push(p);
    return p;
  };

  beforeAll(async () => {
    srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  });
  afterAll(async () => {
    for (const p of pairs) {
      p.client.destroy();
      p.server.destroy();
    }
    await new Promise((r) => srv.close(r));
  });

  /**
   * Step 1 runs in a poll-phase callback (a frame arriving on `trigger`), the way a write's step runs in a database
   * reply's continuation. During it, another request's frame arrives on `probe`. Returns which ran first: the probe's
   * handler or step 2 (the continuation after the yield).
   */
  async function order(yieldFn: () => Promise<void>): Promise<string[]> {
    const trigger = await pair();
    const probe = await pair();
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      let left = 2;
      const one = () => --left === 0 && resolve();
      probe.server.once('data', () => (seen.push('io'), one()));
      trigger.server.once('data', async () => {
        seen.push('step1');
        probe.client.write('request'); // arrives while step 1 is still running
        spin(15);
        await yieldFn();
        seen.push('step2');
        one();
      });
    });
    trigger.client.write('go');
    await done;
    return seen;
  }

  it('an I/O event that arrived during a poll-phase step is handled BEFORE the step after the yield', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await order(yieldToEventLoop)).toEqual(['step1', 'io', 'step2']);
    }
  });

  it('control: one setImmediate from a poll-phase callback runs before the next poll (the two steps are one block)', async () => {
    // If this ever stops holding, the spec above no longer distinguishes the two yields: re-derive it.
    for (let i = 0; i < 5; i++) {
      expect(await order(singleImmediate)).toEqual(['step1', 'step2', 'io']);
    }
  });

  it('the content handler yields with this same function (replace-update re-exports it)', () => {
    expect(handlersYield).toBe(yieldToEventLoop);
  });

  it('still resolves from outside the poll phase (a timer callback, a microtask chain)', async () => {
    await new Promise<void>((resolve) => setTimeout(() => void yieldToEventLoop().then(resolve), 0));
    await Promise.resolve().then(() => yieldToEventLoop());
  });
});
