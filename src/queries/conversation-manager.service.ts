import { Injectable, Logger, Optional, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { BrowserContext, Page } from 'patchright';
import { ContextPool } from '../browser/context-pool.service';
import { HermodConfigService } from '../config/hermod-config.service';

const SWEEP_INTERVAL_MS = 30000;

export interface Conversation {
  id: string;
  source: string;
  context: BrowserContext;
  page: Page;
  turns: number;
  lastUsedAt: number;
}

@Injectable()
export class ConversationManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConversationManager.name);
  private readonly sessions = new Map<string, Conversation>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pool: ContextPool,
    private readonly config: HermodConfigService,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  onModuleInit(): void {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }

    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  get size(): number {
    return this.sessions.size;
  }

  get(id: string): Conversation | undefined {
    const session = this.sessions.get(id);

    if (!session) {
      return undefined;
    }

    if (this.now() - session.lastUsedAt > this.config.conversation.ttlMs || session.page.isClosed()) {
      void this.close(id);

      return undefined;
    }

    return session;
  }

  ensureCapacity(): void {
    while (this.sessions.size >= this.config.conversation.max) {
      const oldest = this.oldest();

      if (!oldest) {
        return;
      }

      this.logger.log(`Evicting oldest conversation to free a context: ${oldest.id}`);
      void this.close(oldest.id);
    }
  }

  open(id: string, source: string, context: BrowserContext, page: Page): string {
    this.sessions.set(id, { id, source, context, page, turns: 1, lastUsedAt: this.now() });
    this.logger.log(`Conversation opened: ${id} (live=${this.sessions.size})`);

    return id;
  }

  touch(id: string): void {
    const session = this.sessions.get(id);

    if (session) {
      session.turns += 1;
      session.lastUsedAt = this.now();
    }
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);

    if (!session) {
      return;
    }

    this.sessions.delete(id);

    await session.page.close().catch(() => undefined);
    await this.pool.destroy(session.context);
    this.logger.log(`Conversation closed: ${id} (live=${this.sessions.size})`);
  }

  private oldest(): Conversation | null {
    let oldest: Conversation | null = null;

    for (const session of this.sessions.values()) {
      if (!oldest || session.lastUsedAt < oldest.lastUsedAt) {
        oldest = session;
      }
    }

    return oldest;
  }

  private async sweep(): Promise<void> {
    const ttl = this.config.conversation.ttlMs;
    const stale: string[] = [];

    for (const session of this.sessions.values()) {
      if (this.now() - session.lastUsedAt > ttl || session.page.isClosed()) {
        stale.push(session.id);
      }
    }

    await Promise.all(stale.map((id) => this.close(id)));
  }
}
