# Claude Code through Orchestra

`orchestra claude` uses your saved Orchestra credential only in the Claude
child process. Install Claude Code and sign in with `orchestra login` first.
Run from a named Git branch with a GitHub `origin` remote.

```sh
orchestra claude --org org_example --project example --workload coding \
  --environment test -- --model <gateway-model-id>
```

This sends Claude's model traffic, including prompts and tool results, to the
configured gateway. Repository name, branch, initial HEAD and session ID are
sent as attribution metadata. Capture and retention follow the selected
workload's configuration; this command does not enable capture or change it.
Gateway usage is billed separately from a Claude subscription.

The launcher prints its session ID and stores metadata privately under the
Orchestra home directory. It does not save the API key in that metadata.
Resume from the same worktree and branch:

```sh
orchestra claude --resume <session-id> -- --model <gateway-model-id>
orchestra claude-session show <session-id>
```

The original base commit and routing scope stay fixed across resume. A changed
branch, repository, organization, project, workload, environment or gateway
is rejected. Start a new session for another branch. Concurrent resumes,
background/cloud sessions, automatic worktrees and Claude's own session
switching flags are not supported.

The launcher disables user/project/local settings sources for this invocation
because settings can replace gateway credentials and attribution headers.
It leaves saved configuration untouched. Supply tool permissions and MCP
configuration explicitly when needed. Organization-managed settings still
apply; this is not a bypass of administrator policy. The initial verification
used Claude Code 2.1.312 in headless mode; interactive and other versions need
separate compatibility checks.

## Reconcile a completed headless run

Keep stream output private: it contains prompts, tool results and completions.
Use a separate output file for each invocation, including resumes.

```sh
umask 077
orchestra claude --org org_example --project example --workload coding \
  --environment test -- --model <gateway-model-id> --max-budget-usd 1 \
  --output-format stream-json --verbose -p 'Describe this repository' > initial.jsonl
orchestra claude --resume <session-id> -- --model <gateway-model-id> \
  --max-budget-usd 1 --output-format stream-json --verbose \
  -p 'Summarize your previous answer' > resumed.jsonl
orchestra claude-session reconcile <session-id> \
  --transcript initial.jsonl resumed.jsonl --out ./private-captures \
  --include-payload --yes
```

Reconciliation resolves assistant message IDs through the customer cost API,
requires complete pricing, compares token totals with the supplied transcripts,
and exports captures through the existing capture exporter. It verifies request
identity, environment, attribution tags and request/response body presence.
Output contains cost and verification metadata, never capture bodies. Retry
when ingestion or pricing is still pending. Duplicate results, mixed sessions,
missing payloads or token discrepancies fail reconciliation.

Coverage is the successful requests represented in the supplied completed
transcripts. This does not enumerate omitted invocations, failed requests or
background traffic. Compare a gateway session inventory before describing the
report as the cost of an entire session. Keep exports outside version control.

## Link a pull request

With the GitHub CLI authenticated:

```sh
orchestra claude-session link <session-id> --pr 12
```

The command verifies the PR head repository and branch against the session and
stores the head commit separately from the merge commit. Run it again after
merge to refresh the linkage. It reads GitHub only; it does not create, review
or merge a PR. This is explicit branch attribution, not proof that Claude
produced every change, that every session was included, or that the PR belongs
to only one session. PR and reconciliation records remain separate private
artifacts keyed by session ID.
