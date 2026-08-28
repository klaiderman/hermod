import { Injectable } from '@nestjs/common';
import type { Page, Response } from 'patchright';
import { BlockDetector } from '../../block-detection/block-detector';
import { HermodConfigService } from '../../config/hermod-config.service';
import { ChallengeError, EmptyResponseError, TargetTimeoutError } from '../../common/errors/scraper-errors';
import { CONVERSATION_ID_IN_URL } from '../../common/patterns';
import { parseSseStream } from '../sse-accumulator';
import {
  BlockVerdict,
  NormalizedDelta,
  ReadMode,
  ScrapeRequest,
  ScraperStrategy,
  StrategyResponse,
} from '../scraper.types';
import { CHATGPT, chatgptResponsePredicate, createChatGptSseAccessors, stripAttribution } from './chatgpt.accessors';

const DOM_POLL_MS = 400;
const DOM_SETTLE_MS = 1800;
const POST_GEN_DRAIN_MS = 1200;
const DOM_READ_TIMEOUT_MS = 1500;
const EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';

function isEventStream(contentType: string): boolean {
  return contentType.toLowerCase().includes(EVENT_STREAM_CONTENT_TYPE);
}

@Injectable()
export class ChatGptStrategy implements ScraperStrategy {
  readonly source = 'chatgpt';
  private readonly readModes = new WeakMap<Page, ReadMode>();

  constructor(
    private readonly config: HermodConfigService,
    private readonly detector: BlockDetector,
  ) {}

  async prepare(page: Page, _req: ScrapeRequest): Promise<void> {
    const nav = this.config.timeouts.navMs;

    try {
      await page.goto(this.config.chatgptBaseUrl, { timeout: nav, waitUntil: 'domcontentloaded' });
    } catch (e) {
      if (isPlaywrightTimeout(e)) {
        throw new TargetTimeoutError('navigation', 'Navigation to target timed out');
      }

      throw e;
    }
  }

  async submitAndAwaitResponse(page: Page, req: ScrapeRequest): Promise<StrategyResponse> {
    const nav = this.config.timeouts.navMs;

    const responsePromise = page.waitForResponse(chatgptResponsePredicate, { timeout: nav }).catch(() => null);

    try {
      await this.submitPrompt(page, req.prompt);
    } catch (e) {
      if (isPlaywrightTimeout(e)) {
        const verdict = await this.detector.fromPage(page);

        if (verdict.blocked && verdict.reason === 'challenge') {
          throw new ChallengeError('Challenge/interstitial blocked prompt submission', verdict.layer);
        }

        throw new TargetTimeoutError('navigation', 'Prompt composer did not become available');
      }

      throw e;
    }

    const response: Response | null = await responsePromise;
    const status = response?.status() ?? 200;
    const contentType = response?.headers()['content-type'] ?? '';

    let body = '';

    if (response && isEventStream(contentType)) {
      try {
        body = await response.text();
      } catch (e) {
        throw new EmptyResponseError(`Failed to read the answer stream: ${String(e)}`);
      }
    }

    return {
      status,
      contentType,
      rawChunks: async function* () {
        if (body.length > 0) {
          yield body;
        }
      },
    };
  }

  async *streamDeltas(res: StrategyResponse, page: Page, _req: ScrapeRequest): AsyncIterable<NormalizedDelta> {
    if (isEventStream(res.contentType)) {
      this.readModes.set(page, 'sse');
      yield* parseSseStream(res.rawChunks(), createChatGptSseAccessors());

      return;
    }

    this.readModes.set(page, 'dom');
    yield* this.domStream(page);
  }

  async *continueTurn(page: Page, req: ScrapeRequest): AsyncIterable<NormalizedDelta> {
    const baseline = await page.locator(CHATGPT.assistantMessageSelector).count();

    await this.submitPrompt(page, req.prompt);
    this.readModes.set(page, 'dom');
    yield* this.domStream(page, baseline);
  }

  async detectBlock(page: Page, res: StrategyResponse | null): Promise<BlockVerdict> {
    if (res) {
      const byStatus = this.detector.fromStatus(res.status);

      if (byStatus.blocked) {
        return byStatus;
      }
    }

    return this.detector.fromPage(page);
  }

  readModeFor(page: Page): ReadMode {
    return this.readModes.get(page) ?? 'dom';
  }

  private async submitPrompt(page: Page, prompt: string): Promise<void> {
    const composer = page.locator(CHATGPT.composerSelector).first();

    await composer.click();
    await composer.fill(prompt);

    const sendButton = page.locator(CHATGPT.sendButtonSelector).first();

    if ((await sendButton.count()) > 0) {
      await sendButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
  }

  private async *domStream(page: Page, baselineTurns = 0): AsyncIterable<NormalizedDelta> {
    if (!(await this.waitForNewTurn(page, baselineTurns))) {
      return;
    }

    const answer = page.locator(CHATGPT.assistantMessageSelector).last();
    const stopButton = page.locator(CHATGPT.stopButtonSelector);

    let emitted = '';
    let index = 0;
    let stableMs = 0;
    let endedMs = 0;
    let sawGenerating = false;
    const hardCap = this.config.timeouts.wallClockMs;
    let elapsed = 0;

    for (;;) {
      const raw = await answer.innerText({ timeout: DOM_READ_TIMEOUT_MS }).catch(() => '');
      const text = stripAttribution(raw);

      if (text === emitted || text.length === 0) {
        stableMs += DOM_POLL_MS;
      } else if (text.startsWith(emitted)) {
        const increment = text.slice(emitted.length);

        emitted = text;
        stableMs = 0;
        yield { index: index++, text: increment, done: false };
      } else {
        emitted = text;
        stableMs = 0;
        yield { index: index++, text, done: false, reset: true };
      }

      const generating = (await stopButton.count()) > 0;

      if (generating) {
        sawGenerating = true;
        endedMs = 0;
      } else if (sawGenerating) {
        endedMs += DOM_POLL_MS;
      }

      const finished = sawGenerating ? endedMs >= POST_GEN_DRAIN_MS : emitted.length > 0 && stableMs >= DOM_SETTLE_MS;

      if (finished) {
        const match = CONVERSATION_ID_IN_URL.exec(page.url());

        yield { index: index++, text: '', done: true, conversationId: match?.[1] ?? null };

        return;
      }

      if (elapsed >= hardCap) {
        return;
      }

      await page.waitForTimeout(DOM_POLL_MS);
      elapsed += DOM_POLL_MS;
    }
  }

  private async waitForNewTurn(page: Page, baselineTurns: number): Promise<boolean> {
    const answers = page.locator(CHATGPT.assistantMessageSelector);
    const deadline = Date.now() + this.config.timeouts.firstByteMs;

    for (;;) {
      if ((await answers.count()) > baselineTurns) {
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await page.waitForTimeout(DOM_POLL_MS);
    }
  }
}

function isPlaywrightTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === 'TimeoutError';
}
