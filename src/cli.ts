import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginCliRegistrar } from "openclaw/plugin-sdk";
import type { InfluxionConfig } from "./config.js";
import { readLedger } from "./ledger.js";
import { collectEligibleFiles } from "./collector.js";
import { runUploadCycle } from "./service.js";

/**
 * Resolve the OpenClaw state directory (where agents/ and extensions/ live).
 * Mirrors the logic openclaw itself uses: env var override, then ~/.openclaw.
 */
function resolveStateDir(): string {
  return process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
}

function maskApiKey(key: string): string {
  if (key.length <= 12) return "***";
  return key.slice(0, 8) + "..." + key.slice(-4);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Register the `openclaw influxion` subcommand group.
 * Returns an `OpenClawPluginCliRegistrar` that closes over the resolved config.
 */
export function registerInfluxionCli(cfg: InfluxionConfig): OpenClawPluginCliRegistrar {
  return ({ program }) => {
    const influxion = program
      .command("influxion")
      .description("Influxion agent session upload commands");

    // ── influxion status ───────────────────────────────────────────────────
    influxion
      .command("status")
      .description("Show Influxion plugin status and pending file count")
      .action(async () => {
        const stateDir = resolveStateDir();
        const ledger = await readLedger(stateDir);
        const pending = await collectEligibleFiles(
          stateDir,
          ledger,
          cfg.filter,
          cfg.upload.maxFilesPerRun,
        );

        const uploadedCount = Object.keys(ledger.files).length;
        const lastRun = ledger.lastRunAt ?? "never";

        console.log("");
        console.log("Influxion Status");
        console.log("────────────────────────────────");
        console.log(`  API Key:        ${maskApiKey(cfg.apiKey)}`);
        console.log(`  Deployment ID:  ${cfg.deploymentId}`);
        console.log(`  API URL:        ${cfg.apiUrl}`);
        console.log(`  Upload every:   ${cfg.upload.every}`);
        console.log(`  Last run:       ${lastRun}`);
        console.log(`  Pending files:  ${pending.length}`);
        console.log(`  Ledger entries: ${uploadedCount}`);

        if (pending.length > 0) {
          console.log("");
          console.log("  Pending:");
          for (const f of pending) {
            console.log(`    ${f.agentId}/${f.sessionId}  (${formatBytes(f.stat.size)})`);
          }
        }
        console.log("");
      });

    // ── influxion sync ─────────────────────────────────────────────────────
    influxion
      .command("sync")
      .description("Trigger an immediate upload cycle (blocking)")
      .action(async () => {
        const stateDir = resolveStateDir();

        console.log("Running Influxion upload cycle...");

        const logger = {
          info: (msg: string) => console.log(`  ${msg}`),
          warn: (msg: string) => console.warn(`  [warn] ${msg}`),
          error: (msg: string) => console.error(`  [error] ${msg}`),
        };

        try {
          const result = await runUploadCycle({ stateDir, logger }, cfg);
          console.log("");
          console.log(
            `Done — uploaded: ${result.uploaded}, failed: ${result.failed}, ` +
              `lines: ${result.totalLines}, bytes: ${formatBytes(result.totalBytes)}`,
          );
        } catch (err) {
          console.error(`Sync failed: ${String(err)}`);
          process.exitCode = 1;
        }
      });
  };
}
