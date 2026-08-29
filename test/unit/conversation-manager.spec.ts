import type { BrowserContext, Page } from 'patchright';
import { ContextPool } from '../../src/browser/context-pool.service';
import { HermodConfigService } from '../../src/config/hermod-config.service';
import { ConversationManager } from '../../src/queries/conversation-manager.service';

const flush = () => new Promise((r) => setImmediate(r));

function makePage() {
  const state = { closed: false };
  const page = {
    isClosed: () => state.closed,
    close: jest.fn(async () => {
      state.closed = true;
    }),
  } as unknown as Page;

  return { page, state };
}

const ctx = () => ({}) as unknown as BrowserContext;

function makeManager(opts: { ttlMs?: number; max?: number } = {}) {
  let clock = 0;
  const destroy = jest.fn(async () => undefined);
  const pool = { destroy } as unknown as ContextPool;
  const config = {
    conversation: { ttlMs: opts.ttlMs ?? 1000, max: opts.max ?? 2 },
  } as unknown as HermodConfigService;
  const manager = new ConversationManager(pool, config, () => clock);

  return { manager, destroy, advance: (ms: number) => (clock += ms) };
}

const sweep = (m: ConversationManager) => (m as unknown as { sweep(): Promise<void> }).sweep();

describe('ConversationManager', () => {
  it('opens and retrieves a live conversation', () => {
    const { manager } = makeManager();

    manager.open('a', 'chatgpt', ctx(), makePage().page);

    expect(manager.get('a')?.id).toBe('a');
    expect(manager.size).toBe(1);
  });

  it('expires and destroys a conversation past its idle TTL', async () => {
    const { manager, destroy, advance } = makeManager({ ttlMs: 1000 });
    const c = ctx();

    manager.open('a', 'chatgpt', c, makePage().page);
    advance(1001);

    expect(manager.get('a')).toBeUndefined();
    await flush();
    expect(destroy).toHaveBeenCalledWith(c);
    expect(manager.size).toBe(0);
  });

  it('markActive refreshes the idle clock so an in-flight turn is not swept', async () => {
    const { manager, destroy, advance } = makeManager({ ttlMs: 1000 });

    manager.open('a', 'chatgpt', ctx(), makePage().page);
    advance(900);
    manager.markActive('a');
    advance(900);

    expect(manager.get('a')?.id).toBe('a');
    await flush();
    expect(destroy).not.toHaveBeenCalled();
  });

  it('drops a conversation whose page has died', async () => {
    const { manager, destroy } = makeManager();
    const { page, state } = makePage();

    manager.open('a', 'chatgpt', ctx(), page);
    state.closed = true;

    expect(manager.get('a')).toBeUndefined();
    await flush();
    expect(destroy).toHaveBeenCalled();
  });

  it('evicts the least-recently-used conversation at capacity', async () => {
    const { manager, destroy, advance } = makeManager({ max: 2 });
    const cA = ctx();

    manager.open('a', 'chatgpt', cA, makePage().page);
    advance(10);
    manager.open('b', 'chatgpt', ctx(), makePage().page);

    manager.ensureCapacity();

    expect(manager.get('a')).toBeUndefined();
    expect(manager.get('b')?.id).toBe('b');
    await flush();
    expect(destroy).toHaveBeenCalledWith(cA);
    expect(manager.size).toBe(1);
  });

  it('closes idempotently: a double close destroys the context once', async () => {
    const { manager, destroy } = makeManager();

    manager.open('a', 'chatgpt', ctx(), makePage().page);
    await Promise.all([manager.close('a'), manager.close('a')]);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
  });

  it('sweep closes stale sessions and keeps fresh ones', async () => {
    const { manager, destroy, advance } = makeManager({ ttlMs: 1000, max: 5 });
    const cOld = ctx();

    manager.open('old', 'chatgpt', cOld, makePage().page);
    advance(1001);
    manager.open('fresh', 'chatgpt', ctx(), makePage().page);

    await sweep(manager);

    expect(destroy).toHaveBeenCalledWith(cOld);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(manager.get('fresh')?.id).toBe('fresh');
    expect(manager.size).toBe(1);
  });
});
