import { Module } from '@nestjs/common';
import { BrowserModule } from '../browser/browser.module';
import { HealthController } from './health.controller';

@Module({
  imports: [BrowserModule],
  controllers: [HealthController],
})
export class HealthModule {}
