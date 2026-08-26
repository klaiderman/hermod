import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { chromium } from 'patchright';
import type { Browser, BrowserContext } from 'patchright';
import { HermodConfigService } from '../config/hermod-config.service';

const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
const OFFSCREEN_ARGS = ['--window-position=-32000,-32000', '--window-size=1280,900'];

@Injectable()
export class BrowserManager implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowserManager.name);
  private browser: Browser | null = null;

  constructor(private readonly config: HermodConfigService) {}

  async onModuleInit(): Promise<void> {
    const { headless, executablePath, offscreen } = this.config.browser;
    const args = [...LAUNCH_ARGS];

    if (!headless && offscreen) {
      args.push(...OFFSCREEN_ARGS);
    }

    const options: Parameters<typeof chromium.launch>[0] = { headless, args };

    if (executablePath) {
      options.executablePath = executablePath;
    }

    this.browser = await chromium.launch(options);
    this.logger.log(`Chromium launched (headless=${headless}, offscreen=${!headless && offscreen})`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.logger.log('Chromium closed');
    }
  }

  isAlive(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  async createContext(geo?: string): Promise<BrowserContext> {
    if (!this.browser) {
      throw new Error('Browser not initialised');
    }

    const proxyServer = this.config.resolveProxy(geo);
    const options: Parameters<Browser['newContext']>[0] = {};

    if (proxyServer) {
      options.proxy = { server: proxyServer };
    }

    return this.browser.newContext(options);
  }
}
