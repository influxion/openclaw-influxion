# openclaw-influxion

An [OpenClaw](https://openclaw.ai) plugin that periodically collects agent session transcripts and uploads them to [Influxion](https://influxion.ai) for agent performance evaluation.

## Installation

```bash
openclaw plugins install openclaw-influxion
```

Or for local development from this repo:

```bash
openclaw plugins install /path/to/openclaw-influxion
```

## Configuration

Add the following to `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "influxion": {
        "enabled": true,
        "config": {
          "apiKey": "inf_live_xxxxxxxxxxxx",
          "deploymentId": "my-openclaw-setup",

          "upload": {
            "every": "15m",
            "retryAttempts": 3,
            "retryBackoffMs": 5000,
            "timeoutMs": 30000,
            "maxFilesPerRun": 50,
            "maxBytesPerRun": 10485760
          },

          "filter": {
            "agents": {
              "allow": [],
              "deny": []
            },
            "sessions": {
              "deny": ["tmp-*", "scratch-*"]
            },
            "minMessages": 2,
            "minBytes": 512
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

## How It Works

1. The plugin registers a background service that runs on a configurable interval (default: every 15 minutes).
2. On each run, it scans `~/.openclaw/agents/*/sessions/*.jsonl` for session transcripts.
3. It applies agent and session filters to exclude unwanted sessions.
4. New or modified files (tracked via an upload ledger at `~/.openclaw/extensions/influxion/state.json`) are uploaded as NDJSON to the Influxion API.
5. The ledger is updated so unchanged files are skipped on future runs.

## License

MIT
