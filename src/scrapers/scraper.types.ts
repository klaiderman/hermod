export type SourceKey = string;

export interface Citation {
  title?: string;
  url: string;
}

export interface NormalizedDelta {
  index: number;
  text: string;
  done: boolean;
  reset?: boolean;
  citations?: Citation[];
  model?: string | null;
  conversationId?: string | null;
  searchQueries?: string[];
}

export type BlockReason = 'none' | 'rate-limited' | 'blocked' | 'challenge' | 'unknown';

export type BlockLayer = 'none' | 'transport' | 'content' | 'behavioral';

export interface BlockVerdict {
  blocked: boolean;
  reason: BlockReason;
  layer: BlockLayer;

  detail?: string;
}

export interface ScrapeRequest {
  source: SourceKey;
  prompt: string;
  parse: boolean;
  geoLocation?: string;
  conversationId?: string;
  requestId: string;
}

export interface StrategyResponse {
  status: number;
  contentType: string;
  rawChunks(): AsyncIterable<string>;
}

export type ReadMode = 'sse' | 'dom';

export interface ScraperStrategy {
  readonly source: SourceKey;

  prepare(page: import('patchright').Page, req: ScrapeRequest): Promise<void>;

  submitAndAwaitResponse(page: import('patchright').Page, req: ScrapeRequest): Promise<StrategyResponse>;

  streamDeltas(
    res: StrategyResponse,
    page: import('patchright').Page,
    req: ScrapeRequest,
  ): AsyncIterable<NormalizedDelta>;

  detectBlock(page: import('patchright').Page, res: StrategyResponse | null): Promise<BlockVerdict>;

  /**
   * Did the target's own application UI render on this page? Block detection needs
   * this to tell a challenge interstitial apart from the app itself: once the app
   * is up, its body text is conversation content, and matching block markers
   * against it lets a caller's prompt classify its own request as blocked.
   */
  appPresent(page: import('patchright').Page): Promise<boolean>;

  continueTurn(page: import('patchright').Page, req: ScrapeRequest): AsyncIterable<NormalizedDelta>;

  readModeFor(page: import('patchright').Page): ReadMode;
}
