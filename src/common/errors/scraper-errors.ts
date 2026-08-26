import { ErrorCode } from './error-codes';

export interface PartialSalvage {
  response_text: string;
  markdown_text: string;
}

export abstract class ScraperError extends Error {
  abstract readonly errorCode: ErrorCode;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnsupportedSourceError extends ScraperError {
  readonly errorCode = ErrorCode.UNSUPPORTED_SOURCE;
  readonly httpStatus = 422;
  readonly retryable = false;
}

export class RateLimitedError extends ScraperError {
  readonly errorCode = ErrorCode.TARGET_RATE_LIMITED;
  readonly httpStatus = 429;
  readonly retryable = false;
}

export class TargetBlockedError extends ScraperError {
  readonly errorCode = ErrorCode.TARGET_BLOCKED;
  readonly httpStatus = 403;
  readonly retryable = false;
}

export class ChallengeError extends ScraperError {
  readonly errorCode = ErrorCode.TARGET_BLOCKED;
  readonly httpStatus = 403;
  readonly retryable = true;

  constructor(
    message: string,
    readonly layer: string,
  ) {
    super(message);
  }
}

export type TimeoutKind = 'navigation' | 'first-byte' | 'wall-clock';

export class TargetTimeoutError extends ScraperError {
  readonly errorCode = ErrorCode.TARGET_TIMEOUT;
  readonly httpStatus = 504;
  readonly retryable: boolean;

  constructor(
    readonly kind: TimeoutKind,
    message: string,
  ) {
    super(message);
    this.retryable = kind !== 'wall-clock';
  }
}

export class PartialResponseError extends ScraperError {
  readonly errorCode = ErrorCode.PARTIAL_RESPONSE;
  readonly httpStatus = 504;
  readonly retryable = false;

  constructor(
    message: string,
    readonly salvage: PartialSalvage,
  ) {
    super(message);
  }
}

export class EmptyResponseError extends ScraperError {
  readonly errorCode = ErrorCode.EMPTY_RESPONSE;
  readonly httpStatus = 502;
  readonly retryable = true;
}

export class ParsingFailedError extends ScraperError {
  readonly errorCode = ErrorCode.PARSING_FAILED;
  readonly httpStatus = 502;
  readonly retryable = false;
}

export class PoolExhaustedError extends ScraperError {
  readonly errorCode = ErrorCode.TARGET_UNAVAILABLE;
  readonly httpStatus = 503;
  readonly retryable = false;
}
