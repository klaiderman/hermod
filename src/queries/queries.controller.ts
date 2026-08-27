import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScrapeRequest } from '../scrapers/scraper.types';
import { CreateQueryDto } from './dto/create-query.dto';
import { ScrapeEngine } from './scrape-engine.service';
import { QueryResponse } from './query.types';

type RequestWithId = Request & { id?: string };

@Controller('v1/queries')
export class QueriesController {
  constructor(private readonly engine: ScrapeEngine) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() dto: CreateQueryDto, @Req() req: RequestWithId): Promise<QueryResponse> {
    const startedAt = Date.now();
    const requestId = req.id ?? 'unknown';

    const scrapeRequest: ScrapeRequest = {
      source: dto.source,
      prompt: dto.prompt,
      parse: dto.parse,
      requestId,
    };

    if (dto.geo_location !== undefined) {
      scrapeRequest.geoLocation = dto.geo_location;
    }

    const result = await this.engine.execute(scrapeRequest);

    return {
      results: [
        {
          source: dto.source,
          content: result.content,
          status_code: 200,
        },
      ],
      meta: {
        request_id: requestId,
        duration_ms: Date.now() - startedAt,
      },
    };
  }
}
