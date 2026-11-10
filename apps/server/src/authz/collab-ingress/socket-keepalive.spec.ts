import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { Hocuspocus } from '@hocuspocus/server';
import { authFrame, FakeSocket } from './collab-ingress.testkit';
import { COLLAB_PING_INTERVAL_MS, keepCollabSocketAlive } from './socket-keepalive';

/**
 * #790: Hocuspocus 4.x sends no pings and reaps a connection that received nothing for `timeout`. The gateway pings
 * every socket and counts each pong as activity (`touch()`), on both the RedisSync and the standalone path, so a quiet
 * but healthy editor stays connected; an unauthenticated socket still meets its deadline. RedisSync's proxied frames
 * refresh the idle clock through `touch()` only, never the private pre-auth reference upstream rewrites.
 */
const SRC = join(__dirname, '..', '..');
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONNECTION_TIMEOUT = 4408; // @hocuspocus/common ConnectionTimeout.code

class PongingSocket extends FakeSocket {
  pings = 0;
  answer = true;
  override ping(): void {
    this.pings += 1;
    if (this.answer) setImmediate(() => this.emit('pong', Buffer.alloc(0)));
  }
}

describe('keepCollabSocketAlive (#790)', () => {
  afterEach(() => jest.useRealTimers());

  it('pings an open socket every interval, counts each pong as activity, and stops when the socket closes', () => {
    jest.useFakeTimers();
    const sock = new PongingSocket();
    sock.answer = false;
    const touch = jest.fn();
    keepCollabSocketAlive(sock, touch, 1_000);
    jest.advanceTimersByTime(3_000);
    expect(sock.pings).toBe(3);
    sock.emit('pong');
    sock.emit('pong');
    expect(touch).toHaveBeenCalledTimes(2);
    sock.readyState = 2; // closing: no ping
    jest.advanceTimersByTime(1_000);
    expect(sock.pings).toBe(3);
    sock.readyState = 1;
    sock.close(1000, 'bye');
    jest.advanceTimersByTime(10_000);
    expect(sock.pings).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a ping that throws (the socket closed in between) is swallowed', () => {
    jest.useFakeTimers();
    const sock = new PongingSocket();
    sock.ping = () => {
      throw new Error('not open');
    };
    keepCollabSocketAlive(sock, () => undefined, 1_000);
    expect(() => jest.advanceTimersByTime(1_000)).not.toThrow();
    sock.close(1000, 'bye');
  });

  it('pings well inside Hocuspocus\'s default 60 s idle timeout', () => {
    expect(COLLAB_PING_INTERVAL_MS).toBeLessThanOrEqual(30_000);
  });
});

// Margins: Hocuspocus checks every `timeout` and reaps past it, so a reaped socket is closed within 2 x TIMEOUT; a
// kept-alive one is touched every 25 ms, so only an event-loop stall longer than TIMEOUT could close it.
const TIMEOUT = 400;
describe('through a real Hocuspocus 4.7.1 (timeout shortened to 400 ms)', () => {
  const open: Hocuspocus[] = [];
  const sockets: FakeSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close(1000, 'test over');
    for (const hp of open.splice(0)) hp.closeConnections();
    await settle(5);
  });
  const server = () => {
    const hp = new Hocuspocus({
      quiet: true,
      timeout: TIMEOUT,
      extensions: [{ async onAuthenticate(d: { token: string }) { if (d.token !== 'ok') throw new Error('denied'); return { user: { id: 'u' } }; } }],
    } as never);
    open.push(hp);
    return hp;
  };
  const socket = (hp: Hocuspocus, keepAlive: boolean) => {
    const sock = new PongingSocket();
    sockets.push(sock);
    const clientConnection = sock.connect(hp);
    if (keepAlive) keepCollabSocketAlive(sock, () => clientConnection.touch(), 25);
    return sock;
  };

  it('control: an authenticated socket that sends nothing is reaped at the idle timeout', async () => {
    const hp = server();
    const sock = socket(hp, false);
    sock.deliver(authFrame('ok'));
    await settle(2.5 * TIMEOUT);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });

  it('with the keepalive, the same quiet socket stays connected', async () => {
    const hp = server();
    const sock = socket(hp, true);
    sock.deliver(authFrame('ok'));
    await settle(2.5 * TIMEOUT);
    expect(sock.closed).toBeNull();
    expect(sock.pings).toBeGreaterThan(5);
  });

  it('pongs never extend an unauthenticated socket\'s deadline', async () => {
    const hp = server();
    const sock = socket(hp, true); // never authenticates
    await settle(2.5 * TIMEOUT);
    expect(sock.pings).toBeGreaterThan(0);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });

  it('a socket that stops answering pings is reaped', async () => {
    const hp = server();
    const sock = socket(hp, true);
    sock.deliver(authFrame('ok'));
    await settle(TIMEOUT / 2);
    expect(sock.closed).toBeNull();
    sock.answer = false;
    await settle(2.5 * TIMEOUT);
    expect(sock.closed?.code).toBe(CONNECTION_TIMEOUT);
  });
});

describe('wiring', () => {
  const parse = (rel: string) => ts.createSourceFile(rel, readFileSync(join(SRC, rel), 'utf8'), ts.ScriptTarget.Latest, true);

  it('the gateway keeps every socket alive on both paths (RedisSync and standalone)', () => {
    const sf = parse('collaboration/collaboration.gateway.ts');
    let branches: string[][] = [];
    const visit = (n: ts.Node) => {
      if (ts.isMethodDeclaration(n) && n.name.getText() === 'handleConnection') {
        const body = n.body!.statements.find(ts.isIfStatement)!;
        const callsIn = (s: ts.Node | undefined) => {
          const out: string[] = [];
          const walk = (m: ts.Node) => {
            if (ts.isCallExpression(m) && m.expression.getText() === 'keepCollabSocketAlive') out.push(m.getText());
            ts.forEachChild(m, walk);
          };
          if (s) walk(s);
          return out;
        };
        branches = [callsIn(body.thenStatement), callsIn(body.elseStatement)];
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(branches).toEqual([
      ['keepCollabSocketAlive(client, () => clientConnection.touch())'],
      ['keepCollabSocketAlive(client, () => clientConnection.touch())'],
    ]);
  });

  it('RedisSync refreshes a proxied socket through touch() only, never the private pre-auth reference', () => {
    const text = readFileSync(join(SRC, 'collaboration/extensions/redis-sync/redis-sync.extension.ts'), 'utf8');
    const code = text.replace(/\/\/.*$/gm, ''); // comments may name it; code may not
    expect(code).not.toMatch(/connectionEstablishedAt/);
    expect(code).not.toMatch(/lastMessageReceivedAt\s*=/);
    expect(code).toMatch(/clientConnection\.touch\(\)/);
  });
});
