# Pi agent setup

Portable configuration for Pi's global agent directory.

## Install

From the repository root, run:

```sh
./pi/setup.sh
```

The script copies the tracked configuration into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`, creates a timestamped backup when an existing file differs, and installs the pinned Pi packages. Set `PI_CODING_AGENT_DIR` to a temporary directory to test the setup without changing your real global Pi configuration.

You need to install Pi itself before running the script. Authenticate providers separately inside Pi with `/login`; credentials and session history are intentionally not tracked. The configuration is currently verified with Pi 0.84.2.

## Managed configuration

- `agent/settings.json` — Pi preferences and pinned package versions.
- `agent/modes.config.json` — allows Pi Web Access in Ask and Plan modes.
- `agent/statusline.json` — enables `@pi-extensions/pi-statusline`, keeps provider usage off, and hides token-speed indicators.
- `agent/APPEND_SYSTEM.md` — shared communication, research, and citation guidance appended to Pi's system prompt.
- `agent/plan-artifacts.json` — configures project plan storage, context previews, non-interactive plan completion, and worker RPC timeout.
- `agent/extensions/plan-artifacts.ts` — persists plans, revisions, context, model completion, plan UI compatibility, and detached worker commands.
- `agent/agents/plan-worker.md` — Build-mode worker definition used by `pi-subagents`.

## Project plans and workers

Plan artifacts are written to the current project (the `cwd` where Pi is running), never to Pi's global session artifact directory. Files use chronological UTC filenames in the project's `.plans/` directory:

```text
.plans/20260815-024800Z-add-pi-subagent-workflow.md
```

Useful commands:

```text
/plans
/plans latest
/plans show <plan-id>
/plans history <plan-id>
/plans revise <feedback>
/plans approve <plan-id>
/sub-agent <provider/model> [plan-id]
```

Plan mode only saves the accepted plan and ends the current turn. It does not show the pi-agent-modes Execute/Stay/Refine prompt or the plan todo widget. The compatibility behavior is enabled by default in `plan-artifacts.json` and is tested against `pi-agent-modes@0.3.0`.

After approving a plan, switch to Build, Debug, or Yolo and start one detached worker manually:

```text
/plans approve <plan-id>
/mode build
/sub-agent opencode-go/gpt-5.6-luna <plan-id>
```

Model arguments have autocomplete from Pi's live model registry. If the model is omitted in the interactive TUI, `/sub-agent` opens a searchable model picker. The command launches exactly one fresh `plan-worker` through the pi-subagents RPC bridge and returns immediately; the parent Pi session remains available for other work. The active plan context reports the worker model, run ID, and status on later turns.

Yolo mode is unrestricted by default in `pi-agent-modes`, so it needs no additional tool allowlist entry.

## Platform notes

The setup script is POSIX-compatible and is intended for Linux and macOS. The packages install their own dependencies. `pi-web-access` only needs extra system packages such as `ffmpeg` or `yt-dlp` for optional video and frame-analysis features.

Project `.plans/` files are the durable plan records. Pi-subagents diagnostic files under `~/.pi/agent/sessions/.../subagent-artifacts/` are runtime evidence and are intentionally not copied into the repository.

The plan-artifact helper tests can be run from the repository root with:

```sh
node --experimental-strip-types --test pi/tests/plan-artifacts.test.mjs
```

To validate installation without touching your normal Pi directory:

```sh
PI_CODING_AGENT_DIR="$(mktemp -d)" ./pi/setup.sh
```

The setup script installs these exact package versions in both `settings.json` and its install list:

- `pi-web-access@0.22.0`
- `pi-agent-modes@0.3.0`
- `@pi-extensions/pi-statusline@0.1.3`
- `pi-subagents@0.49.0`

Do not add these machine-specific, generated, or sensitive files to the repository:

- `auth.json`
- `trust.json`
- `sessions/`
- `web-search.json` when it contains API keys
- `models-store.json`
- the generated `npm/` package installation directory
- timestamped `*.backup.*` files

The repository tracks static configuration and source files only. Provider credentials, project trust decisions, session history, installed package trees, model catalogs, and setup backups must be recreated locally.
