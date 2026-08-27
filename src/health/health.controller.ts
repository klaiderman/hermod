import { Controller, Get } from '@nestjs/common';
import { BrowserManager } from '../browser/browser-manager.service';
import { ContextPool } from '../browser/context-pool.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly browser: BrowserManager,
    private readonly pool: ContextPool,
  ) {}

  @Get()
  check(): { status: 'ok'; browser: boolean; pool: ReturnType<ContextPool['stats']> } {
    return {
      status: 'ok',
      browser: this.browser.isAlive(),
      pool: this.pool.stats(),
    };
  }
}
