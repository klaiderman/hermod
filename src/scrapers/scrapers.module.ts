import { Module } from '@nestjs/common';
import { BlockDetector } from '../block-detection/block-detector';
import { ChatGptStrategy } from './chatgpt/chatgpt.strategy';
import { ScraperRegistry, SCRAPER_STRATEGIES } from './scraper.registry';
import { ScraperStrategy } from './scraper.types';

@Module({
  providers: [
    BlockDetector,
    ChatGptStrategy,
    {
      provide: SCRAPER_STRATEGIES,
      useFactory: (...strategies: ScraperStrategy[]) => strategies,
      inject: [ChatGptStrategy],
    },
    ScraperRegistry,
  ],
  exports: [ScraperRegistry],
})
export class ScrapersModule {}
