export const BODY_MARKERS: readonly string[] = [
  'unusual traffic',
  'verify you are human',
  'are you a robot',
  'checking your browser',
  'enable javascript and cookies to continue',
  'access denied',
  'sorry, you have been blocked',
  'attention required',
  'ray id',
];

export const CHALLENGE_SELECTORS: readonly string[] = [
  'iframe[src*="challenges.cloudflare.com"]',
  '.cf-turnstile',
  '#challenge-form',
  '#cf-challenge-running',
  'iframe[title*="verification" i]',
];

export const CONFIRMED_BLOCK_STATUSES: readonly number[] = [403, 503];

export const RATE_LIMIT_STATUS = 429;
