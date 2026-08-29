import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { TaskCancelledError, timeout, TimeoutStrategy } from 'cockatiel';
import { PinoLogger } from 'nestjs-pino';
import type { Page } from 'patchright';
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
import { BlockVerdict, ScrapeRequest, ScraperStrategy } from '../scrapers/scraper.types';
import { Conversation, ConversationManager } from './conversation-manager.service';
import { EngineResult, QueryContent } from './query.types';

@Injectable()
export class ScrapeEngine {
  constructor(
    private readonly registry: ScraperRegistry,
    private readonly pool: ContextPool,
    private readonly conversations: ConversationManager,
    private readonly config: HermodConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ScrapeEngine.name);
  }

  async execute(req: ScrapeRequest): Promise<EngineResult> {
    const strategy = this.registry.get(req.source);

    if (req.conversationId) {
      const session = this.conversations.get(req.conversationId);

      return session
        ? this.continueConversation(strategy, req, session)
        : this.openConversation(strategy, req, req.conversationId);
    }

    return this.openConversation(strategy, req, randomUUID());
  }

  private async openConversation(strategy: ScraperStrategy, req: ScrapeRequest, id: string): Promise<EngineResult> {
    this.conversations.ensureCapacity();

    const policy = buildResiliencePolicy(this.config.retry, this.config.timeouts.wallClockMs);

    let attempts = 0;

    try {
      const outcome = await policy.execute(async ({ signal }) => {
        attempts += 1;
        const context = await this.pool.acquire();
        let page: Page | null = null;
        let opened = false;

        try {
          page = await context.newPage();
          const answer = await this.runFirstTurn(strategy, page, req, attempts);

          if (signal.aborted) {
            throw new TargetTimeoutError('wall-clock', 'Per-request wall-clock budget exceeded.');
          }

          this.conversations.open(id, req.source, context, page);
          opened = true;

          return { answer, readMode: strategy.readModeFor(page) };
        } catch (e) {
          this.logAttemptFailed(req, attempts, e);
          throw e;
        } finally {
          if (!opened) {
            if (page) {
              await page.close().catch(() => undefined);
            }

            await this.pool.destroy(context);
          }
        }
      });

      this.logger.info(
        {
          requestId: req.requestId,
          source: req.source,
          mode: 'open',
          conversationId: id,
          attempts,
          firstByteLatencyMs: outcome.answer.firstByteLatencyMs,
          readMode: outcome.readMode,
          liveConversations: this.conversations.size,
          status: 'ok',
        },
        'conversation opened',
      );

      return {
        content: this.buildContent(req, outcome.answer, id),
        attempts,
        firstByteLatencyMs: outcome.answer.firstByteLatencyMs,
        readMode: outcome.readMode,
      };
    } catch (e) {
      throw this.translateBoundary(e, req, attempts);
    }
  }

  private async continueConversation(
    strategy: ScraperStrategy,
    req: ScrapeRequest,
    session: Conversation,
  ): Promise<EngineResult> {
    this.conversations.markActive(session.id);

    const wallClock = timeout(this.config.timeouts.wallClockMs, TimeoutStrategy.Aggressive);

    try {
      const answer = await wallClock.execute(() => {
        const deltas = strategy.continueTurn(session.page, req);

        return consumeStream(deltas, strategy, session.page, {
          firstByteMs: this.config.timeouts.firstByteMs,
          idleMs: this.config.timeouts.idleMs,
        });
      });

      this.conversations.touch(session.id);

      this.logger.info(
        {
          requestId: req.requestId,
          source: req.source,
          mode: 'continue',
          conversationId: session.id,
          turn: session.turns,
          firstByteLatencyMs: answer.firstByteLatencyMs,
          status: 'ok',
        },
        'conversation continued',
      );

      return {
        content: this.buildContent(req, answer, session.id),
        attempts: 1,
        firstByteLatencyMs: answer.firstByteLatencyMs,
        readMode: strategy.readModeFor(session.page),
      };
    } catch (e) {
      this.logAttemptFailed(req, 1, e);
      throw this.translateBoundary(e, req, 1);
    }
  }

  private async runFirstTurn(
    strategy: ScraperStrategy,
    page: Page,
    req: ScrapeRequest,
    attemptNo: number,
  ): Promise<AccumulatedAnswer> {
    await strategy.prepare(page, req);
    const res = await strategy.submitAndAwaitResponse(page, req);

    const verdict = await strategy.detectBlock(page, res);

    if (verdict.blocked) {
      this.logVerdict(req, attemptNo, verdict);
      throw this.verdictToError(verdict);
    }

    const deltas = strategy.streamDeltas(res, page, req);

    return consumeStream(deltas, strategy, page, {
      firstByteMs: this.config.timeouts.firstByteMs,
      idleMs: this.config.timeouts.idleMs,
    });
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

  private buildContent(req: ScrapeRequest, answer: AccumulatedAnswer, conversationId: string | null): QueryContent {
    if (!req.parse) {
      return {
        prompt: req.prompt,
        response_text: answer.markdown,
        markdown_text: null,
        citations: [],
        llm_model: null,
        conversation_id: conversationId,
        search_queries: [],
      };
    }

    return {
      prompt: req.prompt,
      response_text: stripMarkdown(answer.markdown),
      markdown_text: answer.markdown,
      citations: answer.citations,
      llm_model: answer.model,
      conversation_id: conversationId,
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

  private logAttemptFailed(req: ScrapeRequest, attemptNo: number, e: unknown): void {
    const errorCode = e instanceof ScraperError ? e.errorCode : 'INTERNAL_ERROR';
    const retryable = e instanceof ScraperError ? e.retryable : false;

    this.logger.warn(
      { requestId: req.requestId, source: req.source, attempt: attemptNo, errorCode, retryable },
      'attempt failed',
    );
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
