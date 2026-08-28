const LINE_BREAK_SOURCE = String.raw`\r?\n`;

export const LINE_BREAK = new RegExp(LINE_BREAK_SOURCE);

export const SSE_EVENT_BOUNDARY = new RegExp(LINE_BREAK_SOURCE + LINE_BREAK_SOURCE);

export const LEADING_SINGLE_SPACE = /^ /;

export const POOL_ACQUIRE_TIMEOUT = /timed out/i;

export const CONVERSATION_ID_IN_URL = /\/c\/([0-9a-f-]{16,})/i;

export type MarkdownStripRule = [RegExp, (substring: string, ...groups: string[]) => string];

const drop = (): string => '';
const toSpace = (): string => ' ';
const keepFirst = (_m: string, first: string): string => first;
const keepSecond = (_m: string, _first: string, second: string): string => second;

const toApostrophe = (): string => "'";
const toQuote = (): string => '"';
const toHyphen = (): string => '-';
const toEllipsis = (): string => '...';

const PRIVATE_USE = new RegExp('[\\uE000-\\uF8FF]', 'g');
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'g');
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const NON_BREAKING_SPACE = new RegExp('[\\u00A0\\u202F]', 'g');
const SMART_SINGLE_QUOTE = new RegExp('[\\u2018\\u2019\\u201A\\u201B\\u2032]', 'g');
const SMART_DOUBLE_QUOTE = new RegExp('[\\u201C\\u201D\\u201E\\u201F\\u2033]', 'g');
const DASH = new RegExp('[\\u2013\\u2014\\u2015]', 'g');
const ELLIPSIS = new RegExp('[\\u2026]', 'g');

export const MARKDOWN_STRIP_RULES: MarkdownStripRule[] = [
  [PRIVATE_USE, drop],
  [ZERO_WIDTH, drop],
  [CONTROL_CHARS, drop],
  [NON_BREAKING_SPACE, toSpace],
  [SMART_SINGLE_QUOTE, toApostrophe],
  [SMART_DOUBLE_QUOTE, toQuote],
  [DASH, toHyphen],
  [ELLIPSIS, toEllipsis],
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
