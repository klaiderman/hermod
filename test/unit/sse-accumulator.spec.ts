import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ParsingFailedError } from '../../src/common/errors/scraper-errors';
import { createChatGptSseAccessors } from '../../src/scrapers/chatgpt/chatgpt.accessors';
import { parseSseStream, SseFramer, stringToChunks } from '../../src/scrapers/sse-accumulator';
import { NormalizedDelta } from '../../src/scrapers/scraper.types';

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');

async function collect(raw: string, chunkSize = Number.POSITIVE_INFINITY): Promise<NormalizedDelta[]> {
  const out: NormalizedDelta[] = [];

  for await (const d of parseSseStream(stringToChunks(raw, chunkSize), createChatGptSseAccessors())) {
    out.push(d);
  }

  return out;
}

describe('SseFramer', () => {
  it('concatenates consecutive data: lines within one event', () => {
    const framer = new SseFramer();
    const events = framer.push('data: line one\ndata: line two\n\n');

    expect(events).toEqual([{ data: 'line one\nline two' }]);
  });

  it('buffers a partial event until the boundary arrives across chunks', () => {
    const framer = new SseFramer();

    expect(framer.push('data: hel')).toEqual([]);
    expect(framer.push('lo\n\n')).toEqual([{ data: 'hello' }]);
  });

  it('ignores non-data lines (event:/id:/comments)', () => {
    const framer = new SseFramer();
    const events = framer.push('event: delta\nid: 7\ndata: payload\n\n');

    expect(events).toEqual([{ data: 'payload' }]);
  });
});

describe('parseSseStream (ChatGPT accessors)', () => {
  it('accumulates a valid stream into ordered deltas + terminal marker', async () => {
    const deltas = await collect(fixture('valid-stream.sse.txt'));

    const terminal = deltas[deltas.length - 1];

    expect(terminal?.done).toBe(true);

    const markdown = deltas.map((d) => d.text).join('');

    expect(markdown).toContain('The three largest countries in Europe by population are **Russia**');

    const model = deltas.find((d) => d.model)?.model;

    expect(model).toBe('gpt-4o-mini');
    const citation = deltas.flatMap((d) => d.citations ?? [])[0];

    expect(citation).toEqual({
      title: 'Europe population figures',
      url: 'https://example.com/eu-population',
    });
  });

  it('is invariant to chunk boundaries (mid-event splits)', async () => {
    const whole = await collect(fixture('valid-stream.sse.txt'));
    const chunked = await collect(fixture('valid-stream.sse.txt'), 7);

    expect(chunked.map((d) => d.text).join('')).toBe(whole.map((d) => d.text).join(''));
    expect(chunked[chunked.length - 1]?.done).toBe(true);
  });

  it('checks the [DONE] sentinel BEFORE JSON.parse (no crash on the marker)', async () => {
    const deltas = await collect('data: [DONE]\n\n');

    expect(deltas).toEqual([{ index: 0, text: '', done: true }]);
  });

  it('yields a terminal marker with zero content for an empty stream', async () => {
    const deltas = await collect(fixture('empty-stream.sse.txt'));

    expect(deltas[deltas.length - 1]?.done).toBe(true);
    const content = deltas.filter((d) => d.text.length > 0);

    expect(content).toHaveLength(0);
  });

  it('skips an unparseable JSON frame and ends without a terminal marker (partial upstream)', async () => {
    const deltas = await collect(fixture('malformed-stream.sse.txt'));

    expect(deltas.some((d) => d.done)).toBe(false);
    expect(deltas.map((d) => d.text).join('')).toBe('Here is a partial answer that starts fine');
  });

  it('throws ParsingFailedError on a valid-JSON but schema-violating payload', async () => {
    await expect(collect(fixture('malformed-payload.sse.txt'))).rejects.toBeInstanceOf(ParsingFailedError);
  });
});
