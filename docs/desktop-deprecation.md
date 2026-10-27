# Understudy Desktop deprecation

Understudy Desktop, the macOS app that bundled the local control plane, is
deprecated. The CLI (`understudy`) and the agent skills in `skills/` replace it.

## What was removed

- `apps/homescreen/`: the Tauri shell (Rust) and its Next.js frontend.
- `.github/workflows/desktop-release.yml` and the `desktop_web`, `rust`, and
  `changes` CI jobs that existed only for the app.
- The `desktop:*` and `runtime:desktop-readiness` npm scripts, their
  implementations under `scripts/`, and the tests that covered only those
  scripts, the workflow, or the app's own frontend logic.
- `RELEASE-RUNBOOK-0.3.38.md` and the Desktop release section of
  `docs/release-checklist.md`.
- The app-only notes `design-qa.md` and `MIGRATION-GAPS.md` at the repo root.

Everything stays available in git history.

## Last release

The last shipped build is tag `desktop-v0.3.44-mvp`. Its DMG is attached to the
GitHub release:
<https://github.com/understudylabs/understudy-agent-tools/releases/tag/desktop-v0.3.44-mvp>.

The updater endpoint the app polls (GitHub
`releases/latest/download/latest.json`) and the R2 mirror pointer
(`desktop/releases/latest.json`) no longer advance, so an installed app keeps
working at its current version but will not receive updates. If a desktop
update is ever intended again, note that any non-prerelease GitHub release of
this repo moves the `latest` marker the installed app resolves.

## What replaces it

- The CLI: `orchestra status`, `orchestra models ...`, `orchestra benchmarks
  ...`, `orchestra runs ...`, and the rest of `orchestra --help`.
- The agent skills in `skills/`, starting from `skills/understudy/SKILL.md`.

The `orchestra desktop` command group remains for now so that existing
installs can still be inspected. It prints a one-line deprecation warning to
stderr on every invocation and will be removed in a follow-up release, together
with the CLI-side desktop code in `src/`.
