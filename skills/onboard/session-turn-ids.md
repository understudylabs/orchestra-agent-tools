# Session and turn IDs during application setup

Read this alongside the SDK conversion recipe. Connecting a gateway URL does
not identify which requests belong to one task. During setup, discover the
application's execution and turn boundaries, attach their IDs to each relevant
model request, and verify propagation with synthetic local checks.

## Choose the boundaries

| Header | Application meaning | Lifetime |
| --- | --- | --- |
| `x-understudy-session-id` | One conversation or task execution, as defined by the application | Reuse across its model calls, tool continuations, retries, and fallback calls. Start a new ID for a new independent execution. |
| `x-understudy-turn-id` | One logical step within that session, such as a user message and all assistant work it triggers | Reuse across that step's model calls and retries. Change when the next logical step begins. |

A model request or tool-loop iteration is not automatically a new turn. For a
one-shot task, the session has one turn: use the same value for both IDs, or
omit the turn header. Prefer both for applications with multiple turns.
Strongly recommend session IDs for session-level evaluation; online model
experiments require them for stable assignment.

Reuse existing opaque execution/conversation and message/step IDs when their
lifetimes match these definitions. A user/account ID, workload name, or
process-wide constant is not an execution ID. If suitable IDs do not exist,
allocate them at the application entrypoint and logical-turn boundary, then
carry them through the existing context, queue messages, and retry paths.
Persist them with an existing resumable job when necessary; do not regenerate
them inside the model-call helper or on job redelivery.

Both IDs are opaque and case-sensitive, must contain non-whitespace text, and
must fit within 256 UTF-8 bytes. Prefer header-safe ASCII IDs such as UUIDs.
Do not truncate, lowercase, or derive IDs from prompts, email addresses, or
other sensitive content. Neither header signals completion or proves an
outcome. They also do not replace the gateway's per-request
`x-understudy-request-id`; retain that separately when the app already records
request correlation.

Before editing, describe the chosen boundaries, where each ID comes from,
and which call sites will receive them. If the framework cannot propagate
context or the boundary is unresolved, report that gap instead of inventing
IDs per request or claiming complete session attribution.

## Attach at request scope

Keep credentials and base URLs on the shared client. Add session and turn
headers through the installed SDK's per-request options, merging existing
request headers. Never mutate shared client defaults to switch sessions:
concurrent executions can otherwise inherit one another's IDs.

Illustrative TypeScript fragments below use IDs already carried in the
application's context; they do not create IDs inside the inference loop.
Keep the application's existing model, messages, tools, and stream handling.
These fragments assume `existingOptions.headers` is a plain object; if the app
uses `Headers` or header tuples, merge using that representation instead of
object spread.

```ts
const attributionHeaders = {
  "x-understudy-session-id": context.sessionId,
  "x-understudy-turn-id": context.turnId,
};

// OpenAI SDK: the second argument contains transport options, not model input.
const stream = await openai.chat.completions.create(
  { ...existingParams, stream: true },
  { ...existingOptions, headers: { ...existingOptions.headers, ...attributionHeaders } },
);
```

```ts
// Anthropic SDK: keep consuming the stream as the application already does.
const stream = anthropic.messages.stream(
  existingParams,
  { ...existingOptions, headers: { ...existingOptions.headers, ...attributionHeaders } },
);
```

For Vercel AI SDK, use the generation call's `headers` option. For Mastra,
LangChain, LlamaIndex, and other wrappers, inspect the installed version's
supported per-invocation header/context hook and verify that it reaches the
underlying model requests, including tool continuations. Framework memory
thread IDs do not automatically become Understudy headers. Do not invent
framework options or replace a shared client with mutable session defaults.
For raw HTTP, merge into the request's headers using its existing header
representation (`Headers`, tuples, or an object).

## Verify and report

Use a local fake transport or existing integration tests with wholly synthetic
IDs and payloads. Inspect outbound headers and check:

- two calls in one turn, including a tool continuation or retry, retain both IDs;
- the next turn retains the session ID and changes the turn ID;
- a new independent execution changes the session ID;
- interleaved concurrent executions keep their own IDs;
- background jobs, fallbacks, and resumptions preserve the intended context;
- existing authentication, workload headers, payloads, and stream behavior remain
  intact.

Report the boundary mapping, verified call paths, and any missing propagation.
Local checks prove header construction, not hosted capture persistence. If a
bounded live verification is already authorized, inspect the resulting
metadata through the supported capture surface without printing private
payloads; otherwise leave hosted verification explicitly pending.
