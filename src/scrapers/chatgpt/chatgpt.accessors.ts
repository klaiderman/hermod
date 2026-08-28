import type { Response } from 'patchright';
import { ParsingFailedError } from '../../common/errors/scraper-errors';
import { Citation } from '../scraper.types';
import { MappedEvent, SseAccessors } from '../sse-accumulator';

export const CHATGPT = {
  conversationUrlFragment: '/conversation/',

  doneSentinel: '[DONE]',

  composerSelector: 'textarea, #prompt-textarea, div[contenteditable="true"]',

  sendButtonSelector: 'button[aria-label*="Send" i], [data-testid="send-button"]',

  stopButtonSelector: 'button[aria-label*="Stop" i], [data-testid="stop-button"]',

  assistantMessageSelector: '[data-message-role="assistant"], [data-message-author-role="assistant"]',

  attributionPrefix: 'ChatGPT said:',
} as const;

export function chatgptResponsePredicate(res: Response): boolean {
  return res.url().includes(CHATGPT.conversationUrlFragment);
}

export function stripAttribution(text: string): string {
  const trimmed = text.trimStart();

  if (trimmed.startsWith(CHATGPT.attributionPrefix)) {
    return trimmed.slice(CHATGPT.attributionPrefix.length).trimStart();
  }

  return text.trim();
}

export function createChatGptSseAccessors(): SseAccessors {
  let lastText = '';

  return {
    doneSentinel: CHATGPT.doneSentinel,
    mapEvent(payload: unknown) {
      const message = readMessage(payload);

      if (!message) {
        return null;
      }

      const fullText = readAssistantText(message);

      if (fullText === null) {
        return null;
      }

      const increment = fullText.startsWith(lastText) ? fullText.slice(lastText.length) : fullText;

      lastText = fullText;

      const citations = readCitations(message);
      const model = readModelSlug(message);
      const conversationId = readConversationId(payload);
      const searchQueries = readSearchQueries(message);

      const out: MappedEvent = { text: increment };

      if (citations.length > 0) {
        out.citations = citations;
      }

      if (model !== undefined) {
        out.model = model;
      }

      if (conversationId !== undefined) {
        out.conversationId = conversationId;
      }

      if (searchQueries.length > 0) {
        out.searchQueries = searchQueries;
      }

      return out;
    },
  };
}

interface AnonMessage {
  author?: { role?: string };
  content?: { content_type?: string; parts?: unknown[] };
  metadata?: { model_slug?: string; citations?: unknown[]; search_queries?: unknown[] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readMessage(payload: unknown): AnonMessage | null {
  if (!isRecord(payload)) {
    return null;
  }

  const message = payload['message'];

  if (!isRecord(message)) {
    return null;
  }

  return message as AnonMessage;
}

function readAssistantText(message: AnonMessage): string | null {
  if (message.author?.role && message.author.role !== 'assistant') {
    return null;
  }

  const content = message.content;

  if (!content || content.content_type !== 'text') {
    return null;
  }

  const parts = content.parts;

  if (parts === undefined) {
    return null;
  }

  if (!Array.isArray(parts)) {
    throw new ParsingFailedError('Assistant message `parts` was not an array.');
  }

  return parts.filter((p): p is string => typeof p === 'string').join('');
}

function readCitations(message: AnonMessage): Citation[] {
  const raw = message.metadata?.citations;

  if (!Array.isArray(raw)) {
    return [];
  }

  const out: Citation[] = [];

  for (const c of raw) {
    if (!isRecord(c)) {
      continue;
    }

    const meta = isRecord(c['metadata']) ? (c['metadata'] as Record<string, unknown>) : c;
    const url = meta['url'];

    if (typeof url !== 'string' || url.length === 0) {
      continue;
    }

    const title = meta['title'];

    out.push(typeof title === 'string' ? { title, url } : { url });
  }

  return out;
}

function readModelSlug(message: AnonMessage): string | null | undefined {
  const slug = message.metadata?.model_slug;

  if (typeof slug === 'string' && slug.length > 0) {
    return slug;
  }

  return undefined;
}

function readConversationId(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const id = payload['conversation_id'];

  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function readSearchQueries(message: AnonMessage): string[] {
  const raw = message.metadata?.search_queries;

  if (!Array.isArray(raw)) {
    return [];
  }

  const out: string[] = [];

  for (const q of raw) {
    if (typeof q === 'string' && q.length > 0) {
      out.push(q);
    } else if (isRecord(q) && typeof q['q'] === 'string' && q['q'].length > 0) {
      out.push(q['q']);
    }
  }

  return out;
}
