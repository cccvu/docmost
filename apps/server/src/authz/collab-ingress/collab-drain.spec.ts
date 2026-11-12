import { CollabSocketBounds, COLLAB_DRAIN_TOKEN } from './socket-bounds';
import { CollabSocketDocuments } from './socket-documents';
import { SocketLimitLog } from './socket-limit-log';
import { COLLAB_DRAINING_CLOSE, CollabUserConnections, CollabUserConnectionsExtension } from './user-connections';
import { canStartCompaction, resumeCompactionsForTests, setCompactionClockForTests } from '../page-write/compaction-registry';
import { COMPACTION_ARM_DELAY_MS } from './doc-bounds';

/**
 * #810: the drain's late-connection rule. From the start of the gateway's `destroy` (the bounds' `draining`), every
 * connection Hocuspocus establishes is closed at its `connected` hook, the socket first with 1013 and then the document
 * connection, and holds nothing. The end-to-end proof (a late Auth during a real destroy, and the mutation arm that
 * leaves destroy unresolved) is gateway-shutdown.spec.ts.
 */
const quiet = () => new SocketLimitLog({ warn: () => undefined });
const payload = (order: string[]) => ({
  socketId: 's1',
  documentName: 'page.p',
  context: { user: { id: 'u1' } },
  connection: {
    close: jest.fn((e?: unknown) => order.push(`document ${JSON.stringify(e)}`)),
    webSocket: { close: jest.fn((code?: number, reason?: string) => order.push(`socket ${code} ${reason}`)) },
    document: { hasConnection: () => true },
    onClose: () => undefined,
  },
});

describe('#810 the drain closes every connection established after it began', () => {
  it('while draining: the socket first with 1013, then the document connection; nothing is held', async () => {
    const connections = new CollabUserConnections({ limitLog: quiet() });
    const ext = new CollabUserConnectionsExtension(connections, new CollabSocketDocuments(), () => true);
    const order: string[] = [];
    const p = payload(order);
    await ext.connected(p);
    expect(order).toEqual([`socket 1013 Try Again Later`, `document ${JSON.stringify(COLLAB_DRAINING_CLOSE)}`]);
    expect(connections.count('u1')).toBe(0);
  });

  it('control: not draining, the same connection is held and nothing is closed', async () => {
    const connections = new CollabUserConnections({ limitLog: quiet() });
    const ext = new CollabUserConnectionsExtension(connections, new CollabSocketDocuments(), () => false);
    const order: string[] = [];
    await ext.connected(payload(order));
    expect(order).toEqual([]);
    expect(connections.count('u1')).toBe(1);
  });

  it('a close that throws never escapes the hook', async () => {
    const ext = new CollabUserConnectionsExtension(new CollabUserConnections({ limitLog: quiet() }), new CollabSocketDocuments(), () => true);
    const p = payload([]);
    p.connection.webSocket.close.mockImplementation(() => {
      throw new Error('gone');
    });
    await expect(ext.connected(p)).resolves.toBeUndefined();
  });

  it('the bounds\' own extension reads the bounds\' flag, which beginDrain sets', async () => {
    const lines: string[] = [];
    let now = 1_000;
    const bounds = new CollabSocketBounds({ limitLog: quiet(), drainLog: { log: (m) => lines.push(m) }, now: () => now });
    const before: string[] = [];
    await bounds.userConnectionsExtension.connected({ ...payload(before), socketId: 'before' });
    expect(before).toEqual([]);
    expect(bounds.draining).toBe(false);

    const restoreClock = setCompactionClockForTests({ now: () => now, uptimeMs: () => COMPACTION_ARM_DELAY_MS + 1 });
    expect(canStartCompaction('page-drain')).toBe(true);
    const done = bounds.beginDrain(3);
    expect(bounds.draining).toBe(true);
    expect(canStartCompaction('page-drain')).toBe(false); // #827: the drain's unloads never compact
    resumeCompactionsForTests();
    restoreClock();
    const after: string[] = [];
    await bounds.userConnectionsExtension.connected({ ...payload(after), socketId: 'after' });
    expect(after[0]).toBe('socket 1013 Try Again Later');
    expect(bounds.connections.count('u1')).toBe(1); // only the one from before the drain

    now += 1_234;
    done();
    done(); // once
    expect(bounds.beginDrain(9)).toBeInstanceOf(Function); // a second destroy logs nothing new
    expect(lines).toEqual([
      `${COLLAB_DRAIN_TOKEN} {"phase":"start","documents":3}`,
      `${COLLAB_DRAIN_TOKEN} {"phase":"done","documents":3,"ms":1234}`,
    ]);
  });
});
