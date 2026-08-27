import { ExponentialBackoff, handleWhen, IPolicy, retry, timeout, TimeoutStrategy, wrap } from 'cockatiel';
import { RetryConfig } from '../../config/hermod-config.service';
import { ScraperError } from '../errors/scraper-errors';

export function isRetryable(error: unknown): boolean {
  return error instanceof ScraperError && error.retryable;
}

export function buildResiliencePolicy(retryCfg: RetryConfig, wallClockMs: number): IPolicy {
  const retryPolicy = retry(handleWhen(isRetryable), {
    maxAttempts: retryCfg.maxAttempts,
    backoff: new ExponentialBackoff({
      initialDelay: retryCfg.backoffInitialMs,
      maxDelay: retryCfg.backoffMaxMs,
    }),
  });

  const wallClock = timeout(wallClockMs, TimeoutStrategy.Aggressive);

  return wrap(wallClock, retryPolicy);
}
