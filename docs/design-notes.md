# Design notes

The reasoning behind the choices that aren't obvious from the code, why the answer is read the way it is, how blocking is turned into a typed outcome, and the things a live run taught me that a fixture never would.

## Why a real browser, and why the site's own JavaScript

Signed-out ChatGPT gates the conversation flow behind challenge JavaScript: OpenAI **Sentinel** (a proof-of-work `chat-requirements` prepare→finalize handshake), a short-lived **`conduit_token`** JWT, and a **Cloudflare Turnstile** widget. Reimplementing that crypto in Node is both out of scope and a losing bet, it breaks on OpenAI's next deploy. A real browser running the site's _own_ obfuscated JavaScript clears all of it for free, and it stays working when the internals change. That is the load-bearing decision: **let their code solve their challenge, then read the result.**

## The surface the live spike actually found

The classic anonymous surface everyone writes about (`/backend-anon/conversation`, a `text/event-stream` of JSON deltas ending in `[DONE]`) is _not_ what signed-out `chatgpt.com` serves today. Driving it live, the site hands back the **`unauth-mweb`** (unauthenticated mobile-web) experience:

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

## The DOM completion signal, and why text-stillness is not it

For the SSE surface the done-signal is the `[DONE]` marker. For the DOM surface there is no such marker, so the first cut inferred completion from text-stability: if the answer text stopped changing for a settle window, call it done. A live run broke that. A prompt that triggered the web-search tool returned `"Searching the web"` as the answer: the tool renders a status placeholder, it sat still longer than the settle window, and the reader declared victory on the placeholder before the real answer arrived.

A DOM spike showed the two honest signals. First, the page has its own **generating control** (a `Stop` button, `button[aria-label*="Stop"]`) that is present exactly while the model is producing a turn and vanishes when it genuinely stops, tool calls included. Second, when the real answer arrives it **replaces** the placeholder as a wholesale, non-prefix change, whereas ordinary streaming only ever appends (each read is a prefix of the next). So completion now keys on the generating control, never on stillness: while `Stop` is present the reader never finishes, and once it clears the reader drains briefly to let the final DOM settle. A non-prefix change emits a `reset` delta that tells the accumulator to discard what it had and restart from the new text, so any tool or status placeholder, in any wording or language, is dropped when the real answer lands. There are deliberately no hard-coded placeholder strings: a string list would be English-only and would rot on the next UI reword, while the structural signals do not. If generation ends with no real content (a signed-out search that yields nothing), the terminal marker fires with zero content and the turn is an honest `EMPTY_RESPONSE`, never a placeholder dressed up as an answer.

## The four timers

Four timers, four physically different failures, four typed errors:

| timer            | bounds                                     | on expiry                                                                                    |
| ---------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| per-navigation   | Playwright's own `goto` / response headers | navigation `TARGET_TIMEOUT` (retryable)                                                      |
| first-byte       | response obtained → first rendered token   | inspect the page: a challenge → retryable `ChallengeError`, else first-byte `TARGET_TIMEOUT` |
| inter-delta idle | max gap once the answer started            | `PARTIAL_RESPONSE` with salvage                                                              |
| wall-clock       | the whole request, across _all_ retries    | `TARGET_TIMEOUT` (not retried)                                                               |

The wall-clock is one outer `cockatiel` timeout wrapping the retries and is never cleared once streaming starts, so endpoint latency is bounded and never `retries × wall-clock`. The first-byte and idle timers are manual typed timers rather than `cockatiel` timeouts, because a `cockatiel` timeout throws `TaskCancelledError`, which the retry filter wouldn't match, it would never retry.

## Retries: transient only, and a confirmed block is terminal

The retry filter matches a single flag, `error.retryable`, and exactly the transient errors set it: challenge, navigation-timeout, first-byte-timeout, empty-response. Everything terminal (invalid request, unsupported source, rate-limited, confirmed block, parse failure, partial response, wall-clock timeout) does not. Each retry runs on a **fresh context** (the poisoned one is destroyed on release, since blocks are stateful), with exponential jittered backoff so concurrent retries decorrelate. A `403`/`503` is a confirmed block and terminal, retrying it aggressively is evasion-by-persistence. Only an ambiguous `200`-challenge is retried; if it outlasts the budget it surfaces as a plain `TARGET_BLOCKED`. There is deliberately no circuit breaker: for one process a per-target short-circuit is enough, and a full breaker is unjustified complexity here.

## Error taxonomy

The full `code` → HTTP → retryable mapping is the [error table in the README](../README.md#using-it). Two subtleties behind it:

`retryable` is the thrower's causal truth, not a function of the HTTP code, which is why a navigation `TARGET_TIMEOUT` is retryable and a wall-clock `TARGET_TIMEOUT` is not, same code, same 504. The retry filter keys on that flag alone, so the filter and the table can never drift.

A model **refusal** ("I can't help with that") is a valid `200` answer, not a block, the detector only fires on anti-bot signals, never on answer content. When something is off but no detection layer matches, the verdict is an honest `unknown`, never a silent pass.

## Concurrency

One long-lived Chromium; a `generic-pool` of incognito **contexts** is the concurrency control. `max` is the hard cap; over it, requests wait up to an acquire budget and then get `TARGET_UNAVAILABLE` (503) rather than an unbounded fan-out of browsers. A poisoned attempt (a block or challenge) destroys its context so the next retry starts on a fresh one. On success the context is not returned to the pool; it becomes the conversation's held context (see below) and is destroyed only when the conversation closes, so `max` bounds live conversations plus in-flight opens together.

## Conversations

Every response carries a `conversation_id`. If the caller omits it the engine mints one (`randomUUID`) and returns it; a brand-new isolated context is opened for it. If the caller sends an id the engine continues that chat, or opens a new one under that id if it has never seen it (or it has since expired). Continuing types the follow-up into the same page and reads the answer back, so ChatGPT's own front end supplies the context, Hermod stores only the handle.

The follow-up read is turn-count aware: before submitting, it records how many assistant turns are on the page, then waits for the count to exceed that baseline before reading, so it captures the _new_ answer rather than re-reading the previous one.

State is deliberately ephemeral and in-memory. A `ConversationManager` holds `id -> { context, page, lastUsedAt }`; a sweeper closes anything idle past `CONVERSATION_TTL_MS`, and opening past capacity evicts the least-recently-used one (capacity mirrors `POOL_MAX`, since each live conversation holds a pooled context). Closing a conversation shuts its page and destroys its context. Nothing is persisted: a restart, a crash, a TTL lapse, or an eviction ends the chat, and reusing the id then transparently starts fresh. This is single-process by construction, several replicas would need sticky routing or a shared session map, which is the durable-resume roadmap item. The alternative, a full browser process per chat, buys OS-level isolation that a separate context already provides, at roughly 100 to 200 MB and a launch per conversation, so it was not worth it here.

## Geo / proxy

`geo_location` is validated but inert. Proxy selection has one seam, `HermodConfigService.resolveProxy(geo)`, consumed where a browser context is created, wiring a provider there is the only change needed to make geographic routing real. Documented limitation, not hidden behaviour.

## Why signed-out Gemini isn't implemented

Gemini isn't built, and the registry is source-agnostic, so a request for it (or any unknown source) returns `422 UNSUPPORTED_SOURCE`. Signed-out Gemini is Flash-only, its `SNlM0e` request token is unstable, and every reliable client path needs the `__Secure-1PSID` account cookie, which crosses the no-login boundary. Taking the required target (ChatGPT) to a high bar beats taking two to mediocre, and the investigation is itself part of the deliverable. Adding it later is one strategy file plus one provider line, with no engine changes.
