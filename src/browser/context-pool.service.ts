import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { BrowserContext } from 'patchright';
import * as genericPool from 'generic-pool';
import { BrowserManager } from './browser-manager.service';
import { HermodConfigService } from '../config/hermod-config.service';
import { PoolExhaustedError } from '../common/errors/scraper-errors';
import { POOL_ACQUIRE_TIMEOUT } from '../common/patterns';

const EVICTION_INTERVAL_MS = 15000;
const IDLE_TIMEOUT_MS = 30000;

@Injectable()
export class ContextPool implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContextPool.name);
  private pool!: genericPool.Pool<BrowserContext>;
  private readonly useCounts = new WeakMap<BrowserContext, number>();

  constructor(
    private readonly manager: BrowserManager,
    private readonly config: HermodConfigService,
  ) {}

  onModuleInit(): void {
    const { max, min, acquireTimeoutMs, maxUses } = this.config.pool;

    const factory: genericPool.Factory<BrowserContext> = {
      create: async () => {
        const ctx = await this.manager.createContext();

        this.useCounts.set(ctx, 0);

        return ctx;
      },
      destroy: async (ctx) => {
        try {
          await ctx.close();
        } catch (e) {
          this.logger.warn(`Context close failed: ${String(e)}`);
        }
      },
      validate: async (ctx) => {
        const alive = ctx.browser()?.isConnected() ?? false;
        const uses = this.useCounts.get(ctx) ?? 0;

        return alive && uses < maxUses;
      },
    };

    this.pool = genericPool.createPool(factory, {
      max,
      min,
      acquireTimeoutMillis: acquireTimeoutMs,
      testOnBorrow: true,
      evictionRunIntervalMillis: EVICTION_INTERVAL_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
      softIdleTimeoutMillis: IDLE_TIMEOUT_MS,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.pool) {
      return;
    }

    await this.pool.drain();
    await this.pool.clear();
  }

  async acquire(): Promise<BrowserContext> {
    try {
      const ctx = await this.pool.acquire();

      this.useCounts.set(ctx, (this.useCounts.get(ctx) ?? 0) + 1);

      return ctx;
    } catch (e) {
      if (e instanceof Error && POOL_ACQUIRE_TIMEOUT.test(e.message)) {
        throw new PoolExhaustedError('All browser contexts are busy; try again shortly.');
      }

      throw e;
    }
  }

  async release(ctx: BrowserContext): Promise<void> {
    try {
      await ctx.clearCookies();
      await ctx.clearPermissions();
    } catch (e) {
      this.logger.warn(`Context cleanup failed; destroying instead: ${String(e)}`);
      await this.destroy(ctx);

      return;
    }

    await this.pool.release(ctx);
  }

  async destroy(ctx: BrowserContext): Promise<void> {
    try {
      await this.pool.destroy(ctx);
    } catch (e) {
      this.logger.warn(`Context destroy failed: ${String(e)}`);
    }
  }

  stats(): { size: number; available: number; borrowed: number; pending: number } {
    return {
      size: this.pool?.size ?? 0,
      available: this.pool?.available ?? 0,
      borrowed: this.pool?.borrowed ?? 0,
      pending: this.pool?.pending ?? 0,
    };
  }
}
