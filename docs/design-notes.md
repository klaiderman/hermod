# Design notes

The reasoning behind the choices that aren't obvious from the code, why the answer is read the way it is, how blocking is turned into a typed outcome, and the things a live run taught me that a fixture never would.

## Why a real browser, and why the site's own JavaScript

Signed-out ChatGPT gates the conversation flow behind challenge JavaScript: OpenAI **Sentinel** (a proof-of-work `chat-requirements` prepare→finalize handshake), a short-lived **`conduit_token`** JWT, and a **Cloudflare Turnstile** widget. Reimplementing that crypto in Node is both out of scope and a losing bet, it breaks on OpenAI's next deploy. A real browser running the site's *own* obfuscated JavaScript clears all of it for free, and it stays working when the internals change. That is the load-bearing decision: **let their code solve their challenge, then read the result.**

## The surface the live spike actually found

The classic anonymous surface everyone writes about (`/backend-anon/conversation`, a `text/event-stream` of JSON deltas ending in `[DONE]`) is *not* what signed-out `chatgpt.com` serves today. Driving it live, the site hands back the **`unauth-mweb`** (unauthenticated mobile-web) experience:

- the composer is a `<textarea>`; the send control is `button[aria-label="Send"]`;
- the turn is gated by `/unauth-mweb/sentinel/chat-requirements/{prepare,finalize}` and `/unauth-mweb/conversation/prepare`, which returns the `conduit_token`;
- **the answer is not a JSON event-stream.** It arrives as `text/vnd.openai.web-mobile-partial+html` and is rendered token-by-token straight into the DOM.

So the primary read for this surface is an **incremental DOM read** of the assistant turn, keyed on `data-message-role="assistant"`, a stable data attribute, since the visible class is a rotating CSS-module hash. Reading the growing text as ordered deltas has a nice property: the engine's first-byte and inter-delta idle timers become genuinely meaningful (first rendered token = first byte, the gap between renders = idle). The SSE-JSON parser is kept and unit-tested for the authenticated `/backend-api/conversation` event-stream surface; the strategy routes to it when the intercepted response really is an event-stream.

Every one of those specifics (endpoint fragment, selectors, the SSE field accessors) lives in one file (`src/scrapers/chatgpt/chatgpt.accessors.ts`), because OpenAI rotates them and nothing else in the codebase should care when they move.

## Patchright disables the in-page tee

My first design for true streaming was an in-page tee: an init-script that patches `window.fetch` to clone the response `ReadableStream` and forward chunks to Node over an exposed binding. It captured nothing. The cause is a real finding: **Patchright's stealth hardening disables `page.addInitScript` and `page.exposeFunction`**, because both rely on CDP calls (`addScriptToEvaluateOnNewDocument`, `Runtime.addBinding`) that are detectable automation tells, the exact leaks Patchright exists to close. Verified directly: an init-script that sets a `window` flag never runs; the flag reads `false`. The DOM read sidesteps this entirely. If the event-stream surface ever needs true streaming, the path is CDP `Fetch.takeResponseBodyAsStream`, not the tee.

## No window vs. headless

Headless (`--headless`) and "no window" are not the same thing. Headless Chromium has intrinsic fingerprint tells (no GPU, so WebGL reports SwiftShader; a headless User-Agent; `window.outerHeight === 0`) that Turnstile keys on, and no stealth patch removes them. Confirmed live: headful returns the answer in ~5s; the identical request headless is challenged, which the tool correctly classifies (`TARGET_BLOCKED` → fresh-context retries → `TARGET_TIMEOUT`) rather than faking. The right way to run windowless is a **real headful browser on a virtual display (Xvfb)**, no window, real fingerprint, passes. That is the Docker default (`xvfb-run`), and `HEADFUL_OFFSCREEN=true` is the desktop equivalent (a real window rendered off-screen). Chasing headless past the challenge by spoofing the GPU/screen would be reactive evasion, which is deliberately out of scope.

## Completion is decided by the terminal signal, never by "we stopped listening"

The strategy detects the stream's done-signal; the engine decides whether the answer is complete. That split matters:

- terminal marker seen, at least one content delta → **complete**;
- terminal marker seen, zero content → `EMPTY_RESPONSE`;
- stream closed with no terminal marker → `PARTIAL_RESPONSE`, and the accumulated text is returned as salvage, never relabelled as success.

A partial is a typed `504` carrying `partial: { response_text, markdown_text }`, a caller must never silently consume 60% of an answer as if it were whole.

## The four timers

Four timers, four physically different failures, four typed errors:

| timer | bounds | on expiry |
|---|---|---|
| per-navigation | Playwright's own `goto` / response headers | navigation `TARGET_TIMEOUT` (retryable) |
| first-byte | response obtained → first rendered token | inspect the page: a challenge → retryable `ChallengeError`, else first-byte `TARGET_TIMEOUT` |
| inter-delta idle | max gap once the answer started | `PARTIAL_RESPONSE` with salvage |
| wall-clock | the whole request, across *all* retries | `TARGET_TIMEOUT` (not retried) |

The wall-clock is one outer `cockatiel` timeout wrapping the retries and is never cleared once streaming starts, so endpoint latency is bounded and never `retries × wall-clock`. The first-byte and idle timers are manual typed timers rather than `cockatiel` timeouts, because a `cockatiel` timeout throws `TaskCancelledError`, which the retry filter wouldn't match, it would never retry.

## Retries: transient only, and a confirmed block is terminal

The retry filter matches a single flag, `error.retryable`, and exactly the transient errors set it: challenge, navigation-timeout, first-byte-timeout, empty-response. Everything terminal (invalid request, unsupported source, rate-limited, confirmed block, parse failure, partial response, wall-clock timeout) does not. Each retry runs on a **fresh context** (the poisoned one is destroyed on release, since blocks are stateful), with exponential jittered backoff so concurrent retries decorrelate. A `403`/`503` is a confirmed block and terminal, retrying it aggressively is evasion-by-persistence. Only an ambiguous `200`-challenge is retried; if it outlasts the budget it surfaces as a plain `TARGET_BLOCKED`. There is deliberately no circuit breaker: for one process a per-target short-circuit is enough, and a full breaker is unjustified complexity here.

## Error taxonomy

The full `code` → HTTP → retryable mapping is the [error table in the README](../README.md#using-it). Two subtleties behind it:

`retryable` is the thrower's causal truth, not a function of the HTTP code, which is why a navigation `TARGET_TIMEOUT` is retryable and a wall-clock `TARGET_TIMEOUT` is not, same code, same 504. The retry filter keys on that flag alone, so the filter and the table can never drift.

A model **refusal** ("I can't help with that") is a valid `200` answer, not a block, the detector only fires on anti-bot signals, never on answer content. When something is off but no detection layer matches, the verdict is an honest `unknown`, never a silent pass.

## Concurrency

One long-lived Chromium; a `generic-pool` of incognito **contexts** is the concurrency control. `max` is the hard cap; over it, requests wait up to an acquire budget and then get `TARGET_UNAVAILABLE` (503) rather than an unbounded fan-out of browsers. A healthy context is cleaned (cookies/permissions cleared) and released; a poisoned one is destroyed so the next retry starts fresh. Contexts retire after a set number of uses.

## Geo / proxy

`geo_location` is validated but inert. Proxy selection has one seam, `HermodConfigService.resolveProxy(geo)`, consumed where a browser context is created, wiring a provider there is the only change needed to make geographic routing real. Documented limitation, not hidden behaviour.

## Why signed-out Gemini isn't implemented

Gemini isn't built, and the registry is source-agnostic, so a request for it (or any unknown source) returns `422 UNSUPPORTED_SOURCE`. Signed-out Gemini is Flash-only, its `SNlM0e` request token is unstable, and every reliable client path needs the `__Secure-1PSID` account cookie, which crosses the no-login boundary. Taking the required target (ChatGPT) to a high bar beats taking two to mediocre, and the investigation is itself part of the deliverable. Adding it later is one strategy file plus one provider line, with no engine changes.
