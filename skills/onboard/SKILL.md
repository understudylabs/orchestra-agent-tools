---
name: onboard
description: Use as the engaging first-run experience right after the Orchestra plugin is installed, or whenever a developer says "get started", "set me up", "I'm new to this", "onboard me", or asks what Orchestra is and where to begin. Confirms the Orchestra sign-in, profiles the machine and goals in one quick interview, writes ~/.understudy/profile.json, points the plugin at the user's real workload, and reports the optional local model lab. Hands off to the understudy orchestrator.
metadata:
  understudy:
    mode: interactive
    safety: local-first
    cli_required: false
---

# Orchestra Onboarding

The first thing a new user experiences. Goal: in a few minutes, leave them with
(1) a clear sense of what Orchestra is and why it matters, (2) the plugin
pointed at their real workload, and (3) a saved profile so you never re-ask
what you already learned. A local model is optional: the installer's local
model lab (Apple Silicon only) or an explicit request, never a default.

Run this after [`install-agent-adapter`](../install-agent-adapter/SKILL.md). It follows the
engagement doctrine in
[`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md):
keep the first minutes fast, and background anything slow. Detail —
profile schema, interview bank, tooling-detection table — is in
[`reference.md`](reference.md).

## Safety Gates

- **No unrequested downloads.** Never pull weights or install MLX unless the
  installer's local model lab already started them or the user asks. Before a
  pull, name the exact model, quantization, and disk size, and get a yes.
- **Sign-in stays with the user.** Never read the user's inbox or handle their
  sign-in code. Ask them to run `orchestra login` in their own terminal; if
  they would rather do it here, run `orchestra login --email <email> --send-code`
  and let them type the code into the chat themselves.
- **Local-first, no upload.** Profiling, interview answers, and the model run
  entirely on the machine. The profile is local; it holds preferences and
  detected tooling — never secrets, keys, or customer data.
- **Gated weights** (e.g. Gemma via Hugging Face) need license acceptance + an
  HF token; the Ollama path avoids this. Never print or commit a token.

## Intake

Returning user? If `~/.understudy/profile.json` exists, read it, greet them by
where they left off, confirm nothing major changed, and skip straight to the
work — do not re-run the full interview. Only first-timers get the full flow.

If the launch prompt came from `install.sh --lower-my-ant-bill`, treat the
primary goal as lowering Anthropic/Claude API spend. Still do the local-first
profile and quick proof, but keep the interview short and route the real work
to [`../lower-anthropic-bill/SKILL.md`](../lower-anthropic-bill/SKILL.md):
inventory Anthropic call sites, re-baseline tokenizer risk, audit cache hits,
and build an opportunity ledger before any code edits or provider calls.

## Flow

1. **Check the sign-in.** Run `orchestra status --json`. If `signed_in` is
   false, say what the account is for (a gateway key for routing, captures,
   and hosted runs; local work needs none) and follow the sign-in safety gate.
   Do not block the rest of onboarding on it.

2. **Check the local model lab.** If
   `~/.understudy/agent-tools/install-state/local-model-lab.json` exists, the
   installer started the managed MLX runtime install and the bootstrap model
   download in the background. Read the `pull.log` and `runtime.log` paths it
   names and report progress in one line (done, percent, or failed with the
   log tail); do not watch it. Without that file, do not download anything.
   On an Apple Silicon Mac, mention once that the lab is available; if the
   user wants it, name the model (`gemma-4-e2b-it-qat-mlx-vlm-understudy`,
   Gemma 4 E2B QAT converted to MLX 4-bit, about 3.6 GB), get a yes, and start
   `orchestra models runtime install` (needs `uv`) and
   `orchestra models pull gemma-4-e2b-it-qat-mlx-vlm-understudy` in the
   background through [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md).
   Other machines: say local models are Mac-only for now and move on.

3. **Profile the machine.** Detect OS/chip (Apple Silicon vs CUDA), RAM /
   unified memory, free disk. State what fits locally. This is the hardware
   inventory from
   [`../run-local-model-lab/SKILL.md`](../run-local-model-lab/SKILL.md), brought
   to the front.

4. **Detect ML tooling → infer experience.** Check for PyTorch, vLLM,
   Transformers, TRL/PEFT, MLX, llama.cpp, Ollama, the HF CLI, `nvidia-smi`
   (table in [`reference.md`](reference.md)). Lots of ML libs ⇒ experienced;
   none ⇒ likely first-timer. Use this to *pre-fill* the interview, not to
   skip it.

5. **Interview (one batched AskUserQuestion).** Confirm the inference rather than
   interrogate: *"I see PyTorch and vLLM here, so I'll assume you're comfortable
   with ML tooling — right?"* or *"No ML tooling yet — first time running models
   locally?"* Capture: experience tier, primary goal (cost / latency / quality /
   learning / compliance), hard constraints (ZDR / local-only / approved
   providers), and preferred coaching depth. Question bank in
   [`reference.md`](reference.md).

6. **Write the profile and agent card.** Save `~/.understudy/profile.json` (schema in
   [`reference.md`](reference.md)): experience tier, detected tooling, hardware,
   goal, constraints, and the three meet-them-where-they-are dials — vocabulary,
   coaching depth, opinion strength. Append, don't overwrite, the `history` of
   workloads and decisions. For `~/.understudy/agent-card.json`, check whether
   the Understudy desktop app is running first (read the card's `app.running` /
   `app.pid`, or hit `app.base_url`): the app is the canonical local daemon and
   maintains the card itself — server endpoint, warm models, shutdown state.
   Only refresh the card yourself as a **fallback when the app isn't installed
   or running**, recording live runtime facts: the local model (if any),
   endpoint, serving process, companion status, and the exact command or URL
   for talking to the local specialist model. If `~/.understudy/companion.json`
   points at a dead pid, clear it and record the stale pid in the card.

7. **Profile the user's real workload.** The main path is
   not a model duel. Ask the user for a codebase, trace folder, dataset, eval
   runner, prompt file, or app route. If they point at a project, route to
   [`../understand-workload/SKILL.md`](../understand-workload/SKILL.md) first:
   inspect prompts in situ, trace the request/response path through code,
   summarize the dataset or trace distribution, name the real task, and confirm
   that understanding with the user before any optimization. If there is already
   a real captured environment, skip the toy sandbox. Only use
   [`../design-simulated-environment/SKILL.md`](../design-simulated-environment/SKILL.md)
   when there is no resettable real workload yet. If the stated goal is lowering
   an Anthropic bill, route to
   [`../lower-anthropic-bill/SKILL.md`](../lower-anthropic-bill/SKILL.md)
   instead of asking for a generic problem.

8. **Make the local proof and head-to-head optional.** Once the lab's model is
   cached, the user can see it run: serve it with the managed runtime through
   [`../manage-local-models/SKILL.md`](../manage-local-models/SKILL.md), and
   briefly teach the idea — open weights you run yourself, free and ZDR-safe
   locally, graduating to a larger model in the same family via the gateway
   when quality demands it. A frontier-vs-local comparison is useful when the
   user needs to feel the quality gap, calibrate taste, or get buy-in. It is a
   side quest, not the default evidence path. If the user wants it, follow the
   [`ladder`](../ladder/SKILL.md) VS lane (it runs from a source checkout) and
   disclose that the frontier side is billed. Otherwise keep going through workload understanding, capture
   evidence, and local evaluation against the actual task slice.

9. **Route onward.** Hand to the [`understudy`](../understudy/SKILL.md)
   orchestrator for the improvement loop. In the normal first-run path, the next
   worker is [`understand-workload`](../understand-workload/SKILL.md): pick a
   real app, trace, prompt file, dataset, or eval and define the task before
   comparing or optimizing models. Use
   [`manage-local-models`](../manage-local-models/SKILL.md) only to grow and
   organize the local model library, and
   [`run-local-model-lab`](../run-local-model-lab/SKILL.md) only once there is a
   frozen real workload/eval to score.

Adapt everything to the profile: expand jargon and give first-timers one clear
recommended path; stay terse and offer trade-offs to practitioners.

## Output Standard

End with: sign-in status; local model lab status (not started, downloading,
cached, or Mac-only); hardware found and what fits locally; inferred
experience tier and the dials set; the profile path written; the agent-card
path refreshed; the workload picked (or the question still open); and one
recommended next skill/command.

## References

- [`reference.md`](reference.md) — profile schema, interview bank, tooling map,
  experience→coaching dials.
- [`../../docs/engagement-and-pacing.md`](../../docs/engagement-and-pacing.md) —
  the background-first, fill-the-wait doctrine.
- [`../../docs/open-model-spotlight.md`](../../docs/open-model-spotlight.md) —
  Gemma 4 & Nemotron 3 picks and hardware fit.
