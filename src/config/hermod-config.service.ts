import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvironmentVariables } from './env.validation';

export interface TimeoutConfig {
  navMs: number;
  firstByteMs: number;
  idleMs: number;
  wallClockMs: number;
}

export interface PoolConfig {
  max: number;
  min: number;
  acquireTimeoutMs: number;
  maxUses: number;
}

export interface RetryConfig {
  maxAttempts: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
}

export interface BrowserConfig {
  headless: boolean;
  offscreen: boolean;
  executablePath: string | undefined;
}

@Injectable()
export class HermodConfigService {
  constructor(private readonly config: ConfigService<EnvironmentVariables, true>) {}

  get nodeEnv(): string {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get port(): number {
    return this.config.get('PORT', { infer: true });
  }

  get logLevel(): string {
    return this.config.get('LOG_LEVEL', { infer: true });
  }

  get chatgptBaseUrl(): string {
    return this.config.get('CHATGPT_BASE_URL', { infer: true });
  }

  get browser(): BrowserConfig {
    const path = this.config.get('BROWSER_EXECUTABLE_PATH', { infer: true });

    return {
      headless: this.config.get('HEADLESS', { infer: true }),
      offscreen: this.config.get('HEADFUL_OFFSCREEN', { infer: true }),
      executablePath: path && path.length > 0 ? path : undefined,
    };
  }

  get pool(): PoolConfig {
    return {
      max: this.config.get('POOL_MAX', { infer: true }),
      min: this.config.get('POOL_MIN', { infer: true }),
      acquireTimeoutMs: this.config.get('POOL_ACQUIRE_TIMEOUT_MS', { infer: true }),
      maxUses: this.config.get('CONTEXT_MAX_USES', { infer: true }),
    };
  }

  get timeouts(): TimeoutConfig {
    return {
      navMs: this.config.get('NAV_TIMEOUT_MS', { infer: true }),
      firstByteMs: this.config.get('FIRST_BYTE_MS', { infer: true }),
      idleMs: this.config.get('IDLE_MS', { infer: true }),
      wallClockMs: this.config.get('WALL_CLOCK_MS', { infer: true }),
    };
  }

  get retry(): RetryConfig {
    return {
      maxAttempts: this.config.get('RETRY_MAX_ATTEMPTS', { infer: true }),
      backoffInitialMs: this.config.get('BACKOFF_INITIAL_MS', { infer: true }),
      backoffMaxMs: this.config.get('BACKOFF_MAX_MS', { infer: true }),
    };
  }

  resolveProxy(_geo?: string): string | undefined {
    const url = this.config.get('PROXY_URL', { infer: true });

    return url && url.length > 0 ? url : undefined;
  }
}
