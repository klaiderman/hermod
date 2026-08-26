import { LEADING_SINGLE_SPACE, LINE_BREAK, SSE_EVENT_BOUNDARY } from '../common/patterns';
import { NormalizedDelta } from './scraper.types';

const DATA_FIELD_PREFIX = 'data:';

export interface MappedEvent {
  text: string;
  citations?: NormalizedDelta['citations'];
  model?: string | null;
  conversationId?: string | null;
  searchQueries?: string[];
}

export interface SseAccessors {
  readonly doneSentinel: string;

  mapEvent(payload: unknown, index: number): MappedEvent | null;
}

export interface SseEvent {
  data: string;
}

export class SseFramer {
  private buffer = '';

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let boundary = this.buffer.search(SSE_EVENT_BOUNDARY);

    while (boundary !== -1) {
      const rawEvent = this.buffer.slice(0, boundary);

      const match = SSE_EVENT_BOUNDARY.exec(this.buffer.slice(boundary));
      const boundaryLen = match ? match[0].length : 2;

      this.buffer = this.buffer.slice(boundary + boundaryLen);
      const event = this.frameOne(rawEvent);

      if (event) {
        events.push(event);
      }

      boundary = this.buffer.search(SSE_EVENT_BOUNDARY);
    }

    return events;
  }

  flush(): SseEvent[] {
    const rest = this.buffer;

    this.buffer = '';
    const event = this.frameOne(rest);

    return event ? [event] : [];
  }

  private frameOne(rawEvent: string): SseEvent | null {
    const dataParts: string[] = [];

    for (const line of rawEvent.split(LINE_BREAK)) {
      if (line.startsWith(DATA_FIELD_PREFIX)) {
        dataParts.push(line.slice(DATA_FIELD_PREFIX.length).replace(LEADING_SINGLE_SPACE, ''));
      }
    }

    if (dataParts.length === 0) {
      return null;
    }

    return { data: dataParts.join('\n') };
  }
}

export async function* parseSseStream(
  rawChunks: AsyncIterable<string>,
  accessors: SseAccessors,
): AsyncIterable<NormalizedDelta> {
  const framer = new SseFramer();
  let index = 0;

  const handle = function* (event: SseEvent): Generator<NormalizedDelta> {
    const data = event.data.trim();

    if (data.length === 0) {
      return;
    }

    if (data === accessors.doneSentinel) {
      yield { index: index++, text: '', done: true };

      return;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    const mapped = accessors.mapEvent(payload, index);

    if (!mapped) {
      return;
    }

    const delta: NormalizedDelta = { index: index++, text: mapped.text, done: false };

    if (mapped.citations && mapped.citations.length > 0) {
      delta.citations = mapped.citations;
    }

    if (mapped.model !== undefined) {
      delta.model = mapped.model;
    }

    if (mapped.conversationId !== undefined) {
      delta.conversationId = mapped.conversationId;
    }

    if (mapped.searchQueries && mapped.searchQueries.length > 0) {
      delta.searchQueries = mapped.searchQueries;
    }

    yield delta;
  };

  for await (const chunk of rawChunks) {
    for (const event of framer.push(chunk)) {
      for (const delta of handle(event)) {
        yield delta;

        if (delta.done) {
          return;
        }
      }
    }
  }

  for (const event of framer.flush()) {
    for (const delta of handle(event)) {
      yield delta;

      if (delta.done) {
        return;
      }
    }
  }
}

export async function* stringToChunks(raw: string, chunkSize = Number.POSITIVE_INFINITY): AsyncIterable<string> {
  if (!Number.isFinite(chunkSize)) {
    yield raw;

    return;
  }

  for (let i = 0; i < raw.length; i += chunkSize) {
    yield raw.slice(i, i + chunkSize);
  }
}
