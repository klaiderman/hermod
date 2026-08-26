const LINE_BREAK_SOURCE = String.raw`\r?\n`;

export const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE);

export const SSE_EVENT_BOUNDARY = new RegExp(LINE_BREAK_SOURCE + LINE_BREAK_SOURCE);

export const LEADING_SINGLE_SPACE = /^ /;

export const POOL_ACQUIRE_TIMEOUT = /timed out/i;

export const CONVERSATION_ID_IN_URL = /\/c\/([0-9a-f-]{16,})/i;

export type MarkdownStripRule = [RegExp, (substring: string, ...groups: string[]) => string];

const drop = (): string => '';
const keepFirst = (_m: string, first: string): string => first;
const keepSecond = (_m: string, _first: string, second: string): string => second;

export const MARKDOWN_STRIP_RULES: MarkdownStripRule[] = [
  [/```[^\n]*\n([\s\S]*?)```/g, keepFirst],
  [/~~~[^\n]*\n([\s\S]*?)~~~/g, keepFirst],
  [/!\[([^\]]*)\]\([^)]*\)/g, keepFirst],
  [/\[([^\]]+)\]\([^)]*\)/g, keepFirst],
  [/^[ \t]{0,3}#{1,6}[ \t]+/gm, drop],
  [/^[ \t]{0,3}>[ \t]?/gm, drop],
  [/^[ \t]{0,3}[-*+][ \t]+/gm, drop],
  [/^[ \t]{0,3}\d+[.)][ \t]+/gm, drop],
  [/^[ \t]{0,3}([-*_])(?:[ \t]?\1){2,}[ \t]*$/gm, drop],
  [/(\*\*|__)(.*?)\1/g, keepSecond],
  [/(\*|_)(.*?)\1/g, keepSecond],
  [/~~(.*?)~~/g, keepFirst],
  [/`([^`]+)`/g, keepFirst],
  [/[ \t]+$/gm, drop],
  [/\n{3,}/g, () => '\n\n'],
];
