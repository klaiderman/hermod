import { Module } from '@nestjs/common';
import { BrowserModule } from '../browser/browser.module';
import { ScrapersModule } from '../scrapers/scrapers.module';
import { ConversationManager } from './conversation-manager.service';
import { QueriesController } from './queries.controller';
import { ScrapeEngine } from './scrape-engine.service';

@Module({
  imports: [BrowserModule, ScrapersModule],
  controllers: [QueriesController],
  providers: [ScrapeEngine, ConversationManager],
})
export class QueriesModule {}
