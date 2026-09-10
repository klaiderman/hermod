import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { Browser } from 'patchright';
import { BlockDetector } from '../../src/block-detection/block-detector';
import { CHATGPT } from '../../src/scrapers/chatgpt/chatgpt.accessors';
import { ChatGptStrategy } from '../../src/scrapers/chatgpt/chatgpt.strategy';
import type { HermodConfigService } from '../../src/config/hermod-config.service';

const read = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');

describe('Block detection + DOM fallback (real browser)', () => {
  let browser: Browser | null = null;
  const detector = new BlockDetector();

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

  it('classifies a 200 challenge page as a challenge (never a success)', async () => {
    if (!browser) {
      return;
    }

    const page = await browser.newPage();

    await page.setContent(read('challenge-200.html'));
    const verdict = await detector.fromPage(page);

    expect(verdict).toMatchObject({ blocked: true, reason: 'challenge' });
    await page.close();
  });

  // Regression: a prompt about blocking language used to make the service classify
  // its own input as a Cloudflare block, because the marker scan read the whole body
  // and the prompt is in the body. The strategy's appPresent() probe is the gate.
  it('does not treat a marker inside the conversation as a block (real selectors)', async () => {
    if (!browser) {
      return;
    }

    const page = await browser.newPage();

    await page.setContent(read('prompt-with-marker.dom.html'));

    const strategy = new ChatGptStrategy({} as HermodConfigService, detector);
    const appPresent = await strategy.appPresent(page);

    expect(appPresent).toBe(true);
    expect(await detector.fromPage(page, appPresent)).toMatchObject({ blocked: false, reason: 'none' });

    // Same DOM, gate off: proves the marker really is there and the gate is what saves it.
    expect(await detector.fromPage(page, false)).toMatchObject({ blocked: true, layer: 'content' });

    await page.close();
  });

  it('reports appPresent false on a challenge interstitial', async () => {
    if (!browser) {
      return;
    }

    const page = await browser.newPage();

    await page.setContent(read('challenge-200.html'));

    const strategy = new ChatGptStrategy({} as HermodConfigService, detector);

    expect(await strategy.appPresent(page)).toBe(false);
    await page.close();
  });

  it('reads the settled assistant answer via the DOM-fallback selector', async () => {
    if (!browser) {
      return;
    }

    const page = await browser.newPage();

    await page.setContent(read('valid-answer.dom.html'));
    const text = await page.locator(CHATGPT.assistantMessageSelector).last().innerText();

    expect(text).toContain('Russia, Germany, and the United Kingdom');
    await page.close();
  });
});
