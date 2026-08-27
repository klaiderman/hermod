import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { Browser } from 'patchright';
import {
  CHATGPT,
  chatgptResponsePredicate,
  createChatGptSseAccessors,
} from '../../src/scrapers/chatgpt/chatgpt.accessors';
import { parseSseStream, stringToChunks } from '../../src/scrapers/sse-accumulator';
import { NormalizedDelta } from '../../src/scrapers/scraper.types';

const fixture = readFileSync(join(__dirname, '..', 'fixtures', 'valid-stream.sse.txt'), 'utf8');

describe('SSE response capture (real browser, stubbed network)', () => {
  let browser: Browser | null = null;

  beforeAll(async () => {
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    } catch (e) {
      console.warn(`[skip] Chromium unavailable; run \`npx patchright install chromium\`. ${String(e)}`);
      browser = null;
    }
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  it('intercepts the answer response and frames it into normalized deltas', async () => {
    if (!browser) {
      return;
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    await context.route('https://chatgpt.com/', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body><script>fetch('${CHATGPT.conversationUrlFragment}')</script></body></html>`,
      });
    });
    await context.route(`**${CHATGPT.conversationUrlFragment}`, async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: fixture });
    });

    const responsePromise = page.waitForResponse(chatgptResponsePredicate, { timeout: 15000 });

    await page.goto('https://chatgpt.com/');
    const response = await responsePromise;

    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/event-stream');

    const body = await response.text();
    const deltas: NormalizedDelta[] = [];

    for await (const d of parseSseStream(stringToChunks(body), createChatGptSseAccessors())) {
      deltas.push(d);
    }

    expect(deltas[deltas.length - 1]?.done).toBe(true);
    expect(deltas.map((d) => d.text).join('')).toContain('**Russia**');
    expect(deltas.find((d) => d.model)?.model).toBe('gpt-4o-mini');
    const citation = deltas.flatMap((d) => d.citations ?? [])[0];

    expect(citation?.url).toBe('https://example.com/eu-population');

    await context.close();
  });
});
