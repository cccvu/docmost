// #790: the settle's store drain (settle-drain.ts). The queued-store race itself is pinned on the real Hocuspocus
// 4.7.1 debouncer in authz/collab/collab-flush-queued-store.spec.ts; this pins the drain's own rules.
import { drainDocumentStores, SETTLE_DRAIN_MAX_ROUNDS } from './settle-drain';

const DOC = 'page.44444444-4444-4444-8444-444444444444';
const ID = `onStoreDocument-${DOC}`;

const mutex = () => ({
  runExclusive: jest.fn(async (fn: () => Promise<unknown>) => fn()),
  isLocked: jest.fn(() => false),
});

describe('drainDocumentStores (#790)', () => {
  it('runs a pending store once, by its debounce id, and returns when nothing is executing', async () => {
    const debouncer = {
      isDebounced: jest.fn(() => true),
      executeNow: jest.fn(async () => undefined),
      isCurrentlyExecuting: jest.fn(() => false),
    };
    const saveMutex = mutex();
    await drainDocumentStores(debouncer, { saveMutex }, DOC);
    expect(debouncer.executeNow).toHaveBeenCalledTimes(1);
    expect(debouncer.executeNow).toHaveBeenCalledWith(ID);
    expect(debouncer.isCurrentlyExecuting).toHaveBeenCalledWith(ID);
    expect(saveMutex.runExclusive).toHaveBeenCalledTimes(1);
  });

  it('keeps draining while a store is still executing or the mutex is held', async () => {
    const executing = [true, false, false];
    const locked = [true, false]; // read only once nothing is executing
    const debouncer = {
      isDebounced: jest.fn(() => false),
      executeNow: jest.fn(),
      isCurrentlyExecuting: jest.fn(() => executing.shift() ?? false),
    };
    const saveMutex = {
      ...mutex(),
      isLocked: jest.fn(() => locked.shift() ?? false),
    };
    await drainDocumentStores(debouncer, { saveMutex }, DOC);
    expect(debouncer.executeNow).not.toHaveBeenCalled();
    expect(saveMutex.runExclusive).toHaveBeenCalledTimes(3);
  });

  it('throws (the settle fails closed) when the stores never drain, instead of spinning', async () => {
    const debouncer = {
      isDebounced: jest.fn(() => false),
      executeNow: jest.fn(),
      isCurrentlyExecuting: jest.fn(() => true),
    };
    const saveMutex = mutex();
    await expect(
      drainDocumentStores(debouncer, { saveMutex }, DOC),
    ).rejects.toThrow(/did not drain/);
    expect(saveMutex.runExclusive).toHaveBeenCalledTimes(
      SETTLE_DRAIN_MAX_ROUNDS,
    );
  });
});
