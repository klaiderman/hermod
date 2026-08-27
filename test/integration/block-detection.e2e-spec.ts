import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'patchright';
import type { Browser } from 'patchright';
import { BlockDetector } from '../../src/block-detection/block-detector';
import { CHATGPT } from '../../src/scrapers/chatgpt/chatgpt.accessors';

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
