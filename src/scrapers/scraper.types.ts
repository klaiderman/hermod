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

  continueTurn(page: import('patchright').Page, req: ScrapeRequest): AsyncIterable<NormalizedDelta>;

  readModeFor(page: import('patchright').Page): ReadMode;
}
