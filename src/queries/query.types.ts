import { Citation, ReadMode, SourceKey } from '../scrapers/scraper.types';

export interface QueryContent {
  prompt: string;

  response_text: string;

  markdown_text: string | null;

  citations: Citation[];

  llm_model: string | null;

  conversation_id: string | null;

  search_queries: string[];
}

export interface QueryResultItem {
  source: SourceKey;
  content: QueryContent;
  status_code: number;
}

export interface QueryResponse {
  results: QueryResultItem[];
  meta: {
    request_id: string;
    duration_ms: number;
  };
}

export interface EngineResult {
  content: QueryContent;

  attempts: number;
  firstByteLatencyMs: number;
  readMode: ReadMode;
}
