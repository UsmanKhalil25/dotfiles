# Pi agent setup

Portable configuration for Pi's global agent directory.

## Install

From the repository root, run:

```sh
./pi/setup.sh
```

The script copies the tracked configuration into `${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}`, creates a timestamped backup when an existing file differs, and installs the pinned Pi packages.

You need to install Pi itself before running the script. Authenticate providers separately inside Pi with `/login`; credentials and session history are intentionally not tracked.

## Managed configuration

- `agent/settings.json` — Pi preferences and pinned package versions.
- `agent/modes.config.json` — allows Pi Web Access in Ask and Plan modes.
- `agent/statusline.json` — enables `@pi-extensions/pi-statusline`, keeps provider usage off, and hides token-speed indicators.

Yolo mode is unrestricted by default in `pi-agent-modes`, so it needs no additional tool allowlist entry.

## Platform notes

The setup script is POSIX-compatible and is intended for Linux and macOS. The packages install their own dependencies. `pi-web-access` only needs extra system packages such as `ffmpeg` or `yt-dlp` for optional video and frame-analysis features.

Do not add these machine-specific or sensitive files to the repository:

- `auth.json`
- `trust.json`
- `sessions/`
- `web-search.json` when it contains API keys
- the generated `npm/` package installation directory
