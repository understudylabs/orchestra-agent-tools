# Setup Code

Use this recipe when `understudy setup-code` routes here or when the developer
asks an agent to convert application code to Understudy gateway inference.

The CLI no longer rewrites source files directly. The coding agent owns the
patch using the repo's language, framework, tests, and style.

## Flow

1. Run `understudy status --json`.
2. If not authenticated, stop with:
   `Run 'understudy login' once, then re-run me.`
3. Inspect the target file if one was provided by `setup-code --file`.
4. Otherwise search for SDK construction and explicit provider base URLs:
   `OpenAI`, `Anthropic`, `baseURL`, `base_url`, `api.openai.com`,
   `api.anthropic.com`, `@ai-sdk/openai`, `@ai-sdk/anthropic`.
5. Load the matching recipe:
   - `openai-typescript.md`
   - `anthropic-typescript.md`
   - `mastra-typescript.md`
   - `universal-typescript.md`
6. Read [session-turn-ids.md](session-turn-ids.md). Identify the application's
   session and logical-turn boundaries, reuse suitable existing IDs, and plan
   their propagation through model calls, tool continuations, retries, and jobs.
7. Patch the smallest source region that routes calls through
   `UNDERSTUDY_API_KEY` and `UNDERSTUDY_GATEWAY_URL`.
   Attach `x-understudy-session-id` and, for multi-turn sessions,
   `x-understudy-turn-id` through per-request options; do not mutate a shared
   client's default headers.
8. Preserve the developer's existing upstream provider key variable. Do not
   delete or rename it.
9. Make every call site that now routes through the gateway stream
   (`stream: true` or the client's streaming call form), aggregating locally
   where the caller needs one final object. Each recipe has an "After the
   patch — make gateway calls stream" / "Gateway calls must stream" section
   with the why and the per-client pattern.
10. Run the narrowest local test or typecheck that proves the patched code still
    loads, and the synthetic header-propagation checks in
    [session-turn-ids.md](session-turn-ids.md). Report unresolved boundaries or
    unsupported propagation paths rather than claiming complete attribution.

## Output

End with:

- files changed;
- command used to verify;
- whether auth is configured;
- session/turn boundary mapping, verified propagation, and remaining gaps;
- exact command the developer or agent should run through `understudy run`.
