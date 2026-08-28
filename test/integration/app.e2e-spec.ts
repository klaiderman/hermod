import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { BrowserContext, Page } from 'patchright';
import { AppModule } from '../../src/app.module';
import { BrowserManager } from '../../src/browser/browser-manager.service';
import { ContextPool } from '../../src/browser/context-pool.service';
import { ScraperRegistry } from '../../src/scrapers/scraper.registry';
import { UnsupportedSourceError } from '../../src/common/errors/scraper-errors';
import {
  BlockVerdict,
  NormalizedDelta,
  ReadMode,
  ScraperStrategy,
  StrategyResponse,
} from '../../src/scrapers/scraper.types';

const NONE: BlockVerdict = { blocked: false, reason: 'none', layer: 'none' };

const happyStrategy: ScraperStrategy = {
  source: 'chatgpt',
  async prepare() {},
  async submitAndAwaitResponse(): Promise<StrategyResponse> {
    return { status: 200, contentType: 'text/event-stream', rawChunks: async function* () {} };
  },
  async *streamDeltas(): AsyncIterable<NormalizedDelta> {
    yield {
      index: 0,
      text: 'The three largest are **Russia**, Germany, and the UK.',
      done: false,
      model: 'gpt-4o-mini',
    };
    yield { index: 1, text: '', done: true };
  },
  async detectBlock() {
    return NONE;
  },
  async *continueTurn(): AsyncIterable<NormalizedDelta> {
    yield { index: 0, text: 'follow-up answer', done: false };
    yield { index: 1, text: '', done: true };
  },
  readModeFor(): ReadMode {
    return 'sse';
  },
};

const fakeRegistry = {
  get: (source: string) => {
    if (source === 'chatgpt') {
      return happyStrategy;
    }

    throw new UnsupportedSourceError(`Source '${source}' is not supported.`);
  },
} as unknown as ScraperRegistry;

const page = { close: async () => undefined } as unknown as Page;
const ctx = { newPage: async () => page } as unknown as BrowserContext;
const fakePool = {
  onModuleInit: () => undefined,
  onModuleDestroy: async () => undefined,
  acquire: async () => ctx,
  release: async () => undefined,
  destroy: async () => undefined,
  stats: () => ({ size: 1, available: 1, borrowed: 0, pending: 0 }),
} as unknown as ContextPool;

const fakeBrowser = {
  onModuleInit: async () => undefined,
  onModuleDestroy: async () => undefined,
  isAlive: () => true,
} as unknown as BrowserManager;

describe('POST /v1/queries (e2e, browser mocked)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BrowserManager)
      .useValue(fakeBrowser)
      .overrideProvider(ContextPool)
      .useValue(fakePool)
      .overrideProvider(ScraperRegistry)
      .useValue(fakeRegistry)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a normalized 200 envelope for a valid request', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/queries')
      .send({ source: 'chatgpt', prompt: 'What are the three largest countries in Europe?' })
      .expect(200);

    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ source: 'chatgpt', status_code: 200 });
    expect(res.body.results[0].content.response_text).toContain('Russia');
    expect(res.body.results[0].content.markdown_text).toContain('**Russia**');
    expect(res.body.results[0].content.llm_model).toBe('gpt-4o-mini');
    expect(res.body.meta.request_id).toBeDefined();
    expect(typeof res.body.meta.duration_ms).toBe('number');
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('honors an inbound X-Request-Id', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/queries')
      .set('X-Request-Id', 'my-trace-42')
      .send({ source: 'chatgpt', prompt: 'hi' })
      .expect(200);

    expect(res.body.meta.request_id).toBe('my-trace-42');
    expect(res.headers['x-request-id']).toBe('my-trace-42');
  });

  it('rejects an invalid request with 400 INVALID_REQUEST', async () => {
    const res = await request(app.getHttpServer()).post('/v1/queries').send({ source: 'chatgpt' }).expect(400);

    expect(res.body).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
    expect(res.body.meta.request_id).toBeDefined();
  });

  it('rejects an unsupported source with 422 UNSUPPORTED_SOURCE', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/queries')
      .send({ source: 'nonesuch', prompt: 'hi' })
      .expect(422);

    expect(res.body).toMatchObject({
      error: { code: 'UNSUPPORTED_SOURCE', retryable: false },
    });
  });

  it('strips a smuggled field (forbidNonWhitelisted gives 400)', async () => {
    await request(app.getHttpServer())
      .post('/v1/queries')
      .send({ source: 'chatgpt', prompt: 'hi', executablePath: '/evil' })
      .expect(400);
  });

  it('health check is 200 and exempt', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);

    expect(res.body).toMatchObject({ status: 'ok', browser: true });
  });
});
