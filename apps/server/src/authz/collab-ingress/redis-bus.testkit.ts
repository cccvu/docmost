/**
 * CCC collab integration — NOT upstream Docmost code (#810, ADR 0036). NOT a jest suite and not built (`.testkit.ts`).
 *
 * An in-memory stand-in for Redis, for the RedisSync specs (redis-sync-two-node.spec.ts, gateway-shutdown.spec.ts): one
 * `FakeRedisBus` is the server, and every `FakeRedisClient` on it (the gateway's `new RedisClient(...)` and RedisSync's
 * `duplicate()`s) shares its pub/sub and its keys. It implements only the commands RedisSync uses
 * (redis-sync.extension.ts): `duplicate`, `subscribe`, `on('messageBuffer' | 'error')`, `publish`, `set` (with
 * `PX`, `NX`, `GET`), `get`, `del` and `disconnect`, with Redis's semantics:
 * - `publish` resolves the number of subscribers it reached, and delivers to each one later, as `(channel, message)`
 *   Buffers: on the REAL `setImmediate` (captured when this module loads, before a spec fakes the clock), as network I/O
 *   would arrive, so a delivery never waits for the fake clock to move (`turn()` lets every pending one land);
 * - `set k v PX ms NX GET` answers the previous value (null when it set the key), and sets only when the key is absent;
 * - a key's `PX` expiry is read on the bus's clock (`now`, `Date.now` by default, so jest's fake clock moves it);
 * - after `disconnect`, a client receives nothing, and its commands reach no server: they resolve to null and are kept
 *   in `bus.dropped`, so a spec can see a DEL that never happened (the residual a lock left behind is).
 * The live compose run (real Redis 8) covers what this model leaves out.
 */
import { EventEmitter } from 'node:events';

type Entry = { value: string; expiresAt: number | null };

/** The real setImmediate, whatever a spec does to the clock after this module loaded. */
const realSetImmediate: typeof setImmediate = globalThis.setImmediate;

/** One real event-loop turn: every delivery already published, and every promise chain pending, has run. */
export const turn = (): Promise<void> => new Promise((resolve) => realSetImmediate(resolve));

export class FakeRedisBus {
  private readonly keys = new Map<string, Entry>();
  readonly clients = new Set<FakeRedisClient>();
  /** Commands sent by a disconnected client: `[command, key or channel]`. */
  readonly dropped: Array<[string, string]> = [];
  /** Every message published, in order (channel and the packed bytes), for specs that decode what was relayed. */
  readonly published: Array<{ channel: string; message: Buffer }> = [];
  /** False: publish reaches no one (the anti-vacuity arm of a delivery-dependent spec). */
  deliver = true;

  constructor(readonly now: () => number = () => Date.now()) {}

  client(): FakeRedisClient {
    return new FakeRedisClient(this);
  }

  /** The live keys starting with `prefix` (expired ones are gone). */
  keysMatching(prefix: string): string[] {
    return [...this.keys.keys()].filter((k) => k.startsWith(prefix) && this.read(k) !== null);
  }

  /** The value of a live key, or null. */
  read(key: string): string | null {
    const e = this.keys.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= this.now()) {
      this.keys.delete(key);
      return null;
    }
    return e.value;
  }

  write(key: string, value: string, px: number | null): void {
    this.keys.set(key, { value, expiresAt: px === null ? null : this.now() + px });
  }

  remove(key: string): boolean {
    const live = this.read(key) !== null;
    this.keys.delete(key);
    return live;
  }

  /** Subscribers of `channel`, each called back later; returns how many. */
  fanOut(channel: string, message: Buffer): number {
    this.published.push({ channel, message });
    if (!this.deliver) return 0;
    const to = [...this.clients].filter((c) => c.isSubscribedTo(channel));
    for (const c of to) realSetImmediate(() => c.receive(channel, message));
    return to.length;
  }
}

export class FakeRedisClient extends EventEmitter {
  private readonly channels = new Set<string>();
  connected = true;

  constructor(readonly bus: FakeRedisBus) {
    super();
    bus.clients.add(this);
  }

  duplicate(): FakeRedisClient {
    return new FakeRedisClient(this.bus);
  }

  isSubscribedTo(channel: string): boolean {
    return this.connected && this.channels.has(channel);
  }

  receive(channel: string, message: Buffer): void {
    if (this.isSubscribedTo(channel)) this.emit('messageBuffer', Buffer.from(channel), message);
  }

  private gone(command: string, target: string): boolean {
    if (this.connected) return false;
    this.bus.dropped.push([command, target]);
    return true;
  }

  async subscribe(...channels: string[]): Promise<number> {
    if (this.gone('subscribe', channels.join(' '))) return 0;
    for (const c of channels) this.channels.add(c);
    return this.channels.size;
  }

  async publish(channel: string, message: Buffer | Uint8Array | string): Promise<number> {
    if (this.gone('publish', channel)) return 0;
    return this.bus.fanOut(channel, Buffer.from(message as Uint8Array));
  }

  /** `SET key value [PX ms] [NX] [GET]`: Redis's answers (GET: the old value; otherwise 'OK', or null when NX refused). */
  async set(key: string, value: string, ...args: Array<string | number>): Promise<string | null> {
    if (this.gone('set', key)) return null;
    let px: number | null = null;
    let nx = false;
    let get = false;
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase();
      if (a === 'PX') px = Number(args[++i]);
      else if (a === 'NX') nx = true;
      else if (a === 'GET') get = true;
      else throw new Error(`FakeRedisClient.set: unsupported argument ${a}`);
    }
    const old = this.bus.read(key);
    if (nx && old !== null) return get ? old : null;
    this.bus.write(key, String(value), px);
    return get ? old : 'OK';
  }

  async get(key: string): Promise<string | null> {
    if (this.gone('get', key)) return null;
    return this.bus.read(key);
  }

  async del(...keys: string[]): Promise<number> {
    if (this.gone('del', keys.join(' '))) return 0;
    return keys.filter((k) => this.bus.remove(k)).length;
  }

  disconnect(): void {
    this.connected = false;
    this.channels.clear();
  }
}
