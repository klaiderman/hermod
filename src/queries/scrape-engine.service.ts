import { Injectable } from '@nestjs/common';
import { TaskCancelledError } from 'cockatiel';
import { PinoLogger } from 'nestjs-pino';
import type { BrowserContext, Page } from 'patchright';
import { ContextPool } from '../browser/context-pool.service';
import { HermodConfigService } from '../config/hermod-config.service';
import {
  ChallengeError,
  RateLimitedError,
  ScraperError,
  TargetBlockedError,
  TargetTimeoutError,
} from '../common/errors/scraper-errors';
import { buildResiliencePolicy } from '../common/resilience/resilience.policy';
import { ScraperRegistry } from '../scrapers/scraper.registry';
import { stripMarkdown } from '../scrapers/markdown-strip';
import { consumeStream, AccumulatedAnswer } from '../scrapers/stream-consumer';
import { BlockVerdict, ReadMode, ScrapeRequest, ScraperStrategy } from '../scrapers/scraper.types';
import { EngineResult, QueryContent } from './query.types';

@Injectable()
export class ScrapeEngine {
  constructor(
    private readonly registry: ScraperRegistry,
    private readonly pool: ContextPool,
    private readonly config: HermodConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ScrapeEngine.name);
  }

  async execute(req: ScrapeRequest): Promise<EngineResult> {
    const strategy = this.registry.get(req.source);

    const policy = buildResiliencePolicy(this.config.retry, this.config.timeouts.wallClockMs);

    let attempts = 0;
    let firstByteLatencyMs = 0;
    let readMode: ReadMode = 'sse';

    try {
      const answer = await policy.execute(async () => {
        attempts += 1;
        const outcome = await this.runAttempt(strategy, req, attempts);

        firstByteLatencyMs = outcome.answer.firstByteLatencyMs;
        readMode = outcome.readMode;

        return outcome.answer;
      });

      this.logger.info(
        {
          requestId: req.requestId,
          source: req.source,
          attempts,
          firstByteLatencyMs,
          readMode,
          status: 'ok',
          ...this.pool.stats(),
        },
        'query completed',
      );

      return {
        content: this.buildContent(req, answer),
        attempts,
        firstByteLatencyMs,
        readMode,
      };
    } catch (e) {
      throw this.translateBoundary(e, req, attempts);
    }
  }

  private async runAttempt(
    strategy: ScraperStrategy,
    req: ScrapeRequest,
    attemptNo: number,
  ): Promise<{ answer: AccumulatedAnswer; readMode: ReadMode }> {
    const ctx: BrowserContext = await this.pool.acquire();
    let poisoned = false;
    let page: Page | null = null;

    try {
      page = await ctx.newPage();
      await strategy.prepare(page, req);
      const res = await strategy.submitAndAwaitResponse(page, req);

      const verdict = await strategy.detectBlock(page, res);

      if (verdict.blocked) {
        this.logVerdict(req, attemptNo, verdict);
        throw this.verdictToError(verdict);
      }

      const deltas = strategy.streamDeltas(res, page, req);
      const answer = await consumeStream(deltas, strategy, page, {
        firstByteMs: this.config.timeouts.firstByteMs,
        idleMs: this.config.timeouts.idleMs,
      });

      return { answer, readMode: strategy.readModeFor(page) };
    } catch (e) {
      poisoned = true;
      const errorCode = e instanceof ScraperError ? e.errorCode : 'INTERNAL_ERROR';
      const retryable = e instanceof ScraperError ? e.retryable : false;

      this.logger.warn(
        { requestId: req.requestId, source: req.source, attempt: attemptNo, errorCode, retryable },
        'attempt failed',
      );
      throw e;
    } finally {
      if (page) {
        await page.close().catch(() => undefined);
      }

      if (poisoned) {
        await this.pool.destroy(ctx);
      } else {
        await this.pool.release(ctx);
      }
    }
  }

  private verdictToError(verdict: BlockVerdict): ScraperError {
    switch (verdict.reason) {
      case 'rate-limited':
        return new RateLimitedError('The target rate-limited the request.');
      case 'challenge':
        return new ChallengeError('The target returned a challenge instead of an answer.', verdict.layer);
      case 'blocked':
        return new TargetBlockedError('The target blocked the request.');
      default:
        return new TargetBlockedError('The target returned an unrecognised blocking response.');
    }
  }

  private buildContent(req: ScrapeRequest, answer: AccumulatedAnswer): QueryContent {
    if (!req.parse) {
      return {
        prompt: req.prompt,
        response_text: answer.markdown,
        markdown_text: null,
        citations: [],
        llm_model: null,
        conversation_id: null,
        search_queries: [],
      };
    }

    return {
      prompt: req.prompt,
      response_text: stripMarkdown(answer.markdown),
      markdown_text: answer.markdown,
      citations: answer.citations,
      llm_model: answer.model,
      conversation_id: answer.conversationId,
      search_queries: answer.searchQueries,
    };
  }

  private translateBoundary(e: unknown, req: ScrapeRequest, attempts: number): Error {
    if (e instanceof TaskCancelledError) {
      this.logger.warn(
        {
          requestId: req.requestId,
          source: req.source,
          attempts,
          errorCode: 'TARGET_TIMEOUT',
          kind: 'wall-clock',
        },
        'wall-clock budget exceeded',
      );

      return new TargetTimeoutError('wall-clock', 'Per-request wall-clock budget exceeded.');
    }

    if (e instanceof ChallengeError) {
      this.logger.warn(
        { requestId: req.requestId, source: req.source, attempts, errorCode: 'TARGET_BLOCKED' },
        'challenge persisted across the retry budget; surfacing as confirmed block',
      );

      return new TargetBlockedError('The target challenge persisted across all retries.');
    }

    return e instanceof Error ? e : new Error(String(e));
  }

  private logVerdict(req: ScrapeRequest, attemptNo: number, verdict: BlockVerdict): void {
    this.logger.warn(
      {
        requestId: req.requestId,
        source: req.source,
        attempt: attemptNo,
        block: { blocked: verdict.blocked, reason: verdict.reason, layer: verdict.layer },
      },
      'block verdict',
    );
  }
}
