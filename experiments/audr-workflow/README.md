# AUDR workflow join prototype

Consume harness AUDR records and join metered model operations to local Orchestra
capture envelopes. This experiment reconstructs the supplied operation graph and
summarizes asserted run costs to help select workflows for evaluation. Payload
traces remain the evidence needed to replay behavior and test cheaper models.

This is an isolated branch experiment, outside the shipped CLI and npm package.
It makes no network requests, reads no credentials, changes no gateway behavior,
and uses no external packages. All checked-in examples are synthetic.

## Run the synthetic example

From the repository root, with Node 22 or later:

```sh
node --test experiments/audr-workflow/join.test.mjs
node experiments/audr-workflow/run.mjs \
  --audr experiments/audr-workflow/fixtures/audr.jsonl \
  --captures experiments/audr-workflow/fixtures/captures.jsonl \
  --links experiments/audr-workflow/fixtures/links.jsonl \
  --output /tmp/orchestra-audr-workflow-report.json
```

The output path must not already exist. Reports are created with mode 0600 and
stdout contains counts only. Inputs are JSONL files, capped at 32 MiB each.
Capture envelopes are read locally, including their payload-bearing JSON, but
payload bodies and attribution labels are not copied into the report. The report
still contains private identifiers, resource names, usage, and costs; keep it
outside version control. Existing source artifacts retain their own permissions.

The fixture has five delivered records representing four operations: three model
calls and one executed tool, spread across two runs. One record is a duplicate.
Three model operations join three captures. The resolved run costs USD 0.06 and
the failed run costs USD 0.04. The descriptive cohort ratio is USD 0.10 per
harness-reported resolved run, including the failed run in the numerator.
These invented numbers demonstrate arithmetic, not savings or model quality.

## Open the interactive overview

```sh
node experiments/audr-workflow/build-demo.mjs
```

Open `.understudy/audr-workflow/demo.html` in a browser. It is a self-contained
local HTML file with no external assets or network calls. The builder accepts an
optional output path and refuses to overwrite an existing file. It reads only the
checked-in synthetic fixtures, never arbitrary private reports.

Start with the three-view walkthrough: Orchestra today, additional harness AUDR
evidence, and the joined view. The same four-step synthetic task shows model
interactions, external tool execution, and a declared product outcome. It calls
out overlapping usage/attribution fields and separates optional harness assertions
from verified success. A cost example includes tool expense and a failed run.

The expandable technical overview explains five stages: harness AUDR, existing gateway capture, the
local evidence join, proposed evaluation handoff, and a future routing decision.
Select stages to see responsibilities and implementation status. Inspect runs and
operations, then switch between joined evidence, a missing mapping, a missing
tool cost, and missing outcomes. Each scenario is computed by the actual joiner
at build time. A withheld ratio reflects its evidence checks, not a UI mock.

Validate the joiner and demo builder with:

```sh
node --test experiments/audr-workflow/*.test.mjs
```

## Input contract

`audr.jsonl` contains harness-emitted AUDR 1.1.x records. The prototype validates
a supported projection, not the full upstream JSON Schema or semantic conformance.
It requires explicit account, environment, run, span, emitter, resource, time,
and usage identity, even for non-production data. Only harness records are accepted
so the same model observation is not summed across harness/router emitters.
Production adoption needs version-pinned upstream schema validation plus semantic
conformance tests. See [AUDR v1.1.0](https://openaudr.dev/spec/v1.1.0/).

`captures.jsonl` contains raw v2/v3/v4 Orchestra capture envelopes with
`workos_org_id`, `project_id`, and `request_id`. A redacted capture summary is not
a substitute for the payload source an evaluator will eventually need. The joiner
does not parse or verify payload completeness and never treats a match as replay
readiness. Directory exports and normalized foundry captures need a future reader.

`links.jsonl` is an explicit, locally trusted correlation sidecar:

```json
{"account_id":"account-example","environment":"test","run_id":"run-example-01","span_id":"model-1","org_id":"org-example","project_id":"project-example","request_id":"request-example-1"}
```

This binds a scoped AUDR operation to a scoped Orchestra request. No matching by
timestamp, model name, prompt similarity, or shared trace ID occurs. Both the
operation and capture must appear at most once in the mapping. Wrong accounts,
missing captures, duplicate mappings, and mismatched capture environments fail.
The sidecar is an assertion by its author, not cryptographic proof of attribution.
If an older capture lacks an environment, the mapping supplies that assertion.

The existing gateway returns `x-understudy-request-id`. A product-side transport
hook can observe that response header and associate it with the active AUDR
operation to create the sidecar. This hook is not implemented here: adapter-specific
operation IDs and response-header access must be verified together. A W3C caller
span can be a surrounding agent span rather than a unique model operation.
Existing trace lineage is useful for investigation but is not assumed to be a
safe one-to-one join. No production gateway change is needed for the manual demo.

## Accounting and evidence limits

- Identical record redeliveries count once. Conflicting content under the same ID
  fails. Two authoritative records for the same operation require a correction.
- Full corrections replace an earlier record, including out-of-order delivery.
  Missing targets, forked histories, cycles, or cross-scope/emitter changes fail.
  All-zero usage corrections void the operation; stale links must be removed.
  Keep the complete correction history in the input window.
- Executed tools are separate operations. A model's request to call a tool is not
  counted as proof the tool executed. Missing parents and graph cycles are flagged;
  the prototype does not fabricate structural spans absent from an adapter export.
- Outcomes are harness assertions. Missing/conflicting outcomes remain unresolved.
  HTTP 200 is never converted into task success. Every workflow explicitly reports
  `outcome_quality_verified: false` and `completeness_verified: false`.
- Costs are optional harness assertions, not independently verified supplier costs
  or customer prices. Agree on one cost basis before comparing runs. Missing costs
  stay missing; raw token counts are not priced from an invented rate card.
- Account/environment cohorts are separate; currencies are never converted or
  summed together. The descriptive ratio is null with missing costs, unresolved
  outcomes, graph/join issues, multiple currencies, or no resolved run.
- A structurally clean graph can still omit calls or tools. The ratio describes
  only the supplied records. Adapter coverage, export-window completeness, and
  outcome quality need independent verification before any optimization claim.
- JSON arithmetic uses JavaScript numbers. This is exploratory analysis, not a
  monetary ledger. It does not model invoice corrections or billing settlement.

## Changes needed for a real pilot

| Area | Current experiment | Next change |
| --- | --- | --- |
| Harness ingestion | Local JSONL, supported projection | Validate a real adapter export with pinned schema and fixtures |
| Correlation | Explicit sidecar | Product-side hook capturing the gateway response ID with the actual AUDR operation ID |
| Workflow structure | Report supplied parent edges and gaps | Verify adapter root/sub-agent behavior and export completeness |
| Trace access | Local raw envelopes | Feed exact joined references into the existing foundry input path |
| Evaluation | No automatic task generation or model calls | Review task/outcome contracts; create train/dev and reserved holdout sets |
| Cost basis | Harness-asserted event totals | Reconcile model costs against canonical usage; declare tool-cost coverage |
| Optimization | No routing changes | Evaluate candidates on dev; measure quality and full-run cost on holdout |
| Gateway | Unchanged | Consider a separate proposal only if correlation cannot be done client-side |

The next useful working-session exercise is one real, sanitized harness export
and its matching captures. Determine whether operation IDs and request IDs can be
associated reliably, identify missing tools/parents, and review the declared
outcome against the captured behavior. That decides whether the next investment
should be a transport hook, an adapter fix, or evaluation work.
