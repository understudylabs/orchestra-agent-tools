---
name: install-cursor-plugin
description: Compatibility shim for Cursor installs. Use when a developer asks to install, update, enable, reinstall, remove, or verify the Orchestra Cursor plugin - "install Orchestra in Cursor", "add the Cursor plugin", "make Cursor see the skills". Route to install-agent-adapter with platform cursor.
metadata:
  understudy:
    mode: automatic
    safety: local-first
    cli_required: false
---

# Install the Orchestra Cursor plugin

This skill is a compatibility shim. The consolidated setup surface is
[`install-agent-adapter`](../install-agent-adapter/SKILL.md).

## Procedure

Load `install-agent-adapter` and run it with platform `cursor`.

Use its [`reference.md`](../install-agent-adapter/reference.md#cursor) for the
current symlink install:

```bash
REPO="$(cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && pwd)"
dest="$HOME/.cursor/plugins/local/orchestra"
mkdir -p "$(dirname "$dest")"
if [ ! -f "$REPO/.cursor-plugin/plugin.json" ]; then
  echo "not an Orchestra checkout: $REPO"
elif [ -L "$dest" ] && case "$(readlink "$dest")" in "$REPO"|*/@orchestraai/agent-tools|*orchestra-agent-tools|*understudy-agent-tools) true ;; *) false ;; esac; then
  # Refresh only a symlink Orchestra created; never delete a real directory.
  rm -f "$dest" && ln -s "$REPO" "$dest"
elif [ -e "$dest" ] || [ -L "$dest" ]; then
  echo "skip: existing non-Orchestra path at $dest (move it aside, then rerun)"
else
  ln -s "$REPO" "$dest"
fi
```

Activation:

```text
Developer: Reload Window
```

Then ask Cursor Agent:

```text
Use the Orchestra onboarding skill for this project.
```

## Safety Gates

Local-first and free: installing the Cursor adapter only links local skills. It
must not authenticate, upload data, inspect secret values, download model
weights, start hosted jobs, or make provider calls.

- Only replace an Orchestra-owned symlink at the exact
  `~/.cursor/plugins/local/orchestra` path; leave any other file, directory,
  or symlink there unchanged and tell the developer.
- Do not edit Cursor internal settings databases.
- Do not copy private traces, keys, or `.understudy/` state into the plugin.

## Resolve CLI

No Orchestra CLI command is required. Use shell to create the local symlink after
confirming the repo contains `.cursor-plugin/plugin.json`.

## Output Standard

End with: that this routed through `install-agent-adapter`; whether the Cursor
plugin was installed/refreshed/shown for manual run; the reload step; the next
onboarding prompt; and the uninstall command.
