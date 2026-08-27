import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module';
import { HermodConfigService } from './config/hermod-config.service';
import { buildLoggerParams } from './common/logging/logger.config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { BrowserModule } from './browser/browser.module';
import { ScrapersModule } from './scrapers/scrapers.module';
import { QueriesModule } from './queries/queries.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [HermodConfigService],
      useFactory: (config: HermodConfigService) => buildLoggerParams(config),
    }),
    BrowserModule,
    ScrapersModule,
    QueriesModule,
    HealthModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
