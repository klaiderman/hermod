import type { Page } from 'patchright';
import { BlockDetector } from '../../src/block-detection/block-detector';
import { CHALLENGE_SELECTORS } from '../../src/block-detection/block-markers';

function fakePage(opts: { challengeSelectors?: string[]; title?: string; body?: string }): Page {
  const challenge = new Set(opts.challengeSelectors ?? []);

  return {
    locator: (selector: string) => ({
      count: async () => (challenge.has(selector) ? 1 : 0),
      innerText: async () => (selector === 'body' ? (opts.body ?? '') : ''),
    }),
    title: async () => opts.title ?? '',
  } as unknown as Page;
}

describe('BlockDetector', () => {
  const detector = new BlockDetector();

  describe('fromStatus (transport layer)', () => {
    it('classifies 429 as rate-limited', () => {
      expect(detector.fromStatus(429)).toMatchObject({ blocked: true, reason: 'rate-limited' });
    });
    it('classifies 403 and 503 as blocked', () => {
      expect(detector.fromStatus(403)).toMatchObject({ blocked: true, reason: 'blocked' });
      expect(detector.fromStatus(503)).toMatchObject({ blocked: true, reason: 'blocked' });
    });
    it('does not block a 200', () => {
      expect(detector.fromStatus(200)).toMatchObject({ blocked: false, reason: 'none' });
    });
  });

  describe('fromPage (content + DOM layers)', () => {
    it('detects a challenge widget (DOM layer)', async () => {
      const page = fakePage({ challengeSelectors: [CHALLENGE_SELECTORS[0] as string] });

      expect(await detector.fromPage(page)).toMatchObject({
        blocked: true,
        reason: 'challenge',
        layer: 'behavioral',
      });
    });

    it('detects a content marker (title/body)', async () => {
      const page = fakePage({
        title: 'Just a moment...',
        body: 'Checking your browser before you continue',
      });

      expect(await detector.fromPage(page)).toMatchObject({
        blocked: true,
        reason: 'challenge',
        layer: 'content',
      });
    });

    it('returns honest UNKNOWN when nothing matches (never a silent pass)', async () => {
      const page = fakePage({ title: 'ChatGPT', body: 'The three largest countries are...' });

      expect(await detector.fromPage(page)).toMatchObject({ blocked: false, reason: 'unknown' });
    });
  });

  describe('classify (a 200-challenge is TARGET_BLOCKED, never a success)', () => {
    it('treats HTML where an event-stream was expected as a challenge', async () => {
      const page = fakePage({ challengeSelectors: [CHALLENGE_SELECTORS[0] as string] });
      const verdict = await detector.classify(page, 200, 'text/html; charset=utf-8', true);

      expect(verdict).toMatchObject({ blocked: true, reason: 'challenge' });
    });

    it('passes a genuine event-stream 200 through', async () => {
      const page = fakePage({});
      const verdict = await detector.classify(page, 200, 'text/event-stream', true);

      expect(verdict).toMatchObject({ blocked: false, reason: 'none' });
    });
  });
});
