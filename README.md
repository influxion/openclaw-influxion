# OpenClaw Influxion Plugin

An [OpenClaw](https://openclaw.ai) plugin that periodically collects agent session transcripts and skills and shares them with [Influxion](https://www.influxion.io/) for agent performance evaluations and recommendations.

See below for instructions on configuring data sharing at finer granularities.

## Installation

```bash
openclaw plugins install influxion
```

Or for local development from this repo:

```bash
openclaw plugins install /path/to/openclaw-influxion
```

### Warnings

You may see a message like:

> Plugin "influxion" has 1 suspicious code pattern(s). Run "openclaw security audit --deep" for details.

This is expected. If you run the audit, you may see a result like:

```
plugins.code_safety Plugin "influxion" contains suspicious code patterns
  Found 1 warning(s) in 14 scanned file(s):
  - [potential-exfiltration] File read combined with network send — possible data exfiltration (src/uploader.ts:1)
  Fix: Review the flagged code to ensure it is intentional and safe.
```

This is accurate and by design.
See below for configuration options to limit the data shared with Influxion.

## Configuration

Plugin config lives inside the `plugins.entries.influxion.config` key in `~/.openclaw/openclaw.json`. Edit the file directly — OpenClaw has no `configure set` subcommand for arbitrary keys.

### Minimal setup

```jsonc
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "influxion": {
        "enabled": true,
        "config": {
          "apiKey": "sk-xxxxxxxxxxxx",
          "deploymentId": "my-openclaw-setup",
          "projectId": "00000000-0000-0000-0000-000000000000"
        }
      }
    }
  }
}
```

Restart the gateway after saving (`openclaw gateway restart` or via the OpenClaw menu bar app).

### All options

```jsonc
{
  "plugins": {
    "entries": {
      "influxion": {
        "enabled": true,
        "config": {
          // Required
          "apiKey": "sk-xxxxxxxxxxxx",
          "deploymentId": "my-openclaw-setup",
          "projectId": "00000000-0000-0000-0000-000000000000",

          // Optional — override the API base URL (e.g. for self-hosted or local dev)
          "apiUrl": "https://api.influxion.io",

          "upload": {
            "every": "15m",        // Upload interval. Accepts: 30s, 5m, 1h, etc. Set to "0" to disable.
            "retryAttempts": 3,    // Number of retry attempts on failure
            "retryBackoffMs": 5000,
            "timeoutMs": 30000,
            "maxFilesPerRun": 50,
            "maxBytesPerRun": 10485760  // 10 MB
          },

          "filter": {
            "agents": {
              "allow": [],  // If non-empty, only these agent IDs are uploaded
              "deny": []    // These agent IDs are never uploaded (takes precedence over allow)
            },
            "sessions": {
              "deny": ["tmp-*", "scratch-*"]  // Glob patterns for session IDs to skip
            },
            "minMessages": 2,   // Skip sessions with fewer than this many messages
            "minBytes": 512     // Skip session files smaller than this
          }
        }
      }
    }
  }
}
```

## CLI Commands

```bash
# Show plugin status and pending file count
openclaw influxion status

# Trigger an immediate upload cycle
openclaw influxion sync
```

## Development

```bash
npm install
npm test
npm run typecheck
```

Uninstalling and reinstalling during development is a little manual.
You should uninstall with:

```bash
openclaw plugins uninstall --force influxion
```

You then should delete the directory at `~/.openclaw/extensions/influxion` and probably restart the OpenClaw gateway.
Sometimes the gateway doesn't stop with `openclaw gateway stop` and you may need to `killall openclaw-gateway`.
Then start it again and reinstall from your development source.

You will need to reconfigure the plugin in your `openclaw.json` file after every reinstall, e.g.:

```json
      "influxion": {
        "enabled": true,
        "config": {
          "apiUrl": "http://localhost:8000",
          "apiKey": "sk-xxxxxxxxxxxx",
          "deploymentId": "my-openclaw-setup",
          "projectId": "59b21a5c-d0cd-4477-96ac-ed6e9fcded75"
        }
      }
```

When testing Influxion itself, it's often sufficient to just delete the `state.json` file in the influxion plugin directory.
The plugin will then upload the sessions logs again, which you can force immediately with `openclaw influxion sync`.


## How It Works

1. The plugin registers a background service that runs on a configurable interval (default: every 15 minutes).
2. On each run, it scans `~/.openclaw/agents/*/sessions/*.jsonl` for session transcripts.
3. It applies agent and session filters to exclude unwanted sessions.
4. New or modified files (tracked via an upload ledger at `~/.openclaw/extensions/influxion/state.json`) are uploaded as NDJSON to the Influxion API.
5. The ledger is updated so unchanged files are skipped on future runs.
