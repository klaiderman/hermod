import { Inject, Injectable } from '@nestjs/common';
import { UnsupportedSourceError } from '../common/errors/scraper-errors';
import { ScraperStrategy, SourceKey } from './scraper.types';

export const SCRAPER_STRATEGIES = Symbol('SCRAPER_STRATEGIES');

@Injectable()
export class ScraperRegistry {
  private readonly bySource: Map<SourceKey, ScraperStrategy>;

  constructor(@Inject(SCRAPER_STRATEGIES) strategies: ScraperStrategy[]) {
    this.bySource = new Map(strategies.map((s) => [s.source, s]));
  }

  get(source: SourceKey): ScraperStrategy {
    const strategy = this.bySource.get(source);

    if (!strategy) {
      throw new UnsupportedSourceError(`Source '${source}' is not supported by this deployment.`);
    }

    return strategy;
  }

  supportedSources(): SourceKey[] {
    return [...this.bySource.keys()];
  }
}
