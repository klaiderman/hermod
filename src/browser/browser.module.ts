import { Module } from '@nestjs/common';
import { BrowserManager } from './browser-manager.service';
import { ContextPool } from './context-pool.service';

@Module({
  providers: [BrowserManager, ContextPool],
  exports: [BrowserManager, ContextPool],
})
export class BrowserModule {}
