#!/usr/bin/env bash
# Install Understudy agent tools and hand the user back to an agent skill surface.
set -euo pipefail

LAB="${UNDERSTUDY_LAB:-$HOME/.understudy/agent-tools}"
PACKAGE_NAME="@orchestraai/agent-tools"
# Earlier package names, removed on upgrade: unscoped briefly after the
# Orchestra rename, and @understudylabs before it. Must not contain spaces.
LEGACY_PACKAGE_NAMES="orchestra-agent-tools @understudylabs/understudy-agent-tools"
INSTALL_REPO_URL="${UNDERSTUDY_INSTALL_REPO_URL:-https://github.com/understudylabs/orchestra-agent-tools.git}"
INSTALL_REF="${UNDERSTUDY_INSTALL_REF:-main}"
INSTALL_PACKAGE="${UNDERSTUDY_INSTALL_PACKAGE:-}"
INSTALL_COMMIT="${UNDERSTUDY_INSTALL_COMMIT:-}"
INSTALL_SOURCE_OVERRIDDEN=0
if [ -n "${UNDERSTUDY_INSTALL_REPO_URL:-}${UNDERSTUDY_INSTALL_REF:-}${UNDERSTUDY_INSTALL_PACKAGE:-}" ]; then
  INSTALL_SOURCE_OVERRIDDEN=1
fi
INSTALLER_COMMIT="${UNDERSTUDY_INSTALLER_COMMIT:-unknown}"
LAUNCH_CLAUDE="${UNDERSTUDY_LAUNCH_AGENT:-${UNDERSTUDY_LAUNCH_CLAUDE:-1}}"
# Empty means Claude Code uses the permission mode the user already chose.
CLAUDE_PERMISSION_MODE="${UNDERSTUDY_CLAUDE_PERMISSION_MODE:-}"
USER_PROMPT_OVERRIDE="${UNDERSTUDY_INITIAL_CLAUDE_PROMPT:-}"
INITIAL_CLAUDE_PROMPT=""
AGENT_PLATFORMS="${UNDERSTUDY_AGENT_PLATFORMS:-auto}"
AGENT_PLATFORMS_EXPLICIT=0
AGENT_SELECTION_SOURCE="default"
AGENT_SELECTION_ANSWER=""
if [ -n "${UNDERSTUDY_AGENT_PLATFORMS:-}" ]; then
  AGENT_PLATFORMS_EXPLICIT=1
  AGENT_SELECTION_SOURCE="UNDERSTUDY_AGENT_PLATFORMS"
fi
LOWER_MY_ANT_BILL="${UNDERSTUDY_LOWER_MY_ANT_BILL:-0}"
KEEP_LOGIN="${UNDERSTUDY_KEEP_LOGIN:-1}"
SKIP_LOGIN="${UNDERSTUDY_SKIP_LOGIN:-0}"
LOCAL_MODELS="${UNDERSTUDY_LOCAL_MODELS:-0}"
LOCAL_MODEL_ID="gemma-4-e2b-it-qat-mlx-vlm-understudy"
INSTALL_FROM_SOURCE="${UNDERSTUDY_INSTALL_FROM_SOURCE:-0}"
INSTALL_VERSION="${UNDERSTUDY_INSTALL_VERSION:-latest}"
ADVANCED=0
SETUP_CHOSEN=0
SETUP_MENU_ANSWERED=0
# quiet (person at a terminal: one line per step, detail in the log) or
# verbose (everything; the default for --yes, --non-interactive and CI).
OUTPUT_MODE="${UNDERSTUDY_INSTALL_OUTPUT:-}"
QUIET_RUN=0
QUIET_DETAIL=0
# 1 when a person is at the terminal (no --yes, --non-interactive or CI).
HUMAN_RUN=0
NO_CLAUDE=0
START_STEP=1
ONLY_STEP=""
RESUME=0
YES=0
NONINTERACTIVE="${UNDERSTUDY_NONINTERACTIVE:-${CI:-0}}"
REQUIRE_CONFIRM="${UNDERSTUDY_REQUIRE_CONFIRM:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --non-interactive|--noninteractive|--no-input) NONINTERACTIVE=1 ;;
    --require-confirm) REQUIRE_CONFIRM=1 ;;
    --no-claude) NO_CLAUDE=1 ;;
    --agents|--agent) AGENT_PLATFORMS="${2:?missing agent platform list}"; AGENT_PLATFORMS_EXPLICIT=1; AGENT_SELECTION_SOURCE="--agents flag"; SETUP_CHOSEN=1; shift ;;
    --no-agents) AGENT_PLATFORMS="none"; AGENT_PLATFORMS_EXPLICIT=1; AGENT_SELECTION_SOURCE="--no-agents flag"; NO_CLAUDE=1; LAUNCH_CLAUDE=0 ;;
    --no-launch-claude|--no-launch-agent) LAUNCH_CLAUDE=0 ;;
    --launch-claude|--launch-agent) LAUNCH_CLAUDE=1 ;;
    --lower-my-ant-bill|--lower-my-anthropic-bill) LOWER_MY_ANT_BILL=1 ;;
    --keep-login) KEEP_LOGIN=1 ;;
    --fresh-login) KEEP_LOGIN=0 ;;
    --skip-login|--no-login) SKIP_LOGIN=1 ;;
    --local-models) LOCAL_MODELS=1; SETUP_CHOSEN=1 ;;
    --advanced) ADVANCED=1 ;;
    --from-source) INSTALL_FROM_SOURCE=1 ;;
    --verbose) OUTPUT_MODE=verbose ;;
    --from-step) START_STEP="${2:?missing step number}"; shift ;;
    --only-step) ONLY_STEP="${2:?missing step number}"; shift ;;
    --resume) RESUME=1 ;;
    --lab) LAB="${2:?missing path}"; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: install.sh [--yes] [--non-interactive] [--resume] [--from-step N] [--only-step N] [--skip-login] [--local-models] [--advanced] [--lower-my-ant-bill] [--agents auto|all|claude-code|cursor|codex|opencode|hermes|devin|none] [--no-claude] [--no-launch-agent]

Installs the Orchestra CLI, signs you in to your Orchestra account in this
terminal, and installs the Orchestra plugin into every detected coding agent
(--advanced to choose). With --local-models on Apple Silicon it also starts the
managed MLX runtime install and the Orchestra 2B model download (about 3.6 GB) in the
background. It makes no frontier calls and spends nothing.

An existing sign-in is kept. --fresh-login signs you out first (credentials are
kept as a timestamped backup) so the sign-up can be demoed from scratch.

Options:
  --yes                 approve the installer prompt
  --non-interactive     use safe defaults without prompting
  --require-confirm     fail instead of using defaults when no prompt TTY exists
  --resume              continue from the next unfinished install step
  --from-step N         start from step 1, 2, or 3
  --only-step N         run only step 1, 2, or 3
  --skip-login          do not prompt for an Orchestra sign-in (run `orchestra login` later)
  --keep-login          keep an existing sign-in (default)
  --fresh-login         sign out an existing sign-in first, for demos
  --local-models        Apple Silicon only: start the MLX runtime install and the
                        Orchestra 2B model download (about 3.6 GB) in the background
  --advanced            choose which coding agents get the plugin
  --from-source         build the CLI from the GitHub source instead of npm
  --verbose             print every step (the default outside an interactive terminal)
  --lower-my-ant-bill   focus onboarding on lowering Anthropic/Claude API spend
  --lower-my-anthropic-bill
                        alias for --lower-my-ant-bill
  --agents LIST         agent adapters to install (default auto = every detected agent): auto, all, claude-code, cursor, codex, opencode, hermes, devin, none
                        comma-separated lists are accepted, e.g. claude-code,cursor
  --no-agents           skip all coding-agent plugin installs and launches
  --no-claude           skip Claude Code plugin install and final Claude launch
  --no-launch-agent     install adapters but do not open a coding agent at the end
  --no-launch-claude    legacy alias for --no-launch-agent
  --launch-agent        open a supported coding agent at the end (default)
  --launch-claude       legacy alias for --launch-agent
  --lab PATH            local Orchestra runtime/log directory

Exit codes:
  0  success
  1  aborted or missing prerequisite
  2  usage error
  3  adapter install incomplete: adapters were requested but none installed,
     or an explicitly requested adapter failed

Environment overrides:
  UNDERSTUDY_LAB                 local runtime/log directory, default ~/.understudy/agent-tools
  UNDERSTUDY_INSTALL_REPO_URL    public repo URL, default https://github.com/understudylabs/orchestra-agent-tools.git
  UNDERSTUDY_INSTALL_REF         Git ref for public repo install, default main
  UNDERSTUDY_INSTALL_COMMIT      optional full commit SHA the checkout of UNDERSTUDY_INSTALL_REF must match
  UNDERSTUDY_INSTALL_SOURCE_DIR  scratch checkout the installer deletes and re-clones, default $UNDERSTUDY_LAB/source/orchestra-agent-tools
  UNDERSTUDY_INSTALL_STATE_DIR   install markers, default $UNDERSTUDY_LAB/install-state
  UNDERSTUDY_INSTALL_LOG_DIR     install logs, default $UNDERSTUDY_LAB/logs
  UNDERSTUDY_INSTALL_LOG_FILE    exact install log path
  UNDERSTUDY_INSTALLER_COMMIT    optional script commit label when caller knows it
  UNDERSTUDY_INSTALL_PACKAGE     optional npm package spec override
  UNDERSTUDY_INSTALL_VERSION     npm version or dist-tag to install, default latest
  UNDERSTUDY_INSTALL_FROM_SOURCE set to 1 to build from the GitHub source instead of npm
  UNDERSTUDY_INSTALL_OUTPUT      quiet or verbose; default quiet in an interactive terminal
  UNDERSTUDY_INSTALL_FROM_CWD    set to 1 to install agent adapters from a checkout in the current directory
  UNDERSTUDY_NONINTERACTIVE      set to 1 to use safe defaults without prompting
  UNDERSTUDY_REQUIRE_CONFIRM     set to 1 to fail when no prompt TTY exists
  UNDERSTUDY_KEEP_LOGIN          set to 0 to sign out an existing sign-in first
  UNDERSTUDY_SKIP_LOGIN          set to 1 to skip the terminal sign-in
  UNDERSTUDY_LOCAL_MODELS        set to 1 to start the local model lab (Apple Silicon)
  UNDERSTUDY_LOWER_MY_ANT_BILL   set to 1 to focus onboarding on lowering Anthropic/Claude API spend
  UNDERSTUDY_AGENT_PLATFORMS     auto, all, claude-code, cursor, codex, opencode, hermes, devin, none, or comma list
  UNDERSTUDY_LAUNCH_AGENT       set to 0 to skip opening a coding agent
  UNDERSTUDY_LAUNCH_CLAUDE      set to 0 to skip opening a coding agent
  UNDERSTUDY_CLAUDE_ARGS        optional extra args when launching Claude Code
  UNDERSTUDY_CLAUDE_PERMISSION_MODE Claude Code permission mode, default: your own Claude Code setting
  UNDERSTUDY_INITIAL_CLAUDE_PROMPT initial prompt passed to Claude Code
  NO_COLOR                      disable all installer styling
EOF
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

INSTALL_SOURCE_DIR="${UNDERSTUDY_INSTALL_SOURCE_DIR:-$LAB/source/orchestra-agent-tools}"
STATE_DIR="${UNDERSTUDY_INSTALL_STATE_DIR:-$LAB/install-state}"
LOG_DIR="${UNDERSTUDY_INSTALL_LOG_DIR:-$LAB/logs}"
LOG_FILE="${UNDERSTUDY_INSTALL_LOG_FILE:-$LOG_DIR/install-$(date -u +"%Y%m%dT%H%M%SZ").log}"
# The installer's own state lives under ~/.understudy, which the CLI keeps
# 0700; create it the same way so a fresh install does not leave it 0755.
private_mkdir() {
  ( umask 077; mkdir -p "$@" )
  if [ -d "$HOME/.understudy" ]; then
    chmod 700 "$HOME/.understudy" 2>/dev/null || true
  fi
}
private_mkdir "$LOG_DIR"
( umask 077; : >>"$LOG_FILE" ) 2>/dev/null || true

# ── presentation ─────────────────────────────────────────────────────
# Fancy output needs a TTY on stdout; pipes, CI, and dumb terminals get
# the plain `understudy <message>` lines so logs and tests stay stable.
FANCY=0
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  FANCY=1
fi

if [ "$FANCY" = "1" ]; then
  R=$'\033[0m' B=$'\033[1m' D=$'\033[2m'
  case "${COLORTERM:-}" in
    *truecolor*|*24bit*)
      # stage-light gradient: indigo -> cyan -> spring green
      G1=$'\033[38;2;139;132;250m' G2=$'\033[38;2;120;156;250m'
      G3=$'\033[38;2;97;181;246m'  G4=$'\033[38;2;72;204;231m'
      G5=$'\033[38;2;56;222;205m'  G6=$'\033[38;2;72;235;170m'
      ;;
    *)
      G1=$'\033[38;5;105m' G2=$'\033[38;5;111m' G3=$'\033[38;5;75m'
      G4=$'\033[38;5;44m'  G5=$'\033[38;5;43m'  G6=$'\033[38;5;48m'
      ;;
  esac
  AC="$G3" OKC=$'\033[38;5;42m' WARNC=$'\033[33m' ERRC=$'\033[31m'
  trap 'printf "\033[?25h" 2>/dev/null || true' EXIT
else
  R="" B="" D="" G1="" G2="" G3="" G4="" G5="" G6=""
  AC="" OKC="" WARNC="" ERRC=""
fi

log() { printf '%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$*" >>"$LOG_FILE"; }
# While QUIET_DETAIL is 1, say and ok only reach the install log; warnings and
# failures always print.
say() {
  if [ "${QUIET_DETAIL:-0}" = "1" ]; then log "$*"; return 0; fi
  if [ "$FANCY" = "1" ]; then
    printf '  %s│%s %s\n' "$D" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
  log "$*"
}
# Like say, but kept out of the install log (for text that embeds the user's
# email or other personal details).
say_unlogged() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s│%s %s\n' "$D" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
}
# Mask credentials embedded in URLs (https://user:token@host/...) before a
# command line or source spec is shown or logged.
redact_url() {
  printf '%s\n' "$*" | sed -E 's#(://)[^/@[:space:]]+@#\1<redacted>@#g'
}
ok() {
  if [ "${QUIET_DETAIL:-0}" = "1" ]; then log "$*"; return 0; fi
  if [ "$FANCY" = "1" ]; then
    printf '  %s✓%s %s\n' "$OKC" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
  log "$*"
}
warn() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s!%s %s\n' "$WARNC" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
  log "$*"
}
fail_line() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s✗%s %s\n' "$ERRC" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
  log "$*"
}
section() {
  if [ "$FANCY" = "1" ]; then
    # bash 3.2 (macOS default) counts bytes, not characters, in ${#var}
    # and substring expansion — measure with wc -m and build the rule
    # character by character so multibyte titles stay valid UTF-8.
    local title="$*" len n pad=""
    len=$(printf '%s' "$title" | wc -m)
    n=$((54 - len))
    [ "$n" -lt 2 ] && n=2
    # bash 3.2's lexer misparses an unbraced $pad butted against the
    # multibyte ─ ("pad\xe2: unbound variable" under set -u) — keep braces
    while [ "$n" -gt 0 ]; do pad="${pad}─"; n=$((n - 1)); done
    printf '\n  %s──%s %s%s%s %s%s%s\n' "$AC" "$R" "$B" "$title" "$R" "$AC" "$pad" "$R"
  else
    printf '\n\033[1morchestra\033[0m %s\n' "$*"
  fi
  log "$*"
}
# Step headers are structure for logs; a person sees one line per step.
step_section() {
  if [ "${QUIET_RUN:-0}" = "1" ]; then log "$*"; return 0; fi
  section "$@"
}
ok_unlogged() {
  if [ "$FANCY" = "1" ]; then
    printf '  %s✓%s %s\n' "$OKC" "$R" "$*"
  else
    printf '\033[1morchestra\033[0m %s\n' "$*"
  fi
}
# Something the person should act on. In quiet runs it is collected and shown
# once, in a "Needs attention" block at the end, so problems never interleave
# with progress; otherwise it prints as a warning right away.
ATTENTION_TEXT=""
ATTENTION_COUNT=0
attention() {
  local message="$1" fix="${2:-}"
  log "ATTENTION $message${fix:+ | $fix}"
  if [ -n "${STATE_DIR:-}" ]; then
    private_mkdir "$STATE_DIR"
    printf '%s\t%s\n' "$message" "$fix" >>"$STATE_DIR/attention.txt"
  fi
  if [ "${QUIET_RUN:-0}" = "1" ]; then
    ATTENTION_COUNT=$((ATTENTION_COUNT + 1))
    ATTENTION_TEXT="${ATTENTION_TEXT}${message}
${fix}
"
    return 0
  fi
  warn "$message"
  [ -z "$fix" ] || say "$fix"
}
print_attention() {
  local message fix
  [ "$ATTENTION_COUNT" -gt 0 ] || return 0
  section "Needs attention"
  while IFS= read -r message && IFS= read -r fix; do
    warn "$message"
    [ -z "$fix" ] || say "  $fix"
  done <<ATTENTION
$ATTENTION_TEXT
ATTENTION
}
banner() {
  if [ "$FANCY" != "1" ]; then
    return 0
  fi
  printf '\n'
  printf '  %s%s%s\n' "$G1" '                   __              __' "$R"
  printf '  %s%s%s\n' "$G2" '  ____  __________/ /_  ___  _____/ /__________ _' "$R"
  printf '  %s%s%s\n' "$G3" ' / __ \/ ___/ ___/ __ \/ _ \/ ___/ __/ ___/ __ `/' "$R"
  printf '  %s%s%s\n' "$G5" '/ /_/ / /  / /__/ / / /  __(__  ) /_/ /  / /_/ /' "$R"
  printf '  %s%s%s\n' "$G6" '\____/_/   \___/_/ /_/\___/____/\__/_/   \__,_/' "$R"
  printf '\n  %sTurn AI spend into AI you own.%s\n' "$D" "$R"
}
# run_logged <label> <command...> — run quietly into the install log,
# with a live spinner on a TTY and a plain line everywhere else.
run_logged() {
  local label="$1"
  shift
  log "RUN $(redact_url "$@")"
  local status=0
  if [ "$FANCY" = "1" ]; then
    local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0 start=$SECONDS
    "$@" >>"$LOG_FILE" 2>&1 &
    local pid=$!
    # Ctrl-C must take the background step down with the installer, or it
    # keeps writing into the scratch checkout and the global npm prefix.
    trap 'kill "$pid" 2>/dev/null || true; printf "\r\033[2K\033[?25h"; exit 130' INT TERM
    printf '\033[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s%s%s %s %s%ss%s ' "$AC" "${frames[$((i % 10))]}" "$R" "$label" "$D" "$((SECONDS - start))" "$R"
      i=$((i + 1))
      sleep 0.1
    done
    wait "$pid" || status=$?
    trap - INT TERM
    printf '\r\033[2K\033[?25h'
    if [ "$status" = "0" ]; then
      ok "$label ${D}($((SECONDS - start))s)${R}"
      return 0
    fi
  else
    if "$@" >>"$LOG_FILE" 2>&1; then
      return 0
    else
      status="$?"
    fi
  fi
  fail_line "Command failed: $(redact_url "$@")"
  say "See install log: $LOG_FILE"
  tail -40 "$LOG_FILE" >&2 || true
  return "$status"
}
need() { command -v "$1" >/dev/null 2>&1; }
valid_step() {
  case "$1" in
    1|2|3) return 0 ;;
    *) echo "invalid step: $1 (expected 1-3)" >&2; exit 2 ;;
  esac
}
should_run_step() {
  local step="$1"
  if [ -n "$ONLY_STEP" ]; then
    [ "$step" = "$ONLY_STEP" ]
  else
    [ "$step" -ge "$START_STEP" ]
  fi
}
mark_step_done() {
  local step="$1"
  private_mkdir "$STATE_DIR"
  date -u +"%Y-%m-%dT%H:%M:%SZ" >"$STATE_DIR/step-$step.done"
  printf '%s\n' "$step" >"$STATE_DIR/last-step"
}
configure_resume() {
  local last_step
  valid_step "$START_STEP"
  [ -z "$ONLY_STEP" ] || valid_step "$ONLY_STEP"
  if [ "$RESUME" = "1" ] && [ -f "$STATE_DIR/last-step" ]; then
    last_step="$(cat "$STATE_DIR/last-step" 2>/dev/null || true)"
    case "$last_step" in
      1|2) START_STEP=$((last_step + 1)) ;;
      3) START_STEP=3 ;;
    esac
    say "Resuming from step $START_STEP based on $STATE_DIR/last-step"
  fi
}
normalize_agent_platform() {
  case "$1" in
    claude|claude_code|claudecode) printf '%s\n' "claude-code" ;;
    hermes|hermes_agent|hermes-agent) printf '%s\n' "hermes" ;;
    cursor|codex|opencode|devin|all|auto|none|claude-code) printf '%s\n' "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}
validate_agent_platforms() {
  local token normalized count mode
  count=0
  mode=""
  # Split without globbing so a token such as '*' cannot expand to file names.
  set -f
  # shellcheck disable=SC2046
  set -- $(printf '%s\n' "$AGENT_PLATFORMS" | tr ',;' '  ')
  set +f
  for token in "$@"; do
    count=$((count + 1))
    normalized="$(normalize_agent_platform "$token")"
    case "$normalized" in
      auto|all|none) mode="$normalized" ;;
      claude-code|cursor|codex|opencode|hermes|devin) ;;
      *)
        fail_line "Unknown agent adapter '$token'. Use auto, all, claude-code, cursor, codex, opencode, hermes, devin, none, or a comma list of explicit adapters."
        return 1
        ;;
    esac
  done
  if [ "$count" -eq 0 ]; then
    fail_line "No agent adapter selection provided. Use auto, all, claude-code, cursor, codex, opencode, hermes, devin, or none."
    return 1
  fi
  if [ -n "$mode" ] && [ "$count" -gt 1 ]; then
    fail_line "Agent adapter mode '$mode' cannot be combined with other values. Use '$mode' alone, or use a comma list like claude-code,cursor."
    return 1
  fi
}
# Like agent_platform_requested, but "all" does not count.
agent_platform_named() {
  local wanted token
  wanted="$(normalize_agent_platform "$1")"
  set -f
  # shellcheck disable=SC2046
  set -- $(printf '%s\n' "$AGENT_PLATFORMS" | tr ',;' '  ')
  set +f
  for token in "$@"; do
    [ "$(normalize_agent_platform "$token")" = "$wanted" ] && return 0
  done
  return 1
}
agent_platform_requested() {
  local wanted token normalized
  wanted="$(normalize_agent_platform "$1")"
  set -f
  # shellcheck disable=SC2046
  set -- $(printf '%s\n' "$AGENT_PLATFORMS" | tr ',;' '  ')
  set +f
  for token in "$@"; do
    normalized="$(normalize_agent_platform "$token")"
    case "$normalized" in
      all) return 0 ;;
      none|auto) ;;
      "$wanted") return 0 ;;
    esac
  done
  return 1
}
detect_claude_code() {
  need claude
}
detect_cursor() {
  need cursor ||
    [ -d "$HOME/.cursor" ] ||
    [ -d "/Applications/Cursor.app" ] ||
    [ -d "$HOME/Applications/Cursor.app" ]
}
detect_codex() {
  need codex
}
detect_opencode() {
  need opencode ||
    [ -x "$HOME/.opencode/bin/opencode" ] ||
    [ -d "$HOME/.config/opencode" ] ||
    [ -d "$HOME/.local/share/opencode" ]
}
detect_hermes() {
  need hermes ||
    [ -d "${HERMES_HOME:-$HOME/.hermes}" ]
}
detect_devin() {
  [ -n "${DEVIN:-}" ] ||
    [ -n "${DEVIN_SESSION_ID:-}" ] ||
    [ -d "$HOME/.devin" ]
}
default_agent_platform() {
  if [ "$NO_CLAUDE" != "1" ] && detect_claude_code; then
    printf '%s\n' "claude-code"
  elif detect_cursor; then
    printf '%s\n' "cursor"
  elif detect_codex; then
    printf '%s\n' "codex"
  elif detect_opencode; then
    printf '%s\n' "opencode"
  elif detect_hermes; then
    printf '%s\n' "hermes"
  elif detect_devin; then
    printf '%s\n' "devin"
  else
    printf '%s\n' "none"
  fi
}
detected_agent_label() {
  local name="$1" label="$2"
  if [ "$name" = "claude-code" ] && [ "$NO_CLAUDE" = "1" ]; then
    printf '%s\n' "$label (disabled by --no-claude)"
  elif case "$name" in
      claude-code) detect_claude_code ;;
      cursor) detect_cursor ;;
      codex) detect_codex ;;
      opencode) detect_opencode ;;
      hermes) detect_hermes ;;
      devin) detect_devin ;;
      *) return 1 ;;
    esac
  then
    printf '%s\n' "$label (detected)"
  else
    printf '%s\n' "$label (not detected)"
  fi
}
noninteractive_enabled() {
  case "$NONINTERACTIVE" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}
lower_my_ant_bill_enabled() {
  case "$LOWER_MY_ANT_BILL" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}
# Apple Silicon Macs are the only supported local model lab hosts for now.
local_models_supported() {
  [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]
}

# The opening question for human installs. --yes, --non-interactive, and any
# explicit agent or local-model flag skip it; the defaults are option 1.
choose_setup() {
  local answer
  [ "$SETUP_CHOSEN" = "0" ] || return 0
  [ "$AGENT_PLATFORMS_EXPLICIT" = "0" ] || return 0
  [ -z "$ONLY_STEP" ] || return 0
  [ "$YES" = "0" ] || return 0
  noninteractive_enabled && return 0
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 0

  section "What do you want to set up?"
  say "  ${G2}1.${R} Orchestra account + plugin for your coding agents ${D}(recommended, about a minute)${R}"
  if local_models_supported; then
    say "  ${G3}2.${R} Option 1 + local model lab ${D}(MLX runtime + Orchestra 2B model, about 3.6 GB, downloads in the background)${R}"
  fi
  say "  ${G4}3.${R} CLI only"
  say "  ${G5}a.${R} Advanced: choose which coding agents get the plugin"
  if ! printf "  %s?%s Setup %s[1]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null; then
    return 0
  fi
  read -r answer </dev/tty 2>/dev/null || return 0
  SETUP_MENU_ANSWERED=1
  case "$answer" in
    ""|1) ;;
    2)
      if local_models_supported; then
        LOCAL_MODELS=1
      else
        warn "The local model lab needs an Apple Silicon Mac; continuing with option 1."
      fi
      ;;
    3|cli|cli-only)
      AGENT_PLATFORMS="none"; AGENT_PLATFORMS_EXPLICIT=1; AGENT_SELECTION_SOURCE="setup menu"
      NO_CLAUDE=1; LAUNCH_CLAUDE=0; SKIP_LOGIN=1
      ;;
    a|A|advanced) ADVANCED=1 ;;
    *) warn "Unrecognized choice '$answer'; continuing with option 1." ;;
  esac
  SETUP_CHOSEN=1
}

select_agent_platforms() {
  local answer default
  [ "$ADVANCED" = "1" ] || return 0
  [ "$AGENT_PLATFORMS_EXPLICIT" = "0" ] || return 0
  should_run_step 2 || return 0
  [ "$YES" = "0" ] || return 0
  noninteractive_enabled && return 0
  [ -r /dev/tty ] && [ -w /dev/tty ] || return 0

  default="auto"
  section "Choose Coding Agent"
  say "Where should Orchestra install its agent plugin?"
  say "  ${G2}1.${R} $(detected_agent_label "claude-code" "Claude Code")"
  say "  ${G3}2.${R} $(detected_agent_label "cursor" "Cursor")"
  say "  ${G4}3.${R} $(detected_agent_label "codex" "Codex")"
  say "  ${G5}4.${R} $(detected_agent_label "opencode" "OpenCode") ${D}(deprecated)${R}"
  say "  ${G6}5.${R} $(detected_agent_label "hermes" "Hermes Agent") ${D}(deprecated)${R}"
  say "  ${G6}6.${R} $(detected_agent_label "devin" "Devin")"
  say "  ${G6}7.${R} All detected coding agents ${D}(except deprecated ones)${R}"
  say "  ${G6}8.${R} CLI only, no coding-agent plugins"
  say "Press Enter for: all detected coding agents."

  if ! printf "  %s?%s Install target %s[1-8 or name]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null; then
    return 0
  fi
  if ! read -r answer </dev/tty 2>/dev/null; then
    return 0
  fi
  AGENT_SELECTION_SOURCE="menu"
  AGENT_SELECTION_ANSWER="$answer"
  case "$answer" in
    "") AGENT_PLATFORMS="$default" ;;
    1|claude|claude-code|claude_code|claudecode) AGENT_PLATFORMS="claude-code" ;;
    2|cursor) AGENT_PLATFORMS="cursor" ;;
    3|codex) AGENT_PLATFORMS="codex" ;;
    4|opencode|open-code|open_code) AGENT_PLATFORMS="opencode" ;;
    5|hermes|hermes-agent|hermes_agent) AGENT_PLATFORMS="hermes" ;;
    6|devin) AGENT_PLATFORMS="devin" ;;
    7|all|auto) AGENT_PLATFORMS="auto" ;;
    8|none|cli|cli-only|cli_only) AGENT_PLATFORMS="none" ;;
    *) AGENT_PLATFORMS="$answer" ;;
  esac
  validate_agent_platforms || exit 2
}
should_install_claude_adapter() {
  [ "$NO_CLAUDE" = "1" ] && return 1
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_claude_code; return ;;
  esac
  agent_platform_requested "claude-code"
}
should_install_cursor_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_cursor; return ;;
  esac
  agent_platform_requested "cursor"
}
should_install_codex_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_codex; return ;;
  esac
  agent_platform_requested "codex"
}
# OpenCode and Hermes are deprecated: neither auto nor all installs them, but
# naming one in --agents still does.
should_install_opencode_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none|auto) return 1 ;;
  esac
  agent_platform_named "opencode"
}
should_install_hermes_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none|auto) return 1 ;;
  esac
  agent_platform_named "hermes"
}
should_install_devin_adapter() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    none) return 1 ;;
    auto) detect_devin; return ;;
  esac
  agent_platform_requested "devin"
}
agent_plan_label() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    auto) printf '%s\n' "Install the Orchestra plugin into every detected coding agent (--advanced to choose)." ;;
    none) printf '%s\n' "Skip coding-agent plugin adapters." ;;
    all) printf '%s\n' "Install all supported agent adapters." ;;
    *) printf '%s\n' "Install requested agent adapter(s): $AGENT_PLATFORMS." ;;
  esac
}
# Support depends on this line: the install log must always record what was
# answered and what it resolved to, or a silent no-adapter install cannot be
# diagnosed from a customer log afterwards.
report_agent_selection() {
  if [ "$AGENT_SELECTION_SOURCE" = "menu" ]; then
    say "Agent adapter selection: $AGENT_PLATFORMS (answer: '$AGENT_SELECTION_ANSWER')"
  else
    say "Agent adapter selection: $AGENT_PLATFORMS (source: $AGENT_SELECTION_SOURCE)"
  fi
}

# ── adapter install accounting ───────────────────────────────────────
# Every install_* adapter function records installed / skipped / failed so
# the installer can summarize what actually happened, keep the final handoff
# honest, and refuse to look successful when the user asked for adapters and
# got none.
ADAPTER_RESULTS=""
ADAPTERS_ATTEMPTED=0
ADAPTERS_INSTALLED_COUNT=0
ADAPTERS_UNMET_COUNT=0
EXPLICIT_ADAPTER_FAILED=0

record_adapter() {
  local name="$1" status="$2" reason="$3"
  ADAPTER_RESULTS="${ADAPTER_RESULTS}${name}|${status}|${reason}
"
  log "ADAPTER $name $status ($reason)"
}
adapter_installed() {
  case "$ADAPTER_RESULTS" in
    *"$1|installed|"*) return 0 ;;
    *) return 1 ;;
  esac
}
adapter_explicitly_requested() {
  case "$(normalize_agent_platform "$AGENT_PLATFORMS")" in
    auto|all|none) return 1 ;;
  esac
  agent_platform_requested "$1"
}
record_adapter_failure() {
  local name="$1" reason="$2"
  record_adapter "$name" "failed" "$reason"
  if adapter_explicitly_requested "$name"; then
    EXPLICIT_ADAPTER_FAILED=1
  fi
}
# A missing prerequisite is a quiet skip under autodetection, but an error
# when the user explicitly asked for this adapter (--agents / env): warn
# loudly and mark the run as failed instead of silently skipping.
adapter_prereq_missing() {
  local name="$1" reason="$2"
  if adapter_explicitly_requested "$name"; then
    warn "The $name adapter was explicitly requested but $reason."
    record_adapter_failure "$name" "$reason"
  else
    record_adapter "$name" "skipped" "$reason"
  fi
}
manual_adapter_instructions() {
  local repo
  repo="$(resolve_skill_repo 2>/dev/null || printf '%s' "$PKG_DIR")"
  say "Manual install commands, per platform:"
  say "  Claude Code: claude plugin marketplace add $repo && claude plugin install orchestra@orchestra-skills"
  say "  Cursor:      ln -s $repo \$HOME/.cursor/plugins/local/orchestra"
  say "  Codex:       codex plugin marketplace add $repo"
  say "  OpenCode:    ln -s $repo/skills/understudy \$HOME/.config/opencode/skills/understudy"
  say "  Hermes:      add $repo/skills to skills.external_dirs in $(hermes_config_path), then /reload-skills"
  say "  Devin:       cloud-based, no local install — ask Devin to use the Orchestra onboarding skill for this project"
  say "Or rerun this installer with an explicit adapter, e.g.: --agents claude-code"
}
agent_display_name() {
  case "$1" in
    claude-code) printf 'Claude Code' ;;
    cursor) printf 'Cursor' ;;
    codex) printf 'Codex' ;;
    opencode) printf 'OpenCode' ;;
    hermes) printf 'Hermes' ;;
    devin) printf 'Devin' ;;
    *) printf '%s' "$1" ;;
  esac
}

# One line for a person: which agents got the plugin. Failures go to Needs
# attention; agents that simply aren't on this machine only reach the log.
summarize_agent_adapters_quiet() {
  local name status reason names="" installed=0 unmet=0 selection
  selection="$(normalize_agent_platform "$AGENT_PLATFORMS")"
  while IFS='|' read -r name status reason; do
    [ -n "$name" ] || continue
    log "adapter $name: $status — $reason"
    case "$status" in
      installed)
        installed=$((installed + 1))
        names="${names:+$names, }$(agent_display_name "$name")"
        ;;
      failed)
        unmet=$((unmet + 1))
        attention "The $(agent_display_name "$name") plugin did not install: $reason." "Details are in $LOG_FILE."
        ;;
      disabled) ;;
      *)
        case "$selection" in
          auto|all) [ "$reason" = "not selected or not detected" ] || unmet=$((unmet + 1)) ;;
          *)
            if adapter_explicitly_requested "$name"; then
              unmet=$((unmet + 1))
              attention "The $(agent_display_name "$name") plugin was skipped: $reason."
            fi
            ;;
        esac
        ;;
    esac
  done <<ADAPTERS
$ADAPTER_RESULTS
ADAPTERS
  ADAPTERS_INSTALLED_COUNT="$installed"
  ADAPTERS_UNMET_COUNT="$unmet"
  if [ "$installed" -gt 0 ]; then
    ok "Plugin installed: $names"
  elif [ "$selection" != "none" ]; then
    fail_line "No coding-agent plugin was installed; the Orchestra skills are not available in any coding agent yet."
    manual_adapter_instructions
  fi
}

summarize_agent_adapters() {
  local name status reason installed=0 unmet=0 selection
  selection="$(normalize_agent_platform "$AGENT_PLATFORMS")"
  ADAPTERS_ATTEMPTED=1
  # Machine-readable copy for `orchestra init`, which runs this step for a person.
  private_mkdir "$STATE_DIR"
  printf '%s' "$ADAPTER_RESULTS" >"$STATE_DIR/adapter-results.txt"
  QUIET_DETAIL=0
  if [ "$QUIET_RUN" = "1" ]; then
    summarize_agent_adapters_quiet
    return 0
  fi
  say ""
  say "${B}Adapter summary${R}"
  while IFS='|' read -r name status reason; do
    [ -n "$name" ] || continue
    case "$status" in
      installed) ok "$name: $reason"; installed=$((installed + 1)) ;;
      failed) fail_line "$name: failed — $reason"; unmet=$((unmet + 1)) ;;
      disabled) say "$name: skipped — $reason" ;;
      *)
        # Agents that simply aren't on this machine are noise for a person.
        if [ "$QUIET_RUN" = "1" ] && [ "$reason" = "not selected or not detected" ]; then
          log "$name: skipped — $reason"
        else
          say "$name: skipped — $reason"
        fi
        # A skip counts as an unmet adapter when it was a real candidate:
        # any candidate under auto/all, or an explicitly requested adapter.
        # Skips of adapters the user never asked for don't count, and
        # "disabled" (an explicit user flag) is handled above.
        case "$selection" in
          auto|all) unmet=$((unmet + 1)) ;;
          *) if adapter_explicitly_requested "$name"; then unmet=$((unmet + 1)); fi ;;
        esac
        ;;
    esac
  done <<EOF
$ADAPTER_RESULTS
EOF
  ADAPTERS_INSTALLED_COUNT="$installed"
  ADAPTERS_UNMET_COUNT="$unmet"

  if [ "$installed" -eq 0 ] && [ "$selection" != "none" ] && [ "$unmet" -gt 0 ]; then
    printf '\n'
    fail_line "${B}NO CODING-AGENT PLUGIN WAS INSTALLED.${R}"
    warn "The adapter selection was '$AGENT_PLATFORMS', but every candidate was skipped or failed (reasons above)."
    warn "The orchestra CLI is installed, but the Orchestra skills are NOT available in any coding agent until an adapter is installed."
    manual_adapter_instructions
    say "Install log: $LOG_FILE"
  elif [ "$installed" -eq 0 ] && [ "$selection" != "none" ]; then
    printf '\n'
    say "Every selected coding-agent adapter was disabled by a flag; treating this as a CLI-only install."
  elif [ "$EXPLICIT_ADAPTER_FAILED" = "1" ]; then
    printf '\n'
    fail_line "An explicitly requested agent adapter failed to install (see the adapter summary above)."
    manual_adapter_instructions
  fi
}
# Exit status for the whole install: 3 when adapters were requested but none
# installed, or when an explicitly requested adapter failed. 0 otherwise.
# Adapters the user disabled with an explicit flag (--no-claude) are the
# user's own choice and never turn the run into a failure.
adapter_exit_code() {
  if [ "$ADAPTERS_ATTEMPTED" != "1" ]; then
    printf '0\n'
    return 0
  fi
  if [ "$EXPLICIT_ADAPTER_FAILED" = "1" ]; then
    printf '3\n'
    return 0
  fi
  if [ "$ADAPTERS_INSTALLED_COUNT" -eq 0 ] && [ "$ADAPTERS_UNMET_COUNT" -gt 0 ] && [ "$(normalize_agent_platform "$AGENT_PLATFORMS")" != "none" ]; then
    printf '3\n'
    return 0
  fi
  printf '0\n'
}
# Like confirm, but Enter means yes; used for optional follow-ups in a run
# the user already approved.
confirm_default_yes() {
  local answer
  [ "$YES" = "1" ] && return 0
  noninteractive_enabled && return 1
  printf "  %s?%s %s %s[Y/n]%s " "$G4" "$R" "$1" "$D" "$R" >/dev/tty 2>/dev/null || return 1
  read -r answer </dev/tty 2>/dev/null || return 1
  case "$answer" in ""|y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

confirm() {
  local answer
  [ "$YES" = "1" ] && return 0
  case "$NONINTERACTIVE" in
    1|true|TRUE|yes|YES|on|ON)
      if [ "$REQUIRE_CONFIRM" = "1" ]; then
        say "Confirmation is required but running non-interactively; rerun in a terminal or pass --yes."
        return 1
      fi
      say "Running non-interactively; using installer defaults."
      return 0
      ;;
  esac
  if ! { : </dev/tty >/dev/tty; } 2>/dev/null; then
    say "No interactive terminal is available for prompts."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
  if ! printf "  %s?%s %s %s[y/N]%s " "$G4" "$R" "$1" "$D" "$R" >/dev/tty 2>/dev/null; then
    say "No interactive terminal is available for prompts."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
  if ! read -r answer </dev/tty 2>/dev/null; then
    say "No interactive terminal input is available."
    say "Confirmation is required; rerun in a terminal or pass --yes / --non-interactive."
    return 1
  fi
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

remove_previous_global_package() {
  local global_root global_prefix package_name package_path bin_path bin_name
  global_root="$(npm root -g)"
  global_prefix="$(npm prefix -g)"

  # shellcheck disable=SC2086 # LEGACY_PACKAGE_NAMES is a space-separated list.
  for package_name in "$PACKAGE_NAME" $LEGACY_PACKAGE_NAMES; do
    package_path="$global_root/$package_name"
    if [ -e "$package_path" ] || [ -L "$package_path" ]; then
      say "Removing previous global Orchestra install at $package_path"
      npm uninstall -g "$package_name" >/dev/null 2>&1 || true
      if [ -e "$package_path" ] || [ -L "$package_path" ]; then
        rm -rf "$package_path"
      fi
    fi
  done
  rmdir "$global_root/@understudylabs" 2>/dev/null || true

  # The package installs `orchestra` and the legacy `understudy` alias.
  for bin_name in orchestra understudy; do
    for bin_path in "$global_prefix/bin/$bin_name" "$HOME/.local/bin/$bin_name"; do
      [ -e "$bin_path" ] || [ -L "$bin_path" ] || continue
      if [ -L "$bin_path" ] && readlink "$bin_path" 2>/dev/null | grep -qE 'orchestraai/agent-tools|orchestra-agent-tools|understudy-agent-tools'; then
        say "Removing stale Orchestra command at $bin_path"
        rm -f "$bin_path"
      elif [ -f "$bin_path" ] && [ "$bin_path" != "$global_prefix/bin/$bin_name" ]; then
        # Not created by npm or this installer: a user's own wrapper stays.
        warn "Leaving existing $bin_path in place; if its directory precedes $global_prefix/bin in PATH it will shadow the newly installed $bin_name command."
      elif [ -f "$bin_path" ] && grep -qE 'orchestraai/agent-tools|orchestra-agent-tools|understudy-agent-tools' "$bin_path" 2>/dev/null; then
        say "Removing stale Orchestra command at $bin_path"
        rm -f "$bin_path"
      fi
    done
  done
}

# Record where this install came from next to package-commit, so a redirected
# source (env overrides) stays visible afterwards and not only in the log.
record_install_source() {
  private_mkdir "$STATE_DIR"
  {
    printf 'repo_url=%s\n' "$(redact_url "$INSTALL_REPO_URL")"
    printf 'ref=%s\n' "$INSTALL_REF"
    printf 'commit=%s\n' "$INSTALL_COMMIT"
    printf 'package=%s\n' "$(redact_url "$INSTALL_PACKAGE")"
  } >"$STATE_DIR/install-source"
}

# Install the newest published release (or UNDERSTUDY_INSTALL_VERSION) from
# npm. Returns nonzero, leaving the caller to build from source, when npm has
# no usable release yet; deprecated versions are the name-reservation
# placeholders, never a real CLI.
install_from_npm_registry() {
  local version deprecated
  version="$(npm view "$PACKAGE_NAME@$INSTALL_VERSION" version 2>>"$LOG_FILE" | tail -1)" || version=""
  if [ -z "$version" ]; then
    log "npm has no $PACKAGE_NAME@$INSTALL_VERSION"
    return 1
  fi
  deprecated="$(npm view "$PACKAGE_NAME@$version" deprecated 2>>"$LOG_FILE" || true)"
  if [ -n "$deprecated" ]; then
    log "npm $PACKAGE_NAME@$version is deprecated: $deprecated"
    return 1
  fi
  # npm can point latest at a pre-release stand-in (0.0.0-stage while a
  # staged publish awaits approval) that ships no CLI. Only a release that
  # declares the orchestra command may replace a working install; a
  # pre-release is used only when UNDERSTUDY_INSTALL_VERSION names it.
  case "$version" in
    *-*)
      if [ "$INSTALL_VERSION" != "$version" ]; then
        log "npm $PACKAGE_NAME@$INSTALL_VERSION resolves to pre-release $version"
        return 1
      fi
      ;;
  esac
  if ! npm view "$PACKAGE_NAME@$version" bin --json 2>>"$LOG_FILE" | grep -q '"orchestra"'; then
    log "npm $PACKAGE_NAME@$version does not declare the orchestra command"
    return 1
  fi
  say "Installing $PACKAGE_NAME@$version from npm."
  remove_previous_global_package
  if ! run_logged "Install the orchestra command" npm install -g --ignore-scripts "$PACKAGE_NAME@$version"; then
    return 1
  fi
  printf '%s\n' "$version" >"$STATE_DIR/package-version"
}

install_understudy_package() {
  local package_commit package_version package_tarball runtime_deps
  record_install_source

  if [ -n "$INSTALL_PACKAGE" ]; then
    warn "Installing Orchestra package from a non-default source: $(redact_url "$INSTALL_PACKAGE")"
    run_logged "Install Orchestra package" npm install -g "$INSTALL_PACKAGE"
    return 0
  fi

  # The published package is the default: a prebuilt, provenance-signed
  # release, no git clone or on-machine build. A custom repo/ref, --from-source,
  # or a registry without a usable release falls through to the source build.
  if [ "$INSTALL_FROM_SOURCE" != "1" ] && [ "$INSTALL_SOURCE_OVERRIDDEN" != "1" ]; then
    if install_from_npm_registry; then
      return 0
    fi
    say "Building Orchestra from the GitHub source instead."
  fi

  need git || {
    say "git is required to install Orchestra from the public repo."
    exit 1
  }

  if [ "$INSTALL_SOURCE_OVERRIDDEN" = "1" ]; then
    warn "Installing Orchestra package from a non-default source: $(redact_url "$INSTALL_REPO_URL")#$INSTALL_REF"
  else
    say "Installing Orchestra package from $INSTALL_REPO_URL#$INSTALL_REF"
  fi
  # The scratch checkout is deleted before and after the install; never do
  # that to a path this installer did not create itself.
  INSTALL_SOURCE_DIR="$(node -e '
    const fs = require("fs"), path = require("path");
    const resolve = p => { p = path.resolve(p); return fs.existsSync(p) ? fs.realpathSync(p) : p; };
    const target = resolve(process.argv[1]);
    const protectedPaths = process.argv.slice(2).map(resolve);
    if (protectedPaths.some(p => p === target || p.startsWith(target + path.sep)) || target === path.parse(target).root) process.exit(2);
    process.stdout.write(target);
  ' "$INSTALL_SOURCE_DIR" "$HOME" "$LAB" "$PWD")" || {
    fail_line "Refusing to use the requested path as the scratch checkout."
    exit 2
  }
  case "${INSTALL_SOURCE_DIR%/}" in
    ""|/|"$HOME")
      fail_line "Refusing to use $INSTALL_SOURCE_DIR as the scratch checkout."
      exit 2
      ;;
  esac
  if [ -L "$INSTALL_SOURCE_DIR" ] || { [ -e "$INSTALL_SOURCE_DIR" ] && [ ! -f "$INSTALL_SOURCE_DIR/.understudy-installer-checkout" ]; }; then
    fail_line "$INSTALL_SOURCE_DIR exists and was not created by this installer; remove it or unset UNDERSTUDY_INSTALL_SOURCE_DIR."
    exit 2
  fi
  rm -rf "$INSTALL_SOURCE_DIR"
  private_mkdir "$(dirname "$INSTALL_SOURCE_DIR")"
  run_logged "Download Orchestra ($INSTALL_REF)" env GIT_ALLOW_PROTOCOL="${GIT_ALLOW_PROTOCOL:-https:ssh:file}" git clone --depth 1 --filter=blob:none --sparse --branch "$INSTALL_REF" "$INSTALL_REPO_URL" "$INSTALL_SOURCE_DIR"
  : >"$INSTALL_SOURCE_DIR/.understudy-installer-checkout"
  run_logged "Select install files" git -C "$INSTALL_SOURCE_DIR" sparse-checkout set \
    .agents .claude-plugin .codex-plugin .cursor-plugin .devin .hermes .opencode \
    docs experiments/desktop-tool-proof runtime-assets schemas scripts skills src
  package_commit="$(git -C "$INSTALL_SOURCE_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  say "Orchestra package commit: $package_commit"
  if [ -n "$INSTALL_COMMIT" ]; then
    if [[ "$INSTALL_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] && [ "$package_commit" = "$(printf '%s' "$INSTALL_COMMIT" | tr 'A-F' 'a-f')" ]; then
      ok "Checkout matches UNDERSTUDY_INSTALL_COMMIT."
    else
        fail_line "Checkout of $INSTALL_REF is at $package_commit, not the pinned UNDERSTUDY_INSTALL_COMMIT=$INSTALL_COMMIT."
        exit 1
    fi
  fi
  private_mkdir "$STATE_DIR"
  printf '%s\n' "$package_commit" >"$STATE_DIR/package-commit"
  run_logged "Install runtime dependencies" npm ci --prefix "$INSTALL_SOURCE_DIR" --omit=dev --ignore-scripts
  run_logged "Build the CLI" npx --yes --package typescript@5.7.3 tsc \
    -p "$INSTALL_SOURCE_DIR/tsconfig.install.json"
  run_logged "Prepare the CLI" node "$INSTALL_SOURCE_DIR/scripts/ensure-bin-mode.mjs"
  package_version="$(node -p 'require(process.argv[1] + "/package.json").version' "$INSTALL_SOURCE_DIR")"
  package_tarball="$STATE_DIR/orchestraai-agent-tools-$package_version.tgz"
  rm -f "$package_tarball"
  # npm pack always runs `prepare` for directory inputs. The installer already
  # produced dist with its no-typecheck build, so remove prepare only from this
  # temporary checkout before packaging it.
  run_logged "Disable redundant package prepare" npm pkg delete scripts.prepare --prefix "$INSTALL_SOURCE_DIR"
  # npm pack drops package-lock.json and `npm install -g <tarball>` would then
  # re-resolve every dependency range from the registry. Bundling the
  # lockfile-installed node_modules keeps the installed CLI on the tested tree.
  runtime_deps="$(node -p 'JSON.stringify(Object.keys(require(process.argv[1] + "/package.json").dependencies || {}))' "$INSTALL_SOURCE_DIR")"
  run_logged "Bundle pinned runtime dependencies" npm pkg set --prefix "$INSTALL_SOURCE_DIR" --json bundleDependencies="$runtime_deps"
  # Pack from the checkout: npm's directory-input path can omit bundled
  # node_modules even when bundleDependencies is set.
  (cd "$INSTALL_SOURCE_DIR" && run_logged "Pack Orchestra" npm pack . --ignore-scripts --pack-destination "$STATE_DIR")
  # Only now that a replacement tarball exists is the previous CLI removed.
  remove_previous_global_package
  run_logged "Install the orchestra command" npm install -g --ignore-scripts "$package_tarball"
  rm -rf "$INSTALL_SOURCE_DIR"
}

# ── sign-in ──────────────────────────────────────────────────────────
# The user signs in here, in their own terminal: `orchestra login --email`
# emails a one-time code and prompts for it, so the code never passes
# through a coding agent. --fresh-login first resets the login state (for
# demos); everything else under ~/.understudy is preserved.
CREDENTIALS_FILE="$HOME/.understudy/credentials.json"
KNOWN_EMAIL=""

credentials_email() {
  need node || return 0
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(c.email)process.stdout.write(c.email)}catch(e){}' "$CREDENTIALS_FILE" 2>/dev/null || true
}

is_github_noreply_email() {
  case "${1:-}" in
    *@users.noreply.github.com|*@noreply.github.com|noreply@github.com) return 0 ;;
    *) return 1 ;;
  esac
}

remember_known_email() {
  local candidate="${1:-}" source_label="${2:-email source}"
  [ -z "$candidate" ] && return 0
  if is_github_noreply_email "$candidate"; then
    say "Ignoring GitHub noreply email from $source_label; you can enter your real email for the sign-in."
    return 0
  fi
  KNOWN_EMAIL="$candidate"
}

prepare_agent_first_signin() {
  local existing_email=""
  [ -n "$ONLY_STEP" ] && return 0
  if [ -f "$CREDENTIALS_FILE" ]; then
    existing_email="$(credentials_email)"
    remember_known_email "$existing_email" "existing Orchestra credentials"
    if [ "$KEEP_LOGIN" = "1" ]; then
      if [ "$QUIET_RUN" = "1" ]; then
        if [ -n "$KNOWN_EMAIL" ]; then ok_unlogged "Signed in as $KNOWN_EMAIL"; else ok "Signed in to Orchestra"; fi
        return 0
      fi
      section "Orchestra account"
      if [ -n "$KNOWN_EMAIL" ]; then
        say_unlogged "Already signed in as $KNOWN_EMAIL; keeping that sign-in."
      else
        say "Already signed in; keeping that sign-in."
      fi
      return 0
    fi
    section "Orchestra account"
    # A --resume retry after the reset already happened in this install must
    # not sign the user out again (the agent may have signed in since).
    if [ "$RESUME" = "1" ] && [ -f "$STATE_DIR/login-reset.done" ]; then
      say "Keeping the current Orchestra sign-in; it was already reset earlier in this install (--resume)."
      return 0
    fi
    local backup
    backup="$HOME/.understudy/credentials.json.bak-$(date -u +"%Y%m%dT%H%M%SZ")"
    # Keep a single backup so retries do not accumulate copies of live keys.
    rm -f "$HOME/.understudy"/credentials.json.bak-*
    mv "$CREDENTIALS_FILE" "$backup"
    chmod 600 "$backup"
    rm -f "$HOME/.understudy/login-pending.json"
    private_mkdir "$STATE_DIR"
    date -u +"%Y-%m-%dT%H:%M:%SZ" >"$STATE_DIR/login-reset.done"
    if [ -n "$KNOWN_EMAIL" ]; then
      say_unlogged "Signed out $KNOWN_EMAIL so the sign-up runs from scratch (--fresh-login)."
    elif [ -n "$existing_email" ]; then
      ok "Signed out the existing Orchestra sign-in so the sign-up runs from scratch (--fresh-login)."
    else
      ok "Signed out so the sign-up runs from scratch (--fresh-login)."
    fi
    say "Only the login state was reset; profile, models, and history under ~/.understudy are untouched."
    say "Credentials backup: $backup"
    say "Restore it without re-signing in: mv \"$backup\" \"$CREDENTIALS_FILE\""
  fi
  if [ -z "$KNOWN_EMAIL" ]; then
    remember_known_email "$(git config --get user.email 2>/dev/null || true)" "git config user.email"
  fi
}

# Without a terminal (CI, --yes, agent shells) there is nobody to type the
# code, so the sign-in is left for `orchestra login` later.
sign_in_in_terminal() {
  local answer email
  [ -z "$ONLY_STEP" ] || return 0
  [ -f "$CREDENTIALS_FILE" ] && return 0
  if [ "$SKIP_LOGIN" = "1" ]; then
    say "Skipping the Orchestra sign-in; run \`orchestra login\` when you want an account."
    return 0
  fi
  need orchestra || return 0
  if [ "$YES" = "1" ] || noninteractive_enabled || ! { : </dev/tty >/dev/tty; } 2>/dev/null; then
    say "Not signed in. Run \`orchestra login\` in a terminal to create or sign in to your Orchestra account."
    return 0
  fi
  section "Sign in to Orchestra"
  say "Your Orchestra account gives the CLI and plugin a gateway API key. We email you a one-time code."
  if [ -n "$KNOWN_EMAIL" ]; then
    printf "  %s?%s Email %s[%s, or s to skip]%s " "$G4" "$R" "$D" "$KNOWN_EMAIL" "$R" >/dev/tty 2>/dev/null || return 0
  else
    printf "  %s?%s Email %s[s to skip]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null || return 0
  fi
  read -r answer </dev/tty 2>/dev/null || return 0
  case "$answer" in
    s|S|skip|SKIP)
      say "Skipped. Run \`orchestra login\` when you want an account."
      return 0
      ;;
  esac
  email="${answer:-$KNOWN_EMAIL}"
  if [ -z "$email" ]; then
    say "No email entered. Run \`orchestra login\` when you want an account."
    return 0
  fi
  log "RUN orchestra login --email <redacted>"
  if orchestra login --email "$email" </dev/tty >/dev/tty 2>&1; then
    ok "Signed in to Orchestra."
  else
    warn "The sign-in did not finish; the install continues. Run \`orchestra login\` to try again."
  fi
}

# ── local model lab ──────────────────────────────────────────────────
# Opt-in (--local-models or setup option 2), Apple Silicon only. Starts the
# managed MLX runtime install and the Orchestra 2B snapshot download (our MLX
# build of Gemma 4 E2B; catalog id $LOCAL_MODEL_ID)
# in the background so the user is never waiting on them; the onboarding skill
# reads $STATE_DIR/local-model-lab.json to report progress. uv is never
# installed silently: with Homebrew the user is asked first, otherwise they get
# the command to run, and the model download goes ahead either way.
LOCAL_MODEL_LAB_STARTED=0

ensure_uv_for_local_models() {
  need uv && return 0
  if need brew && [ "$YES" = "0" ] && ! noninteractive_enabled && { : </dev/tty >/dev/tty; } 2>/dev/null; then
    if confirm_default_yes "The MLX runtime needs uv. Install it with Homebrew (brew install uv)?"; then
      run_logged "Install uv with Homebrew" brew install uv && return 0
    fi
  fi
  warn "uv is not installed, so the MLX runtime was not set up. Install uv (brew install uv, or see https://docs.astral.sh/uv/), then run: orchestra models runtime install"
  return 1
}

start_local_model_lab() {
  local runtime_log pull_log runtime_pid="" pull_pid=""
  [ "$LOCAL_MODELS" = "1" ] || return 0
  [ -z "$ONLY_STEP" ] || return 0
  if ! local_models_supported; then
    warn "The local model lab needs an Apple Silicon Mac; skipping it."
    return 0
  fi
  if ! need orchestra; then
    warn "The orchestra command is not on PATH; skipping the local model lab."
    return 0
  fi
  step_section "Local model lab"
  private_mkdir "$LOG_DIR"
  private_mkdir "$STATE_DIR"
  runtime_log="$LOG_DIR/mlx-runtime-$(date -u +"%Y%m%dT%H%M%SZ").log"
  pull_log="$LOG_DIR/model-pull-$(date -u +"%Y%m%dT%H%M%SZ").log"
  if ensure_uv_for_local_models; then
    nohup orchestra models runtime install >"$runtime_log" 2>&1 </dev/null &
    runtime_pid="$!"
    ok "Installing the managed MLX runtime in the background."
  fi
  nohup orchestra models pull "$LOCAL_MODEL_ID" >"$pull_log" 2>&1 </dev/null &
  pull_pid="$!"
  ok "Downloading the Orchestra 2B model (about 3.6 GB) in the background."
  node -e '
    const [file, model, runtimeLog, runtimePid, pullLog, pullPid] = process.argv.slice(1);
    const lab = { model, started_at: new Date().toISOString(),
      runtime: runtimePid ? { log: runtimeLog, pid: Number(runtimePid) } : null,
      pull: { log: pullLog, pid: Number(pullPid) } };
    require("fs").writeFileSync(file, JSON.stringify(lab, null, 2) + "\n", { mode: 0o600 });
  ' "$STATE_DIR/local-model-lab.json" "$LOCAL_MODEL_ID" "$runtime_log" "$runtime_pid" "$pull_log" "$pull_pid"
  say "Progress: tail -f \"$pull_log\""
  say "It keeps going if you close this terminal; onboarding picks it up when it finishes."
  LOCAL_MODEL_LAB_STARTED=1
}

# GUI coding agents (Cursor, Codex, the Claude desktop app, ...) cannot be
# launched with a first message, so give the user the same one-line prompt
# Claude Code would get, ready to paste.
CLAUDE_LAUNCHED=0
AGENT_LAUNCHED=0

show_paste_prompt() {
  [ "$ADAPTERS_ATTEMPTED" != "1" ] || [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ] || return 0
  section "Paste into your coding agent"
  say "In a coding agent app (Cursor, Codex, Claude desktop, OpenCode, ...), open this project in a new chat and paste:"
  say_unlogged "  ${B}$INITIAL_CLAUDE_PROMPT${R}"
}

# Only when Claude Code is not opened here and a person is at the terminal:
# the prompt is the next thing they need.
copy_paste_prompt_to_clipboard() {
  [ "$ADAPTERS_ATTEMPTED" != "1" ] || [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ] || return 0
  [ "$YES" = "0" ] || return 0
  noninteractive_enabled && return 0
  { : </dev/tty >/dev/tty; } 2>/dev/null || return 0
  need pbcopy || return 0
  if printf '%s' "$INITIAL_CLAUDE_PROMPT" | pbcopy 2>/dev/null; then
    ok "Copied the prompt to your clipboard."
  fi
}

# The ending for a person at a terminal: what to paste into any coding agent
# (copied to the clipboard), the one thing each installed agent needs first,
# and an offer to start a terminal agent here with that prompt.
start_onboarding() {
  local copied="" first="" choices="" n=0 answer pick=""
  [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ] || return 0
  if need pbcopy && printf '%s' "$INITIAL_CLAUDE_PROMPT" | pbcopy 2>/dev/null; then
    copied=" (copied to your clipboard)"
  fi
  section "Start onboarding"
  say "Paste into your coding agent$copied:"
  say_unlogged "  ${B}$INITIAL_CLAUDE_PROMPT${R}"
  adapter_installed "claude-code" && first="${first:+$first · }Claude Code already open → /reload-plugins"
  adapter_installed "cursor" && first="${first:+$first · }Cursor → Developer: Reload Window"
  adapter_installed "codex" && first="${first:+$first · }Codex → enable orchestra in /plugins"
  adapter_installed "opencode" && first="${first:+$first · }OpenCode → new session"
  adapter_installed "hermes" && first="${first:+$first · }Hermes → /reload-skills"
  [ -z "$first" ] || say "${D}First: $first${R}"

  if ! should_run_step 3 || [ "$LAUNCH_CLAUDE" != "1" ]; then
    mark_step_done 3
    return 0
  fi
  if adapter_installed "claude-code" && [ "$NO_CLAUDE" = "0" ] && need claude; then
    n=$((n + 1)); choices="${choices}${n}:claude "
  fi
  if adapter_installed "codex" && need codex; then
    n=$((n + 1)); choices="${choices}${n}:codex "
  fi
  if [ "$n" -eq 0 ]; then
    mark_step_done 3
    return 0
  fi
  local line="Or start one here:" item
  for item in $choices; do
    line="$line   ${item%%:*}. $(agent_display_name "$( [ "${item#*:}" = claude ] && echo claude-code || echo "${item#*:}")")"
  done
  say "$line"
  printf "  %s?%s Start %s[1, or n to finish]%s " "$G4" "$R" "$D" "$R" >/dev/tty 2>/dev/null || { mark_step_done 3; return 0; }
  read -r answer </dev/tty 2>/dev/null || answer="n"
  case "$answer" in
    n|N|no|NO) mark_step_done 3; return 0 ;;
    "") answer=1 ;;
  esac
  for item in $choices; do
    [ "${item%%:*}" = "$answer" ] && pick="${item#*:}"
  done
  case "$pick" in
    claude)
      LAUNCH_CONFIRMED=1
      launch_claude_code
      ;;
    codex)
      say "Opening Codex here. If it can't find the Orchestra skill yet, enable orchestra in /plugins and send the prompt again."
      log "LAUNCH codex <initial-prompt>"
      AGENT_LAUNCHED=1
      codex "$INITIAL_CLAUDE_PROMPT" </dev/tty >/dev/tty 2>&1 || say "Codex exited with status $?."
      mark_step_done 3
      ;;
    *)
      say "No agent started. Paste the prompt into your coding agent when you're ready."
      mark_step_done 3
      ;;
  esac
}

compose_initial_prompt() {
  if [ -n "$USER_PROMPT_OVERRIDE" ]; then
    INITIAL_CLAUDE_PROMPT="$USER_PROMPT_OVERRIDE"
    return 0
  fi
  # Keep the handoff short and plain: the onboarding skill carries the flow,
  # and nothing here asks the agent to handle sign-in codes or the inbox.
  if lower_my_ant_bill_enabled; then
    INITIAL_CLAUDE_PROMPT="Use the Orchestra onboarding skill with the lower-Anthropic-bill path for this project, then the lower-anthropic-bill skill. Do not spend money, upload data, or call providers without my explicit approval and a cap."
  else
    INITIAL_CLAUDE_PROMPT="Use the Orchestra onboarding skill for this project."
  fi
  if [ ! -f "$CREDENTIALS_FILE" ]; then
    INITIAL_CLAUDE_PROMPT="$INITIAL_CLAUDE_PROMPT I'm not signed in to Orchestra yet; if an account is needed, ask me to run \`orchestra login\` in my terminal."
  fi
  if [ "$LOCAL_MODEL_LAB_STARTED" = "1" ]; then
    INITIAL_CLAUDE_PROMPT="$INITIAL_CLAUDE_PROMPT The installer started the local model lab in the background."
  fi
}

# Where plugin manifests and skills are read from, in order of trust: the
# directory of this file when the user ran it from a checkout, the current
# directory only with UNDERSTUDY_INSTALL_FROM_CWD=1 (developer flow), then the
# installed npm package. `curl | bash` runs inside the user's project, so a
# skills/ tree planted there must never be picked up on its own.
repo_candidates() {
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    (cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  fi
  if [ "${UNDERSTUDY_INSTALL_FROM_CWD:-0}" = "1" ]; then
    pwd
  fi
  printf '%s\n' "$PKG_DIR"
}
resolve_plugin_repo() {
  local manifest_dir="$1" repo
  while IFS= read -r repo; do
    if [ -f "$repo/$manifest_dir/plugin.json" ]; then
      printf '%s\n' "$repo"
      return 0
    fi
  done <<EOF
$(repo_candidates)
EOF
  return 1
}
resolve_skill_repo() {
  local repo
  while IFS= read -r repo; do
    if [ -f "$repo/skills/understudy/SKILL.md" ]; then
      printf '%s\n' "$repo"
      return 0
    fi
  done <<EOF
$(repo_candidates)
EOF
  return 1
}

install_claude_plugin() {
  if ! should_install_claude_adapter; then
    say "Claude Code adapter not selected or not detected; skipping Claude Code plugin install."
    # An explicit --no-claude is the user's own choice, not a missing adapter:
    # record it as "disabled" so it never trips the zero-adapter failure exit.
    if [ "$NO_CLAUDE" = "1" ]; then
      record_adapter "claude-code" "disabled" "disabled by --no-claude"
    else
      record_adapter "claude-code" "skipped" "not selected or not detected"
    fi
    return 0
  fi
  if ! need claude; then
    say "Claude Code CLI not found; skipping plugin install."
    say "Later, from a checkout, run: claude plugin marketplace add <repo> && claude plugin install orchestra@orchestra-skills"
    adapter_prereq_missing "claude-code" "the claude CLI is not on PATH"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".claude-plugin")"; then
    say "Could not find .claude-plugin/plugin.json; skipping Claude Code plugin install."
    adapter_prereq_missing "claude-code" ".claude-plugin/plugin.json was not found"
    return 0
  fi

  say "Installing the Orchestra Claude Code plugin from $repo."
  remove_legacy_claude_plugin
  repoint_claude_marketplace "$repo"
  if claude plugin list --json 2>/dev/null | grep -q 'orchestra@orchestra-skills'; then
    ok "Orchestra plugin already appears installed."
    record_adapter "claude-code" "installed" "already installed"
  else
    run_logged "Register the plugin marketplace" claude plugin marketplace add "$repo"
    run_logged "Install the Orchestra plugin" claude plugin install orchestra@orchestra-skills
    ok "Orchestra plugin installed."
    record_adapter "claude-code" "installed" "plugin installed"
  fi
  say "In Claude Code, type /reload-plugins once to activate the skills."
  say "Then type /orchestra:onboard to get started."
}

# Print the source path a marketplace listing (JSON on stdin) records for one
# marketplace name; Claude uses "path", Codex "root". Empty when absent.
marketplace_path() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c)).on("end", () => {
      try {
        const data = JSON.parse(raw);
        const list = Array.isArray(data) ? data : data.marketplaces || [];
        const hit = list.find((m) => m && m.name === process.argv[1]);
        if (hit) process.stdout.write(String(hit.path || hit.root || ""));
      } catch {}
    });
  ' "$1"
}

# orchestra-skills records the package folder it was added from. When the
# package moved (see LEGACY_PACKAGE_NAMES), drop the
# stale marketplace and plugin so the normal install below re-adds them from
# $1. A marketplace outside an Orchestra install is left alone.
repoint_claude_marketplace() {
  local repo="$1" current
  current="$(claude plugin marketplace list --json 2>/dev/null | marketplace_path orchestra-skills)"
  [ -n "$current" ] && [ "$current" != "$repo" ] || return 0
  case "$current" in
    */@orchestraai/agent-tools|*orchestra-agent-tools|*understudy-agent-tools) ;;
    *) return 0 ;;
  esac
  say "Moving the Orchestra Claude Code plugin from $current."
  log "RUN claude plugin uninstall orchestra@orchestra-skills"
  claude plugin uninstall orchestra@orchestra-skills >>"$LOG_FILE" 2>&1 || true
  log "RUN claude plugin marketplace remove orchestra-skills"
  claude plugin marketplace remove orchestra-skills >>"$LOG_FILE" 2>&1 || true
}

# Before the rename the plugin was understudy@understudy-skills. Left in place
# it would load every skill twice, so remove it and its marketplace (which
# points at this same checkout). Best-effort: a failure only leaves duplicates.
remove_legacy_claude_plugin() {
  if claude plugin list --json 2>/dev/null | grep -q 'understudy@understudy-skills'; then
    log "RUN claude plugin uninstall understudy@understudy-skills"
    if claude plugin uninstall understudy@understudy-skills >>"$LOG_FILE" 2>&1; then
      ok "Removed the old understudy plugin (now orchestra)."
    else
      warn "Could not remove the old understudy plugin; run: claude plugin uninstall understudy@understudy-skills"
    fi
  fi
  if claude plugin marketplace list 2>/dev/null | grep -q 'understudy-skills'; then
    log "RUN claude plugin marketplace remove understudy-skills"
    claude plugin marketplace remove understudy-skills >>"$LOG_FILE" 2>&1 || true
  fi
}

install_cursor_plugin() {
  if ! should_install_cursor_adapter; then
    say "Cursor adapter not selected or not detected; skipping Cursor plugin install."
    record_adapter "cursor" "skipped" "not selected or not detected"
    return 0
  fi

  local repo dest
  if ! repo="$(resolve_plugin_repo ".cursor-plugin")"; then
    say "Could not find .cursor-plugin/plugin.json; skipping Cursor plugin install."
    adapter_prereq_missing "cursor" ".cursor-plugin/plugin.json was not found"
    return 0
  fi

  dest="$HOME/.cursor/plugins/local/orchestra"
  say "Installing the Orchestra Cursor plugin from $repo."
  mkdir -p "$(dirname "$dest")"
  # Pre-rename installs linked the same checkout at local/understudy; only
  # remove that link when it is ours.
  local legacy="$HOME/.cursor/plugins/local/understudy"
  if [ -L "$legacy" ]; then
    case "$(readlink "$legacy" 2>/dev/null || true)" in
      */@orchestraai/agent-tools|*orchestra-agent-tools|*understudy-agent-tools) rm -f "$legacy" ;;
    esac
  fi
  if [ -L "$dest" ] && [ "$(readlink "$dest" 2>/dev/null || true)" = "$repo" ]; then
    ok "Orchestra Cursor plugin already points at $repo."
    record_adapter "cursor" "installed" "already installed"
  elif [ -L "$dest" ]; then
    local current
    current="$(readlink "$dest" 2>/dev/null || true)"
    case "$current" in
      */@orchestraai/agent-tools|*orchestra-agent-tools|*understudy-agent-tools)
        rm -f "$dest"
        ln -s "$repo" "$dest"
        ok "Orchestra Cursor plugin refreshed at $dest."
        record_adapter "cursor" "installed" "link refreshed"
        ;;
      *)
        warn "Cursor plugin path already exists at $dest; leaving it unchanged."
        say "Manual recovery: move that path aside, then rerun this installer."
        adapter_prereq_missing "cursor" "an existing non-Orchestra path occupies $dest"
        return 0
        ;;
    esac
  elif [ -e "$dest" ]; then
    warn "Cursor plugin path already exists at $dest; leaving it unchanged."
    say "Manual recovery: move that path aside, then rerun this installer."
    adapter_prereq_missing "cursor" "an existing non-Orchestra path occupies $dest"
    return 0
  else
    ln -s "$repo" "$dest"
    ok "Orchestra Cursor plugin linked at $dest."
    record_adapter "cursor" "installed" "plugin linked"
  fi
  say "In Cursor, restart the app or run Developer: Reload Window."
  say "Then ask Cursor Agent: Use the Orchestra onboarding skill for this project."
}

install_codex_plugin() {
  if ! should_install_codex_adapter; then
    say "Codex adapter not selected or not detected; skipping Codex marketplace registration."
    record_adapter "codex" "skipped" "not selected or not detected"
    return 0
  fi
  if ! need codex; then
    say "Codex CLI not found; skipping Codex marketplace registration."
    say "Later, from a checkout, run: codex plugin marketplace add <repo>"
    adapter_prereq_missing "codex" "the codex CLI is not on PATH"
    return 0
  fi

  local repo
  if ! repo="$(resolve_plugin_repo ".codex-plugin")"; then
    say "Could not find .codex-plugin/plugin.json; skipping Codex marketplace registration."
    adapter_prereq_missing "codex" ".codex-plugin/plugin.json was not found"
    return 0
  fi
  if [ ! -f "$repo/.agents/plugins/marketplace.json" ]; then
    say "Could not find .agents/plugins/marketplace.json; skipping Codex marketplace registration."
    adapter_prereq_missing "codex" ".agents/plugins/marketplace.json was not found"
    return 0
  fi

  # npm installs this package through a symlink into the durable source
  # checkout. Codex currently misclassifies that symlink as a Git marketplace
  # and injects a ref, which it then rejects for the local source. Hand Codex
  # the physical directory so local marketplace registration stays local.
  if ! repo="$(cd "$repo" && pwd -P)"; then
    say "Could not resolve the Codex marketplace source directory."
    adapter_prereq_missing "codex" "the marketplace source could not be resolved"
    return 0
  fi

  say "Registering the Orchestra Codex marketplace from $repo."
  # The marketplace was understudy-skills before the rename and points at the
  # same checkout; drop it so Codex doesn't list the skills twice.
  log "RUN codex plugin marketplace remove understudy-skills"
  codex plugin marketplace remove understudy-skills >>"$LOG_FILE" 2>&1 || true
  # Same for an orchestra-skills marketplace left at the pre-rename package
  # folder (Codex keys enabled plugins by name, not by folder).
  local current
  current="$(codex plugin marketplace list --json 2>/dev/null | marketplace_path orchestra-skills)"
  if [ -n "$current" ] && [ "$current" != "$repo" ]; then
    case "$current" in
      */@orchestraai/agent-tools|*orchestra-agent-tools|*understudy-agent-tools)
        log "RUN codex plugin marketplace remove orchestra-skills"
        codex plugin marketplace remove orchestra-skills >>"$LOG_FILE" 2>&1 || true
        ;;
    esac
  fi
  if codex plugin marketplace add "$repo" >>"$LOG_FILE" 2>&1; then
    ok "Orchestra Codex marketplace registered."
    record_adapter "codex" "installed" "marketplace registered"
  else
    say "Codex marketplace add failed; trying marketplace refresh."
    log "RUN codex plugin marketplace upgrade orchestra-skills"
    if codex plugin marketplace upgrade orchestra-skills >>"$LOG_FILE" 2>&1; then
      ok "Orchestra Codex marketplace refreshed."
      record_adapter "codex" "installed" "marketplace refreshed"
    else
      warn "Codex marketplace registration failed; continuing with the rest of the install."
      say "Manual recovery: run \`codex plugin marketplace remove orchestra-skills\`, then \`codex plugin marketplace add $repo\`."
      say "Codex details are in the install log: $LOG_FILE"
      record_adapter_failure "codex" "marketplace registration failed"
      return 0
    fi
  fi
  say "In Codex, run /plugins, choose the orchestra-skills marketplace, and install or enable the orchestra plugin."
  say "Then ask Codex: Use the Orchestra onboarding skill for this project."
}

link_opencode_path() {
  local src="$1" dest="$2" kind="$3" current
  if [ -L "$dest" ]; then
    current="$(readlink "$dest" 2>/dev/null || true)"
    if [ "$current" = "$src" ]; then
      return 0
    fi
    # A link to something that no longer exists holds nothing to protect.
    if [ ! -e "$dest" ]; then
      rm -f "$dest"
      ln -s "$src" "$dest"
      return 0
    fi
    case "$current" in
      */@orchestraai/agent-tools/skills/*|*/@orchestraai/agent-tools/.opencode/commands/*|*orchestra-agent-tools/skills/*|*orchestra-agent-tools/.opencode/commands/*|*understudy-agent-tools/skills/*|*understudy-agent-tools/.opencode/commands/*)
        rm -f "$dest"
        ln -s "$src" "$dest"
        return 0
        ;;
    esac
    [ "$kind" = "skill" ] || warn "OpenCode $kind already exists at $dest; leaving it unchanged."
    return 1
  fi
  if [ -e "$dest" ]; then
    [ "$kind" = "skill" ] || warn "OpenCode $kind already exists at $dest; leaving it unchanged."
    return 1
  fi
  ln -s "$src" "$dest"
}

install_opencode_adapter() {
  if ! should_install_opencode_adapter; then
    say "OpenCode adapter not selected or not detected; skipping OpenCode skill install."
    record_adapter "opencode" "skipped" "not selected or not detected"
    return 0
  fi

  local repo skill_root command_root skill skill_name linked skipped skipped_names command_src command_dest conflicts_file
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping OpenCode skill install."
    adapter_prereq_missing "opencode" "skills/understudy/SKILL.md was not found"
    return 0
  fi

  skill_root="$HOME/.config/opencode/skills"
  command_root="$HOME/.config/opencode/commands"
  mkdir -p "$skill_root" "$command_root"
  linked=0
  skipped=0
  skipped_names=""

  attention "OpenCode support is deprecated and will be removed in a future release; Claude Code, Codex and Cursor are the supported coding agents."
  say "Installing the Orchestra OpenCode skills from $repo."
  for skill in "$repo"/skills/*; do
    [ -f "$skill/SKILL.md" ] || continue
    skill_name="$(basename "$skill")"
    if link_opencode_path "$skill" "$skill_root/$skill_name" "skill"; then
      linked=$((linked + 1))
    else
      skipped=$((skipped + 1))
      skipped_names="${skipped_names}${skill_name}
"
    fi
  done

  command_src="$repo/.opencode/commands/orchestra-onboard.md"
  command_dest="$command_root/orchestra-onboard.md"
  if [ -f "$command_src" ]; then
    link_opencode_path "$command_src" "$command_dest" "command" || true
  fi
  # Pre-rename command; drop it only when it links into an Orchestra checkout.
  if [ -L "$command_root/understudy-onboard.md" ]; then
    case "$(readlink "$command_root/understudy-onboard.md" 2>/dev/null || true)" in
      */@orchestraai/agent-tools/.opencode/commands/*|*orchestra-agent-tools/.opencode/commands/*|*understudy-agent-tools/.opencode/commands/*) rm -f "$command_root/understudy-onboard.md" ;;
    esac
  fi

  ok "Orchestra OpenCode skills linked: $linked; skipped existing conflicts: $skipped."
  if [ "$skipped" -gt 0 ]; then
    # Folders or foreign links the installer did not create are never touched;
    # one summary instead of a warning per skill, with the names in a file.
    private_mkdir "$STATE_DIR"
    conflicts_file="$STATE_DIR/opencode-skill-conflicts.txt"
    printf '%s' "$skipped_names" >"$conflicts_file"
    local quiet_before="$QUIET_DETAIL"
    QUIET_DETAIL=0
    attention "$skipped OpenCode skills already exist in $skill_root as folders or links this installer did not create, so OpenCode keeps using those copies (names in $conflicts_file). To switch them to the current skills, move them aside and rerun with --agents opencode:" \
      "mkdir -p \"$skill_root.bak\" && while read -r s; do mv \"$skill_root/\$s\" \"$skill_root.bak/\"; done < \"$conflicts_file\""
    QUIET_DETAIL="$quiet_before"
  fi
  if [ "$linked" -gt 0 ]; then
    record_adapter "opencode" "installed" "linked $linked skills"
  else
    adapter_prereq_missing "opencode" "no skills were linked ($skipped existing path conflicts)"
  fi
  say "In OpenCode, restart the TUI or open a new session so skills and commands reload."
  say "Then run /orchestra-onboard, or ask OpenCode: Use the Orchestra onboarding skill for this project."
}

hermes_config_path() {
  printf '%s\n' "${HERMES_HOME:-$HOME/.hermes}/config.yaml"
}
# Locate a Python interpreter that can parse YAML, used to merge the skills
# path into an existing Hermes config without guessing its shape. macOS's
# /usr/bin/python3 only finds PyYAML via HOME-dependent user-site, so we also
# fall back to Hermes' own bundled venv interpreter, which always ships PyYAML
# and exists whenever the Hermes adapter is being installed.
hermes_yaml_python() {
  local cand hermes_home="${HERMES_HOME:-$HOME/.hermes}"
  for cand in \
    python3 \
    python \
    "$hermes_home/hermes-agent/venv/bin/python3" \
    "$hermes_home/hermes-agent/venv/bin/python"; do
    if command -v "$cand" >/dev/null 2>&1 && "$cand" -c 'import yaml' >/dev/null 2>&1; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  return 1
}
# A stable, install-location-independent path that Hermes can keep in its
# config even if the underlying checkout/package moves. We register this
# symlink (never a copy — the shared skills/ tree stays the single source of
# truth); a reinstall just re-points it.
hermes_stable_skills_link() {
  printf '%s\n' "$HOME/.understudy/skills"
}
# Resolve the path to register in skills.external_dirs: prefer the durable
# ~/.understudy/skills symlink, falling back to the resolved skills dir if a
# foreign file already occupies the link. Echoes the path to register.
hermes_register_dir() {
  local skills_dir="$1" stable_link current
  stable_link="$(hermes_stable_skills_link)"
  private_mkdir "$(dirname "$stable_link")"
  if [ -L "$stable_link" ]; then
    current="$(readlink "$stable_link" 2>/dev/null || true)"
    if [ "$current" = "$skills_dir" ]; then
      printf '%s\n' "$stable_link"; return 0
    fi
    # A link to a folder that no longer exists holds nothing to protect.
    if [ ! -e "$stable_link" ]; then
      rm -f "$stable_link"
      ln -s "$skills_dir" "$stable_link"
      printf '%s\n' "$stable_link"; return 0
    fi
    case "$current" in
      */@orchestraai/agent-tools/skills|*orchestra-agent-tools/skills|*understudy-agent-tools/skills)
        rm -f "$stable_link"
        ln -s "$skills_dir" "$stable_link"
        printf '%s\n' "$stable_link"; return 0
        ;;
      *)
        warn "An unexpected symlink already exists at $stable_link; registering the resolved skills path instead." >&2
        printf '%s\n' "$skills_dir"; return 0
        ;;
    esac
  elif [ -e "$stable_link" ]; then
    warn "A non-symlink path already exists at $stable_link; registering the resolved skills path instead." >&2
    printf '%s\n' "$skills_dir"; return 0
  fi
  ln -s "$skills_dir" "$stable_link"
  printf '%s\n' "$stable_link"
}

install_hermes_adapter() {
  if ! should_install_hermes_adapter; then
    say "Hermes adapter not selected or not detected; skipping Hermes skill registration."
    record_adapter "hermes" "skipped" "not selected or not detected"
    return 0
  fi

  local repo skills_dir register_dir config py status
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping Hermes skill registration."
    adapter_prereq_missing "hermes" "skills/understudy/SKILL.md was not found"
    return 0
  fi
  skills_dir="$repo/skills"
  register_dir="$(hermes_register_dir "$skills_dir")"
  config="$(hermes_config_path)"

  attention "Hermes support is deprecated and will be removed in a future release; Claude Code, Codex and Cursor are the supported coding agents."
  say "Registering the Orchestra skills with Hermes via $register_dir."

  if [ ! -f "$config" ]; then
    # Fresh Hermes: write a minimal user config. Hermes merges defaults at load
    # and `hermes config migrate` keeps our block, so this is non-destructive.
    mkdir -p "$(dirname "$config")"
    {
      printf 'skills:\n'
      printf '  external_dirs:\n'
      printf '    - %s\n' "$register_dir"
    } >"$config"
    ok "Created $config and registered Orchestra skills in skills.external_dirs."
    record_adapter "hermes" "installed" "registered in new config"
  elif py="$(hermes_yaml_python)"; then
    # Idempotent: the YAML merge is authoritative. It exits 3 when the path is
    # already in skills.external_dirs and leaves the file (and its comments)
    # untouched; it backs the config up only right before rewriting it.
    status=0
    "$py" - "$config" "$register_dir" >>"$LOG_FILE" 2>&1 <<'PY' || status=$?
import sys, os, shutil, yaml

cfg_path, skills_dir = sys.argv[1], sys.argv[2]
with open(cfg_path, encoding="utf-8") as f:
    cfg = yaml.safe_load(f) or {}
if not isinstance(cfg, dict):
    cfg = {}
skills = cfg.get("skills")
if not isinstance(skills, dict):
    skills = {}
    cfg["skills"] = skills
dirs = skills.get("external_dirs")
if dirs is None:
    dirs = []
elif isinstance(dirs, str):
    dirs = [dirs]
elif not isinstance(dirs, list):
    dirs = []
if skills_dir in dirs:
    sys.exit(3)
dirs.append(skills_dir)
skills["external_dirs"] = dirs
shutil.copyfile(cfg_path, cfg_path + ".understudy.bak")
with open(cfg_path, "w", encoding="utf-8") as f:
    yaml.safe_dump(cfg, f, sort_keys=False, default_flow_style=False)
PY
    case "$status" in
      0)
        ok "Registered Orchestra skills in $config (skills.external_dirs)."
        record_adapter "hermes" "installed" "registered"
        ;;
      3)
        ok "Orchestra skills already registered in $config (skills.external_dirs)."
        record_adapter "hermes" "installed" "already registered"
        ;;
      *)
        warn "Could not update $config automatically; continuing with the rest of the install."
        say "Manual step: add \"$register_dir\" to skills.external_dirs in $config (or run: hermes config edit)."
        record_adapter_failure "hermes" "could not update $config automatically"
        ;;
    esac
  elif grep -qF "$register_dir" "$config" 2>/dev/null; then
    # Without a YAML-capable Python a substring match is the best signal left.
    ok "Orchestra skills already registered in $config (skills.external_dirs)."
    record_adapter "hermes" "installed" "already registered"
  else
    warn "No YAML-capable Python found to edit $config safely; leaving it unchanged."
    say "Manual step: add \"$register_dir\" to skills.external_dirs in $config (run: hermes config edit)."
    record_adapter_failure "hermes" "no YAML-capable Python to edit $config"
  fi

  say "In Hermes, run /reload-skills (or start a new session) so it rescans skills.external_dirs."
  say "Then run /onboard, or ask Hermes: Use the Orchestra onboarding skill for this project."
}

install_devin_adapter() {
  if ! should_install_devin_adapter; then
    say "Devin adapter not selected or not detected; skipping Devin skill install."
    record_adapter "devin" "skipped" "not selected or not detected"
    return 0
  fi

  local repo
  if ! repo="$(resolve_skill_repo)"; then
    say "Could not find skills/understudy/SKILL.md; skipping Devin skill install."
    adapter_prereq_missing "devin" "skills/understudy/SKILL.md was not found"
    return 0
  fi

  say "Installing the Orchestra Devin adapter from $repo."
  # Devin is cloud-based: the CLI is the install surface (already handled in
  # step 1). The adapter just confirms the skills tree is accessible and the
  # .devin/adapter.json sentinel is present.
  if [ -f "$repo/.devin/adapter.json" ]; then
    ok "Orchestra Devin adapter sentinel found at $repo/.devin/adapter.json."
    record_adapter "devin" "installed" "skills tree accessible; sentinel present"
  else
    warn "Could not find .devin/adapter.json; the Devin version sentinel is missing."
    say "This does not block skill access — Devin reads AGENTS.md and the skills/ tree directly."
    record_adapter "devin" "installed" "skills tree accessible; sentinel missing"
  fi
  say "In Devin, ask: Use the Orchestra onboarding skill for this project."
  say "For persistent installs, run this installer with --yes --agents devin --no-launch-agent in the Devin environment blueprint."
}

install_agent_adapters() {
  ADAPTER_RESULTS=""
  EXPLICIT_ADAPTER_FAILED=0
  install_claude_plugin
  install_cursor_plugin
  install_codex_plugin
  install_opencode_adapter
  install_hermes_adapter
  install_devin_adapter
  summarize_agent_adapters
}

launch_claude_code() {
  if [ "$NO_CLAUDE" != "0" ]; then
    say "Skipping Claude Code launch because --no-claude is set."
    mark_step_done 3
    return 0
  fi
  if ! should_install_claude_adapter; then
    say "Skipping Claude Code launch because the Claude Code adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi
  if ! need claude; then
    if adapter_installed "claude-code"; then
      say "Claude Code CLI not found; open Claude Code manually and run /reload-plugins then /orchestra:onboard."
    else
      say "Claude Code CLI not found and the Orchestra plugin is not installed; install Claude Code, rerun this installer (or the manual plugin commands above), then run /reload-plugins and /orchestra:onboard."
    fi
    mark_step_done 3
    return 0
  fi
  if ! { : </dev/tty >/dev/tty; } 2>/dev/null; then
    say "No interactive terminal is available for Claude Code."
    say "Open Claude Code in this directory, then run /reload-plugins and /orchestra:onboard."
    mark_step_done 3
    return 0
  fi

  [ "${LAUNCH_CONFIRMED:-0}" = "1" ] || section "Step 3/3 · Open Claude Code"
  if [ "${LAUNCH_CONFIRMED:-0}" != "1" ] && ! { [ "$YES" = "1" ] || noninteractive_enabled; } && ! confirm_default_yes "Open Claude Code in $(pwd) now?"; then
    say "Open Claude Code here whenever you're ready, then run /orchestra:onboard."
    mark_step_done 3
    return 0
  fi
  local permission_args=()
  if [ -n "$CLAUDE_PERMISSION_MODE" ]; then
    permission_args=(--permission-mode "$CLAUDE_PERMISSION_MODE")
    say "Claude Code permission mode: $CLAUDE_PERMISSION_MODE (UNDERSTUDY_CLAUDE_PERMISSION_MODE)."
  fi
  say "Opening Claude Code with the Orchestra plugin. First message: ${D}$INITIAL_CLAUDE_PROMPT${R}"
  say "Exit Claude Code to return to this shell."
  log "LAUNCH claude ${permission_args[*]:-} --plugin-dir $PKG_DIR $(redact_url "${UNDERSTUDY_CLAUDE_ARGS:-}") <initial-prompt>"
  # curl | bash leaves stdin on the pipe, so Claude Code gets the terminal
  # directly. No session transcript is recorded.
  # shellcheck disable=SC2086
  CLAUDE_LAUNCHED=1
  AGENT_LAUNCHED=1
  claude ${permission_args[@]+"${permission_args[@]}"} --plugin-dir "$PKG_DIR" ${UNDERSTUDY_CLAUDE_ARGS:-} "$INITIAL_CLAUDE_PROMPT" </dev/tty >/dev/tty 2>&1 || {
    local status="$?"
    say "Claude Code exited with status $status."
    return "$status"
  }
  mark_step_done 3
}

launch_opencode() {
  if ! should_install_opencode_adapter; then
    say "Skipping OpenCode launch because the OpenCode adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Open OpenCode"
  say "OpenCode skills and commands are installed."
  say "Open a fresh OpenCode TUI session in: $(pwd)"
  say "Then run /orchestra-onboard."
  say "The installer does not auto-launch OpenCode because piped installers cannot reliably hand Bun/OpenCode a stable interactive TTY."
  mark_step_done 3
}

launch_hermes() {
  if ! should_install_hermes_adapter; then
    say "Skipping Hermes launch because the Hermes adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Open Hermes"
  say "The Orchestra skills are registered in Hermes via skills.external_dirs."
  say "Start a fresh Hermes session in: $(pwd)"
  say "  hermes"
  say "In an already-open session, run /reload-skills to pick them up without restarting."
  say "Then run /onboard, or ask Hermes: Use the Orchestra onboarding skill for this project."
  say "The installer does not auto-launch Hermes because piped installers cannot reliably hand it a stable interactive TTY."
  mark_step_done 3
}

launch_devin() {
  if ! should_install_devin_adapter; then
    say "Skipping Devin launch because the Devin adapter is not selected or detected."
    mark_step_done 3
    return 0
  fi
  if [ "$LAUNCH_CLAUDE" != "1" ]; then
    say "Skipping coding-agent launch because --no-launch-agent is set."
    mark_step_done 3
    return 0
  fi

  section "Step 3/3 · Devin"
  say "The Orchestra CLI and skills are installed."
  say "Devin is a cloud-based agent — it reads AGENTS.md and accesses the skills/ tree directly."
  say "Ask Devin: Use the Orchestra onboarding skill for this project."
  say "For persistent installs, run this installer with --yes --agents devin --no-launch-agent in the Devin environment blueprint."
  mark_step_done 3
}

launch_selected_agent() {
  if [ "$NO_CLAUDE" != "0" ] && ! should_install_opencode_adapter && ! should_install_hermes_adapter && ! should_install_devin_adapter; then
    say "Skipping coding-agent launch because --no-claude is set and no other launchable adapter is available."
    mark_step_done 3
    return 0
  fi
  if should_install_claude_adapter; then
    launch_claude_code
  elif should_install_opencode_adapter; then
    launch_opencode
  elif should_install_hermes_adapter; then
    launch_hermes
  elif should_install_devin_adapter; then
    launch_devin
  else
    say "Skipping coding-agent launch because the selected adapter has no automatic launch path."
    mark_step_done 3
  fi
}

need npm || {
  say "npm is required. Install Node.js 20+ first: https://nodejs.org"
  exit 1
}

validate_agent_platforms || exit 2
configure_resume

if [ "$YES" = "0" ] && ! noninteractive_enabled && { : </dev/tty >/dev/tty; } 2>/dev/null; then
  HUMAN_RUN=1
fi
case "$OUTPUT_MODE" in
  quiet) QUIET_RUN=1 ;;
  verbose) ;;
  *) [ "$FANCY" = "1" ] && [ "$HUMAN_RUN" = "1" ] && QUIET_RUN=1 ;;
esac

# A person at a terminal gets the guided setup from the CLI itself
# (`orchestra init`: menus, a checklist, sign-in, and the start screen). The
# installer only installs the CLI first. Scripts, CI, --yes and partial runs
# keep the installer's own steps below.
if [ "$HUMAN_RUN" = "1" ] && [ -z "$ONLY_STEP" ] && [ "$START_STEP" = "1" ] && [ "$RESUME" = "0" ] && [ "${UNDERSTUDY_INSTALL_GUIDED:-1}" = "1" ]; then
  banner
  printf '\n'
  QUIET_DETAIL=1
  install_understudy_package
  QUIET_DETAIL=0
  PKG_DIR="$(npm root -g)/$PACKAGE_NAME"
  if need orchestra; then
    UNDERSTUDY_HOME_MIGRATION=1 orchestra --version >/dev/null 2>>"$LOG_FILE" || true
  fi
  mark_step_done 1
  [ "$KEEP_LOGIN" = "1" ] || prepare_agent_first_signin
  ORCHESTRA_BIN="$(command -v orchestra || printf '%s/bin/orchestra' "$(npm prefix -g)")"
  # `init --help` is no test: commander answers it with the top-level help and
  # exit 0 on CLIs that have no init command. Look for init in the command list.
  if "$ORCHESTRA_BIN" --help 2>/dev/null | grep -qE '^[[:space:]]+init([[:space:]]|$)'; then
    INIT_ARGS=()
    [ "$LOCAL_MODELS" = "1" ] && INIT_ARGS+=(--local-models)
    [ "$SKIP_LOGIN" = "1" ] && INIT_ARGS+=(--skip-login)
    [ "$ADVANCED" = "1" ] && INIT_ARGS+=(--advanced)
    [ "$AGENT_PLATFORMS_EXPLICIT" = "1" ] && INIT_ARGS+=(--agents "$AGENT_PLATFORMS")
    lower_my_ant_bill_enabled && INIT_ARGS+=(--lower-anthropic-bill)
    [ "$LAUNCH_CLAUDE" = "1" ] || INIT_ARGS+=(--no-start)
    log "EXEC orchestra init ${INIT_ARGS[*]:-}"
    export UNDERSTUDY_LAB="$LAB" ORCHESTRA_INIT_FROM_INSTALLER=1
    exec "$ORCHESTRA_BIN" init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"} </dev/tty >/dev/tty 2>&1
  fi
  warn "This CLI has no guided setup; continuing with the installer's own steps."
  START_STEP=2
fi

banner
if [ "$FANCY" = "1" ]; then
  section "Welcome"
else
  section "Welcome. We are going to install Orchestra for your coding agent."
fi
say "This installer sets up the Orchestra CLI, your Orchestra account, and the plugin for your coding agents."
QUIET_DETAIL="$QUIET_RUN"
if [ -n "$INSTALL_PACKAGE" ]; then
  warn "Source: npm package $(redact_url "$INSTALL_PACKAGE") (UNDERSTUDY_INSTALL_PACKAGE override) ${D}(installer commit: $INSTALLER_COMMIT)${R}"
elif [ "$INSTALL_SOURCE_OVERRIDDEN" = "1" ]; then
  warn "Source: $(redact_url "$INSTALL_REPO_URL")#$INSTALL_REF (non-default, set by UNDERSTUDY_INSTALL_* environment) ${D}(installer commit: $INSTALLER_COMMIT)${R}"
else
  say "Source: $INSTALL_REPO_URL#$INSTALL_REF ${D}(installer commit: $INSTALLER_COMMIT)${R}"
fi
say "Install log: $LOG_FILE"
QUIET_DETAIL=0
choose_setup
select_agent_platforms
# After a menu choice the plan is already on screen in the person's own
# words; keep the restatement for the log.
if [ "$QUIET_RUN" = "1" ] && [ "$SETUP_MENU_ANSWERED" = "1" ]; then
  QUIET_DETAIL=1
fi
report_agent_selection
say "${B}Install plan${R}"
say "  ${G2}1.${R} Install the Orchestra CLI."
if [ "$SKIP_LOGIN" = "1" ]; then
  say "  ${G3}·${R}  Skip the Orchestra sign-in (run \`orchestra login\` later)."
elif [ "$KEEP_LOGIN" = "0" ]; then
  say "  ${G3}·${R}  Sign out any existing sign-in first (--fresh-login; backup kept), then sign in here."
else
  say "  ${G3}·${R}  Sign in to your Orchestra account here, unless you already are."
fi
say "  ${G4}2.${R} $(agent_plan_label)"
if [ "$LOCAL_MODELS" = "1" ]; then
  say "  ${G5}·${R}  Start the local model lab in the background (MLX runtime + Orchestra 2B model, about 3.6 GB)."
fi
say "  ${G5}3.${R} Offer to open Claude Code here, or finish with reload instructions."
if lower_my_ant_bill_enabled; then
  say "  ${G6}·${R}  Focus onboarding on the lower Anthropic bill audit path."
fi
say ""
say "This installer writes only under $LAB, $HOME/.understudy, the global npm prefix, and selected coding-agent plugin state."
QUIET_DETAIL=0
if [ "$LOCAL_MODELS" != "1" ]; then
  say "No model weights are downloaded and no frontier calls are made. Add the local model lab any time with --local-models."
fi
if [ -n "${UNDERSTUDY_INSTALL_SOURCE_DIR:-}" ]; then
  say "Scratch checkout (UNDERSTUDY_INSTALL_SOURCE_DIR): $INSTALL_SOURCE_DIR is deleted before and after the install."
fi
# Picking an option in the setup menu is the go-ahead; every other path
# (flags, --require-confirm, no menu) still confirms the plan.
if [ "$SETUP_MENU_ANSWERED" != "1" ]; then
  confirm "Continue with this Orchestra installation?" || exit 1
fi

PKG_DIR="$(npm root -g)/$PACKAGE_NAME"

if should_run_step 1; then
  step_section "Step 1/3 · Install the CLI"
  QUIET_DETAIL="$QUIET_RUN"
  install_understudy_package
  QUIET_DETAIL=0
  if [ "$QUIET_RUN" = "1" ] && need orchestra; then
    ok "Orchestra CLI $(orchestra --version 2>/dev/null || true)"
  fi
  PKG_DIR="$(npm root -g)/$PACKAGE_NAME"
  # Move ~/.understudy to ~/.orchestra (leaving a symlink) now, before the
  # coding agent starts; every path this installer writes later goes through
  # the symlink. The CLI only does this when asked, so stderr stays visible.
  if need orchestra; then
    UNDERSTUDY_HOME_MIGRATION=1 orchestra --version >/dev/null || true
  fi
  mark_step_done 1
else
  say "Skipping step 1/3: install the CLI."
fi

prepare_agent_first_signin
sign_in_in_terminal

if should_run_step 2; then
  step_section "Step 2/3 · Install agent adapters"
  QUIET_DETAIL="$QUIET_RUN"
  install_agent_adapters
  QUIET_DETAIL=0
  # An incomplete adapter install must not be marked resumable-complete, or a
  # later --resume would start at step 3 and exit 0 with no plugin installed.
  if [ "$(adapter_exit_code)" = "0" ]; then
    mark_step_done 2
  else
    warn "Step 2 is not marked complete because adapter installation was incomplete; rerun with --resume to retry the adapters."
  fi
else
  say "Skipping step 2/3: install agent adapters."
fi

start_local_model_lab
compose_initial_prompt

print_attention
# A person at the terminal gets one ending: what to paste, what each agent
# needs first, and an offer to start a terminal agent. Scripts and CI keep
# the full per-agent instructions.
if [ "$HUMAN_RUN" = "1" ] && [ "$ADAPTERS_ATTEMPTED" = "1" ] && [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ]; then
  start_onboarding
else
  section "Where this goes next"
  # Only promise per-agent next steps for adapters that actually installed;
  # when the adapter step ran and installed nothing, hand out recovery
  # instructions instead of claiming the skills are ready.
  if [ "$ADAPTERS_ATTEMPTED" != "1" ]; then
    say "The installer is done. The next experience belongs inside your coding agent:"
    say "  Claude Code: run /reload-plugins and then /orchestra:onboard."
    say "  Cursor: restart Cursor or run Developer: Reload Window, then ask Cursor Agent to use the Orchestra onboarding skill."
    say "  Codex: run /plugins, install or enable orchestra, then ask Codex to use the Orchestra onboarding skill."
    say "  OpenCode: restart the TUI or open a new session, then run /orchestra-onboard."
    say "  Hermes: run /reload-skills in an open session (or start a new hermes session), then run /onboard or ask Hermes to use the Orchestra onboarding skill."
    say "  Devin: ask Devin to use the Orchestra onboarding skill for this project. For persistent installs, run this installer with --yes --agents devin --no-launch-agent in the Devin environment blueprint."
  elif [ "$ADAPTERS_INSTALLED_COUNT" -eq 0 ]; then
    if [ "$(normalize_agent_platform "$AGENT_PLATFORMS")" = "none" ]; then
      say "The installer is done. No coding-agent plugins were requested, so only the orchestra CLI was installed."
      say "Rerun this installer with --agents claude-code (or another adapter) when you want the skills inside a coding agent."
    elif [ "${ADAPTERS_UNMET_COUNT:-0}" -eq 0 ]; then
      say "The installer is done. Every selected coding-agent adapter was disabled by a flag (e.g. --no-claude), so only the orchestra CLI was installed."
      say "Rerun this installer without the disable flag (or with --agents <adapter>) when you want the skills inside a coding agent."
    else
      fail_line "The installer finished, but no coding-agent plugin was installed — the Orchestra skills are NOT ready in any coding agent."
      say "Use the manual install commands above (or rerun this installer with --agents <adapter>), then run the platform's reload step before onboarding."
    fi
  else
    say "The installer is done. The next experience belongs inside your coding agent:"
    if adapter_installed "claude-code"; then
      say "  Claude Code: run /reload-plugins and then /orchestra:onboard."
    fi
    if adapter_installed "cursor"; then
      say "  Cursor: restart Cursor or run Developer: Reload Window, then ask Cursor Agent to use the Orchestra onboarding skill."
    fi
    if adapter_installed "codex"; then
      say "  Codex: run /plugins, install or enable orchestra, then ask Codex to use the Orchestra onboarding skill."
    fi
    if adapter_installed "opencode"; then
      say "  OpenCode: restart the TUI or open a new session, then run /orchestra-onboard."
    fi
    if adapter_installed "hermes"; then
      say "  Hermes: run /reload-skills in an open session (or start a new hermes session), then run /onboard or ask Hermes to use the Orchestra onboarding skill."
    fi
    if adapter_installed "devin"; then
      say "  Devin: ask Devin to use the Orchestra onboarding skill for this project. For persistent installs, run this installer with --yes --agents devin --no-launch-agent in the Devin environment blueprint."
    fi
  fi
  if lower_my_ant_bill_enabled; then
    say "Focused path: lower Anthropic bill. Ask the agent to use onboarding with the lower-Anthropic-bill path, then run the lower-anthropic-bill skill."
  fi
  if [ "$ADAPTERS_ATTEMPTED" != "1" ] || [ "$ADAPTERS_INSTALLED_COUNT" -gt 0 ]; then
    [ "$QUIET_RUN" = "1" ] || say "Onboarding profiles your setup, asks what you're working on, and points the plugin at your real workload."
  fi
  show_paste_prompt
  if should_run_step 3; then
    launch_selected_agent
  else
    say "Skipping step 3/3: open coding agent."
  fi
  if [ "$CLAUDE_LAUNCHED" != "1" ]; then
    copy_paste_prompt_to_clipboard
  fi
fi
if [ "$QUIET_RUN" = "1" ]; then
  say "${D}Full install log: $LOG_FILE${R}"
fi

INSTALL_EXIT="$(adapter_exit_code)"
if [ "$INSTALL_EXIT" != "0" ]; then
  fail_line "Installer finished, but adapter installation was incomplete; exiting with status $INSTALL_EXIT."
  say "See the adapter summary above and the install log: $LOG_FILE"
  exit "$INSTALL_EXIT"
fi
