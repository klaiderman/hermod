import type { Page } from 'patchright';
import {
  ChallengeError,
  EmptyResponseError,
  PartialResponseError,
  PartialSalvage,
  ScraperError,
  TargetTimeoutError,
} from '../common/errors/scraper-errors';
import { stripMarkdown } from './markdown-strip';
import { Citation, NormalizedDelta, ScraperStrategy } from './scraper.types';

export interface StreamTimeouts {
  firstByteMs: number;
  idleMs: number;
}

export interface AccumulatedAnswer {
  markdown: string;
  citations: Citation[];
  model: string | null;
  conversationId: string | null;
  searchQueries: string[];
  contentDeltas: number;
  firstByteLatencyMs: number;
}

const TIMEOUT = Symbol('timeout');

export async function consumeStream(
  deltas: AsyncIterable<NormalizedDelta>,
  strategy: ScraperStrategy,
  page: Page,
  timeouts: StreamTimeouts,
  now: () => number = Date.now,
): Promise<AccumulatedAnswer> {
  const acc = new Accumulator();
  const it = deltas[Symbol.asyncIterator]();
  const startedAt = now();
  let started = false;
  let firstByteLatencyMs = 0;
  let terminal = false;

  for (;;) {
    const budget = started ? timeouts.idleMs : timeouts.firstByteMs;
    const nextP = it.next();

    let step: IteratorResult<NormalizedDelta> | typeof TIMEOUT;

    try {
      step = await raceNext(nextP, budget);
    } catch (streamErr) {
      if (streamErr instanceof ScraperError) {
        throw streamErr;
      }

      if (started) {
        throw new PartialResponseError('Stream errored after first byte', acc.salvage());
      }

      throw streamErr;
    }

    if (step === TIMEOUT) {
      if (!started) {
        throw await firstByteFailure(strategy, page);
      }

      throw new PartialResponseError('Stream idle beyond guard after first byte', acc.salvage());
    }

    if (step.done) {
      break;
    }

    const delta = step.value;

    if (!started) {
      started = true;
      firstByteLatencyMs = now() - startedAt;
    }

    if (delta.text.length > 0) {
      acc.add(delta);
    } else {
      acc.addMetadata(delta);
    }

    if (delta.done) {
      terminal = true;
      break;
    }
  }

  acc.firstByteLatencyMs = firstByteLatencyMs;

  if (terminal) {
    if (acc.contentDeltas === 0) {
      throw new EmptyResponseError('Stream reached its terminal marker with zero content');
    }

    return acc.snapshot();
  }

  if (!started) {
    throw await firstByteFailure(strategy, page);
  }

  throw new PartialResponseError('Stream closed before the terminal done-marker', acc.salvage());
}

async function firstByteFailure(strategy: ScraperStrategy, page: Page): Promise<Error> {
  const verdict = await strategy.detectBlock(page, null);

  if (verdict.blocked && verdict.reason === 'challenge') {
    return new ChallengeError('Challenge detected while awaiting the first delta', verdict.layer);
  }

  return new TargetTimeoutError('first-byte', 'No answer delta before the first-byte timeout');
}

function raceNext(
  p: Promise<IteratorResult<NormalizedDelta>>,
  ms: number,
): Promise<IteratorResult<NormalizedDelta> | typeof TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void p.catch(() => undefined);
      resolve(TIMEOUT);
    }, ms);

    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

class Accumulator {
  markdown = '';
  citations: Citation[] = [];
  model: string | null = null;
  conversationId: string | null = null;
  searchQueries: string[] = [];
  contentDeltas = 0;
  firstByteLatencyMs = 0;
  private readonly seenCitationUrls = new Set<string>();
  private readonly seenSearchQueries = new Set<string>();

  add(delta: NormalizedDelta): void {
    if (delta.reset) {
      this.markdown = delta.text;
    } else {
      this.markdown += delta.text;
    }

    this.contentDeltas++;
    this.addMetadata(delta);
  }

  addMetadata(delta: NormalizedDelta): void {
    if (delta.citations) {
      for (const c of delta.citations) {
        if (!this.seenCitationUrls.has(c.url)) {
          this.seenCitationUrls.add(c.url);
          this.citations.push(c);
        }
      }
    }

    if (this.model === null && typeof delta.model === 'string' && delta.model.length > 0) {
      this.model = delta.model;
    }

    if (this.conversationId === null && typeof delta.conversationId === 'string' && delta.conversationId.length > 0) {
      this.conversationId = delta.conversationId;
    }

    if (delta.searchQueries) {
      for (const q of delta.searchQueries) {
        if (q.length > 0 && !this.seenSearchQueries.has(q)) {
          this.seenSearchQueries.add(q);
          this.searchQueries.push(q);
        }
      }
    }
  }

  salvage(): PartialSalvage {
    return { response_text: stripMarkdown(this.markdown), markdown_text: this.markdown };
  }

  snapshot(): AccumulatedAnswer {
    return {
      markdown: this.markdown,
      citations: this.citations,
      model: this.model,
      conversationId: this.conversationId,
      searchQueries: this.searchQueries,
      contentDeltas: this.contentDeltas,
      firstByteLatencyMs: this.firstByteLatencyMs,
    };
  }
}
