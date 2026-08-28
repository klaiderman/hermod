import type { BrowserContext, Page } from 'patchright';
import { ContextPool } from '../../src/browser/context-pool.service';
import { Conversation, ConversationManager } from '../../src/queries/conversation-manager.service';
import { HermodConfigService } from '../../src/config/hermod-config.service';
import {
  EmptyResponseError,
  ParsingFailedError,
  PoolExhaustedError,
  UnsupportedSourceError,
} from '../../src/common/errors/scraper-errors';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { ScraperRegistry } from '../../src/scrapers/scraper.registry';
import {
  BlockVerdict,
  NormalizedDelta,
  ReadMode,
  ScrapeRequest,
  ScraperStrategy,
  StrategyResponse,
} from '../../src/scrapers/scraper.types';
import { ScrapeEngine } from '../../src/queries/scrape-engine.service';

const NONE: BlockVerdict = { blocked: false, reason: 'none', layer: 'none' };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AttemptBehavior {
  prepareThrows?: Error;
  response?: { status: number; contentType: string };
  verdict?: BlockVerdict;
  behavioral?: BlockVerdict;
  deltas?: NormalizedDelta[];
  gapMs?: number;
  streamThrows?: Error;
}

class FakeStrategy implements ScraperStrategy {
  readonly source = 'chatgpt' as const;
  attempts = 0;
  continueCalls = 0;
  private current: AttemptBehavior = {};

  constructor(
    private readonly behaviors: AttemptBehavior[],
    private readonly continueDeltas: NormalizedDelta[] = [],
  ) {}

  async prepare(_page: Page, _req: ScrapeRequest): Promise<void> {
    this.current = this.behaviors[this.attempts] ?? this.behaviors[this.behaviors.length - 1] ?? {};
    this.attempts += 1;

    if (this.current.prepareThrows) {
      throw this.current.prepareThrows;
    }
  }

  async submitAndAwaitResponse(_page: Page, _req: ScrapeRequest): Promise<StrategyResponse> {
    const r = this.current.response ?? { status: 200, contentType: 'text/event-stream' };

    return {
      status: r.status,
      contentType: r.contentType,
      rawChunks: async function* () {},
    };
  }

  async *streamDeltas(): AsyncIterable<NormalizedDelta> {
    if (this.current.streamThrows) {
      throw this.current.streamThrows;
    }

    for (const d of this.current.deltas ?? []) {
      if (this.current.gapMs) {
        await delay(this.current.gapMs);
      }

      yield d;
    }
  }

  async detectBlock(_page: Page, res: StrategyResponse | null): Promise<BlockVerdict> {
    if (res !== null) {
      return this.current.verdict ?? NONE;
    }

    return this.current.behavioral ?? NONE;
  }

  async *continueTurn(_page: Page, _req: ScrapeRequest): AsyncIterable<NormalizedDelta> {
    this.continueCalls += 1;

    for (const d of this.continueDeltas) {
      yield d;
    }
  }

  readModeFor(): ReadMode {
    return 'sse';
  }
}

function fakePool() {
  const destroy = jest.fn(async () => undefined);
  const release = jest.fn(async () => undefined);
  const page = { close: async () => undefined } as unknown as Page;
  const ctx = { newPage: async () => page, close: async () => undefined } as unknown as BrowserContext;
  const pool = {
    acquire: jest.fn(async () => ctx),
    release,
    destroy,
    stats: () => ({ size: 1, available: 0, borrowed: 1, pending: 0 }),
  } as unknown as ContextPool;

  return { pool, destroy, release, ctx, page, acquire: pool.acquire as jest.Mock };
}

function fakeConversations(session?: Conversation) {
  const open = jest.fn((id: string) => id);
  const touch = jest.fn();
  const get = jest.fn(() => session);
  const ensureCapacity = jest.fn();

  return {
    conversations: {
      get,
      open,
      touch,
      ensureCapacity,
      close: jest.fn(async () => undefined),
      size: 0,
    } as unknown as ConversationManager,
    open,
    touch,
    get,
    ensureCapacity,
  };
}

function fakeConfig(): HermodConfigService {
  return {
    nodeEnv: 'test',
    timeouts: { navMs: 500, firstByteMs: 25, idleMs: 25, wallClockMs: 3000 },
    retry: { maxAttempts: 3, backoffInitialMs: 1, backoffMaxMs: 5 },
  } as unknown as HermodConfigService;
}

const logger = {
  setContext: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function registryWith(strategy: ScraperStrategy): ScraperRegistry {
  return {
    get: (source: string) => {
      if (source === 'chatgpt') {
        return strategy;
      }

      throw new UnsupportedSourceError(`Source '${source}' is not supported.`);
    },
  } as unknown as ScraperRegistry;
}

function makeEngine(strategy: ScraperStrategy, poolBundle = fakePool(), convoBundle = fakeConversations()) {
  const engine = new ScrapeEngine(
    registryWith(strategy),
    poolBundle.pool,
    convoBundle.conversations,
    fakeConfig(),
    logger,
  );

  return { engine, ...poolBundle, ...convoBundle };
}

const req = (over: Partial<ScrapeRequest> = {}): ScrapeRequest => ({
  source: 'chatgpt',
  prompt: 'What are the three largest countries in Europe by population?',
  parse: true,
  requestId: 'req-test',
  ...over,
});

const done: NormalizedDelta = { index: 99, text: '', done: true };

describe('ScrapeEngine', () => {
  it('returns a normalized answer on a healthy stream (parse=true)', async () => {
    const { engine, open, destroy } = makeEngine(
      new FakeStrategy([
        {
          deltas: [
            { index: 0, text: '**Hello** ', done: false, model: 'gpt-4o-mini', conversationId: 'conv-1' },
            {
              index: 1,
              text: 'world',
              done: false,
              citations: [{ url: 'https://x.test' }],
              searchQueries: ['largest countries europe'],
            },
            done,
          ],
        },
      ]),
    );

    const result = await engine.execute(req());

    expect(result.content.response_text).toBe('Hello world');
    expect(result.content.markdown_text).toBe('**Hello** world');
    expect(result.content.llm_model).toBe('gpt-4o-mini');
    expect(result.content.citations).toEqual([{ url: 'https://x.test' }]);
    expect(typeof result.content.conversation_id).toBe('string');
    expect(open).toHaveBeenCalledWith(result.content.conversation_id, 'chatgpt', expect.anything(), expect.anything());
    expect(result.content.search_queries).toEqual(['largest countries europe']);
    expect(result.attempts).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('honors parse=false (raw text, nulled metadata)', async () => {
    const { engine } = makeEngine(
      new FakeStrategy([{ deltas: [{ index: 0, text: '**raw** md', done: false }, done] }]),
    );
    const result = await engine.execute(req({ parse: false }));

    expect(result.content.response_text).toBe('**raw** md');
    expect(result.content.markdown_text).toBeNull();
    expect(result.content.citations).toEqual([]);
    expect(result.content.llm_model).toBeNull();
    expect(typeof result.content.conversation_id).toBe('string');
    expect(result.content.search_queries).toEqual([]);
  });

  it('discards a tool/status placeholder when a reset delta replaces it', async () => {
    const { engine } = makeEngine(
      new FakeStrategy([
        {
          deltas: [
            { index: 0, text: 'Searching the web', done: false },
            { index: 1, text: 'The time in New York is 8:31 AM.', done: false, reset: true },
            done,
          ],
        },
      ]),
    );
    const result = await engine.execute(req());

    expect(result.content.response_text).toBe('The time in New York is 8:31 AM.');
    expect(result.content.markdown_text).toBe('The time in New York is 8:31 AM.');
    expect(result.content.response_text).not.toContain('Searching the web');
  });

  it('rejects an unsupported source before acquiring a context (422)', async () => {
    const bundle = fakePool();
    const { engine } = makeEngine(new FakeStrategy([{}]), bundle);

    await expect(engine.execute(req({ source: 'nonesuch' }))).rejects.toBeInstanceOf(UnsupportedSourceError);
    expect(bundle.acquire).not.toHaveBeenCalled();
  });

  it('maps a rate-limit verdict to TARGET_RATE_LIMITED and does not retry', async () => {
    const strategy = new FakeStrategy([
      {
        response: { status: 429, contentType: 'application/json' },
        verdict: { blocked: true, reason: 'rate-limited', layer: 'transport' },
      },
    ]);
    const { engine } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toMatchObject({
      errorCode: ErrorCode.TARGET_RATE_LIMITED,
      httpStatus: 429,
    });
    expect(strategy.attempts).toBe(1);
  });

  it('maps a confirmed block to TARGET_BLOCKED and does not retry', async () => {
    const strategy = new FakeStrategy([
      {
        response: { status: 403, contentType: 'text/html' },
        verdict: { blocked: true, reason: 'blocked', layer: 'transport' },
      },
    ]);
    const { engine } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toMatchObject({
      errorCode: ErrorCode.TARGET_BLOCKED,
      httpStatus: 403,
    });
    expect(strategy.attempts).toBe(1);
  });

  it('retries a 200-challenge on a FRESH context, then surfaces a TERMINAL TARGET_BLOCKED', async () => {
    const challenge: BlockVerdict = { blocked: true, reason: 'challenge', layer: 'content' };
    const strategy = new FakeStrategy([{ verdict: challenge }]);
    const { engine, destroy, release } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toMatchObject({
      errorCode: ErrorCode.TARGET_BLOCKED,
      httpStatus: 403,
      retryable: false,
    });
    expect(strategy.attempts).toBeGreaterThan(1);
    expect(destroy).toHaveBeenCalledTimes(strategy.attempts);
    expect(release).not.toHaveBeenCalled();
  });

  it('times out the first byte (TARGET_TIMEOUT) and retries', async () => {
    const strategy = new FakeStrategy([{ deltas: [{ index: 0, text: 'late', done: false }, done], gapMs: 120 }]);
    const { engine } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toMatchObject({
      errorCode: ErrorCode.TARGET_TIMEOUT,
    });
    expect(strategy.attempts).toBeGreaterThan(1);
  });

  it('raises PARTIAL_RESPONSE with salvage when the stream ends with no terminal marker (no retry)', async () => {
    const strategy = new FakeStrategy([{ deltas: [{ index: 0, text: 'partial start', done: false }], gapMs: 0 }]);
    const { engine } = makeEngine(strategy);
    const err = await engine.execute(req()).catch((e: unknown) => e);

    expect(err).toMatchObject({ errorCode: ErrorCode.PARTIAL_RESPONSE, httpStatus: 504 });
    expect((err as { salvage: { markdown_text: string } }).salvage.markdown_text).toBe('partial start');
    expect(strategy.attempts).toBe(1);
  });

  it('raises EMPTY_RESPONSE when the terminal marker arrives with zero content', async () => {
    const strategy = new FakeStrategy([{ deltas: [{ index: 0, text: '', done: false }, done] }]);
    const { engine } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toBeInstanceOf(EmptyResponseError);
  });

  it('surfaces PARSING_FAILED from the stream without remapping to partial (no retry)', async () => {
    const strategy = new FakeStrategy([{ streamThrows: new ParsingFailedError('bad shape') }]);
    const { engine } = makeEngine(strategy);

    await expect(engine.execute(req())).rejects.toBeInstanceOf(ParsingFailedError);
    expect(strategy.attempts).toBe(1);
  });

  it('translates pool exhaustion to TARGET_UNAVAILABLE (503), no retry', async () => {
    const bundle = fakePool();

    (bundle.acquire as jest.Mock).mockRejectedValue(new PoolExhaustedError('busy'));
    const { engine } = makeEngine(new FakeStrategy([{}]), bundle);

    await expect(engine.execute(req())).rejects.toMatchObject({
      errorCode: ErrorCode.TARGET_UNAVAILABLE,
      httpStatus: 503,
    });
  });

  it('recovers on retry: challenge then success (destroy the poisoned context, hold the healthy one)', async () => {
    const strategy = new FakeStrategy([
      { verdict: { blocked: true, reason: 'challenge', layer: 'content' } },
      { deltas: [{ index: 0, text: 'recovered', done: false }, done] },
    ]);
    const { engine, destroy, open } = makeEngine(strategy);
    const result = await engine.execute(req());

    expect(result.content.response_text).toBe('recovered');
    expect(result.attempts).toBe(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('mints a conversation id when the caller supplies none', async () => {
    const strategy = new FakeStrategy([{ deltas: [{ index: 0, text: 'hi', done: false }, done] }]);
    const { engine, open, ensureCapacity } = makeEngine(strategy);
    const result = await engine.execute(req());

    expect(typeof result.content.conversation_id).toBe('string');
    expect(open).toHaveBeenCalledWith(result.content.conversation_id, 'chatgpt', expect.anything(), expect.anything());
    expect(ensureCapacity).toHaveBeenCalledTimes(1);
  });

  it('opens a new conversation on an unknown id, borrowing a pooled context', async () => {
    const strategy = new FakeStrategy([{ deltas: [{ index: 0, text: 'Hi Gilad', done: false }, done] }]);
    const { engine, open, acquire, destroy } = makeEngine(strategy, fakePool(), fakeConversations(undefined));
    const result = await engine.execute(req({ conversationId: 'gilad', prompt: 'My name is Gilad' }));

    expect(result.content.response_text).toBe('Hi Gilad');
    expect(result.content.conversation_id).toBe('gilad');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('gilad', 'chatgpt', expect.anything(), expect.anything());
    expect(destroy).not.toHaveBeenCalled();
  });

  it('continues an existing conversation in the same page, without borrowing a context', async () => {
    const session: Conversation = {
      id: 'gilad',
      source: 'chatgpt',
      page: {} as Page,
      context: {} as BrowserContext,
      turns: 1,
      lastUsedAt: 0,
    };
    const strategy = new FakeStrategy([], [{ index: 0, text: 'Your name is Gilad', done: false }, done]);
    const { engine, touch, acquire } = makeEngine(strategy, fakePool(), fakeConversations(session));
    const result = await engine.execute(req({ conversationId: 'gilad', prompt: 'What is my name?' }));

    expect(result.content.response_text).toBe('Your name is Gilad');
    expect(result.content.conversation_id).toBe('gilad');
    expect(strategy.continueCalls).toBe(1);
    expect(touch).toHaveBeenCalledWith('gilad');
    expect(acquire).not.toHaveBeenCalled();
  });
});
