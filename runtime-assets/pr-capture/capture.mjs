import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const sha = /^[a-f0-9]{40}$/;
export function validateSession(value, repository) {
  if (!value || value.version !== 1 || value.repository !== repository ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.session_id) ||
      typeof value.branch !== 'string' || !value.branch || value.branch.length > 256 || /[\x00-\x1f\x7f]/.test(value.branch) ||
      !sha.test(value.base_commit) || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error('Invalid session registration');
  }
  // Only these fields cross into repository-visible GitHub Actions artifacts.
  return { version: 1, session_id: value.session_id, repository, branch: value.branch,
    base_commit: value.base_commit, created_at: value.created_at };
}

export function matchesPullRequest(session, pr) {
  return session.repository === pr.head.repo?.full_name && session.branch === pr.head.ref &&
    (!pr.closed_at || Date.parse(session.created_at) <= Date.parse(pr.closed_at));
}

export async function buildReport(pr, sessions, compare) {
  const linked = [], rejected = [];
  for (const session of sessions) {
    if (!matchesPullRequest(session, pr)) continue;
    const status = await compare(session.base_commit, pr.head.sha);
    if (status === 'ahead' || status === 'identical') linked.push(session);
    else rejected.push({ session_id: session.session_id, reason: 'Base is not an ancestor of current PR head; rebase or unrelated history needs review.' });
  }
  return { version: 1, pull_request: pr.html_url, number: pr.number,
    state: pr.merged_at ? 'merged' : pr.state, head_commit: pr.head.sha,
    merge_commit: pr.merged_at ? pr.merge_commit_sha : null,
    linked_sessions: linked, rejected_sessions: rejected, customer_cost_usd: null,
    coverage: 'Only explicitly registered, unexpired session artifacts are included. Branch/ancestry association does not prove authorship or exclusive PR membership.',
    accounting_gap: 'Gateway request/capture/billing reconciliation is not included in this report.',
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid repository');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (event.inputs?.session) {
    const session = validateSession(JSON.parse(event.inputs.session), repository);
    writeFileSync('session.json', JSON.stringify(session, null, 2));
    writeFileSync(process.env.GITHUB_OUTPUT, `session_id=${session.session_id}\n`, { flag: 'a' });
    return;
  }
  const number = event.pull_request?.number ?? Number(event.inputs?.pr);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A PR number is required');
  const api = async path => {
    const r = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`GitHub API failed (${r.status})`);
    return r.json();
  };
  const pr = await api(`pulls/${number}`);
  if (pr.head.repo?.full_name !== repository) throw new Error('Fork PR session attribution is not supported');
  const sessions = new Map();
  let inventoryTruncated = false;
  for (let page = 1; page <= 10; page++) {
    const result = await api(`actions/artifacts?per_page=100&page=${page}`);
    for (const artifact of result.artifacts) {
      if (artifact.expired || !artifact.name.startsWith('orchestra-session-')) continue;
      const run = await api(`actions/runs/${artifact.workflow_run.id}`);
      if (run.path !== '.github/workflows/orchestra-pr-capture.yml' || run.event !== 'workflow_dispatch' || run.conclusion !== 'success') continue;
      // gh handles GitHub's authenticated archive redirect; unzip reads one named file, never extracts paths.
      const archive = execFileSync('gh', ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`], { maxBuffer: 1024 * 1024, timeout: 30000 });
      writeFileSync('session.zip', archive);
      const raw = execFileSync('unzip', ['-p', 'session.zip', 'session.json'], { encoding: 'utf8', maxBuffer: 16384, timeout: 5000 });
      const session = validateSession(JSON.parse(raw), repository);
      if (artifact.name !== `orchestra-session-${session.session_id}`) throw new Error('Artifact identity mismatch');
      const prior = sessions.get(session.session_id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(session)) throw new Error('Conflicting session registrations');
      sessions.set(session.session_id, session);
    }
    if (result.artifacts.length < 100) break;
    if (page === 10) inventoryTruncated = true;
  }
  const report = await buildReport(pr, [...sessions.values()], async (base, head) => {
    const result = await api(`compare/${base}...${head}`);
    return result.status;
  });
  report.registration_inventory_truncated = inventoryTruncated;
  report.changed_files = pr.changed_files;
  report.additions = pr.additions;
  report.deletions = pr.deletions;
  // Retain outcome counts, never review bodies, diffs, or CI logs.
  const reviews = await api(`pulls/${number}/reviews?per_page=100`);
  report.review_events = reviews.reduce((counts, review) => ({ ...counts, [review.state]: (counts[review.state] ?? 0) + 1 }), {});
  report.review_events_may_be_truncated = reviews.length === 100;
  const checks = await api(`commits/${pr.head.sha}/check-runs?per_page=100`);
  report.check_runs = checks.check_runs.map(check => ({ name: check.name, status: check.status, conclusion: check.conclusion }));
  report.check_runs_truncated = checks.total_count > checks.check_runs.length;
  report.observed_at = new Date().toISOString();
  writeFileSync('pr-report.json', JSON.stringify(report, null, 2));
  writeFileSync(process.env.GITHUB_STEP_SUMMARY,
    `Orchestra PR #${number}: ${report.state}\n\nRegistered sessions linked: ${report.linked_sessions.length}\n\nCost: unavailable. See pr-report.json for attribution limits and coverage gaps.\n`, { flag: 'a' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
