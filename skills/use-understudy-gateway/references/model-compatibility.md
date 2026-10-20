# Model and endpoint compatibility

Check the exact model and endpoint before spending on a sweep. These GPT-6
rules were checked against official OpenAI documentation on 2026-10-19; refresh
that documentation when using another model or diagnosing changed behavior.

## OpenAI GPT-6 request settings

- Chat Completions: use `max_completion_tokens`, not legacy `max_tokens`, for
  GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and GPT-6.1 Sol. The limit includes visible
  output and reasoning tokens. Do not send both fields.
- Responses: use `max_output_tokens` and `reasoning.effort`; Chat uses
  `reasoning_effort`. Do not copy a Chat request body into Responses unchanged.
- Astra and GPT-6.1 Sol: use Responses for tool calling. They do not support
  reasoning effort `none`; use a documented supported effort such as `low`.
- GPT-6 Sol and Luna: Chat function calling requires `reasoning_effort: "none"`.
  Use Responses when the workload needs reasoning with tools.
- With reasoning effort other than `none`, omit `temperature`, `top_p`, and
  `top_logprobs`; for Chat, also omit `logprobs`. For Responses, omit
  `message.output_text.logprobs` from `include`.
- Preserve the workload's intended reasoning and tool behavior. If candidates
  need different effort or endpoint settings, record them. If adapting changes
  the evaluation contract, report a separate diagnostic rather than silently
  treating the arms as equivalent.

Understudy has a native managed OpenAI Responses relay at `/v1/responses` and
`/v1/responses/compact`. Availability is account/configuration dependent; the
Chat catalog alone does not prove Responses access. Probe the intended endpoint
with a small synthetic request under the authorized run budget. Do not silently
switch to Chat if Responses is unavailable and the workload requires its tools.
The native relay is separate from Chat catalog routing and Backup; do not assume
Chat routing controls or cross-provider selection apply to it.

## Verify what actually ran

Managed Chat recovery can return HTTP 200 with `model: "understudy-backup"`
after the primary provider rejects request parameters. A successful transport
response is not evidence that the requested model accepted the request.

For each request, record `x-understudy-request-id`, `x-understudy-route`, and
`x-understudy-effective-model` when available. Inspect the JSON `model` or SSE
model fields as well; for Responses, inspect the terminal response's `model`.
If headers are absent, use the returned model. If identity is missing or sources
conflict, mark it unverified and investigate instead of assuming a match. Do not
use a model's self-description as identity evidence. Only accept documented
aliases/snapshots as equivalent, recording the mapping.

Exclude Backup, mismatches, and unverified identities from quality claims about
the requested model, while retaining their attempts and costs in reliability
and spend totals. Keep explicit recovery experiments as separate routing arms.
Correct incompatible input settings and rerun the small conformance probe before
resuming a full sweep. An unavailable endpoint remains blocked; do not replace
it with another provider or model without keeping the run's authorized scope.

## Official sources

- [GPT-6 compatibility and migration](https://developers.openai.com/api/docs/guides/latest-model)
- [Chat Completions parameters](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Responses parameters](https://developers.openai.com/api/reference/resources/responses/methods/create)
