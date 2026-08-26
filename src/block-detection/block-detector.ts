import { Injectable } from '@nestjs/common';
import type { Page } from 'patchright';
import { BlockVerdict } from '../scrapers/scraper.types';
import { BODY_MARKERS, CHALLENGE_SELECTORS, CONFIRMED_BLOCK_STATUSES, RATE_LIMIT_STATUS } from './block-markers';

const BODY_READ_TIMEOUT_MS = 1000;
const BODY_READ_MAX_CHARS = 4000;

@Injectable()
export class BlockDetector {
  fromStatus(status: number): BlockVerdict {
    if (status === RATE_LIMIT_STATUS) {
      return { blocked: true, reason: 'rate-limited', layer: 'transport', detail: 'HTTP 429' };
    }

    if (CONFIRMED_BLOCK_STATUSES.includes(status)) {
      return { blocked: true, reason: 'blocked', layer: 'transport', detail: `HTTP ${status}` };
    }

    return { blocked: false, reason: 'none', layer: 'none' };
  }

  async fromPage(page: Page): Promise<BlockVerdict> {
    for (const selector of CHALLENGE_SELECTORS) {
      try {
        if ((await page.locator(selector).count()) > 0) {
          return {
            blocked: true,
            reason: 'challenge',
            layer: 'behavioral',
            detail: `challenge widget: ${selector}`,
          };
        }
      } catch {}
    }

    try {
      const haystack = `${await safeTitle(page)}\n${await safeBodyText(page)}`.toLowerCase();

      for (const marker of BODY_MARKERS) {
        if (haystack.includes(marker)) {
          return {
            blocked: true,
            reason: 'challenge',
            layer: 'content',
            detail: `body marker: "${marker}"`,
          };
        }
      }
    } catch {}

    return { blocked: false, reason: 'unknown', layer: 'none' };
  }

  async classify(page: Page, status: number, contentType: string, expectedStream: boolean): Promise<BlockVerdict> {
    const byStatus = this.fromStatus(status);

    if (byStatus.blocked) {
      return byStatus;
    }

    const looksHtml = contentType.toLowerCase().includes('text/html');

    if (expectedStream && looksHtml) {
      const byPage = await this.fromPage(page);

      if (byPage.blocked) {
        return byPage;
      }

      return {
        blocked: true,
        reason: 'challenge',
        layer: 'content',
        detail: 'HTML where an event-stream was expected',
      };
    }

    return { blocked: false, reason: 'none', layer: 'none' };
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

async function safeBodyText(page: Page): Promise<string> {
  try {
    return (await page.locator('body').innerText({ timeout: BODY_READ_TIMEOUT_MS })).slice(0, BODY_READ_MAX_CHARS);
  } catch {
    return '';
  }
}
