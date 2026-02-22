import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InfluxionConfig } from "./config.js";
import { readLedger, writeLedger, isSkillDirty } from "./ledger.js";
import { collectEligibleSessions } from "./sessions-collector.js";
import { collectSkills } from "./skills-collector.js";
import { runUploadCycle } from "./service.js";

/**
 * Resolve the OpenClaw state directory (where agents/ and extensions/ live).
 * Mirrors the logic openclaw itself uses: env var override, then ~/.openclaw.
 */
function resolveStateDir(): string {
  return process.env["OPENCLAW_STATE_DIR"] ?? join(homedir(), ".openclaw");
}

/**
 * Load the OpenClaw config from disk.
 * Returns null if the file is missing or unparseable (graceful degradation).
 */
async function loadOpenClawConfig(stateDir: string): Promise<OpenClawConfig | null> {
  try {
    const raw = await readFile(join(stateDir, "openclaw.json"), "utf8");
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return null;
  }
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

const NOT_CONFIGURED_MSG =
  "Influxion is not configured. Set apiKey and deploymentId to enable uploads.\n" +
  "  openclaw configure set influxion.apiKey <key>\n" +
  "  openclaw configure set influxion.deploymentId <name>";

/**
 * Register the `openclaw influxion` subcommand group.
 * Accepts `null` when the plugin is installed but not yet configured —
 * commands will print a helpful message instead of failing.
 */
export function registerInfluxionCli(cfg: InfluxionConfig | null) {
  return ({ program }: { program: any }) => {
    const influxion = program
      .command("influxion")
      .description("Influxion agent session upload commands");

    // ── influxion status ───────────────────────────────────────────────────
    influxion
      .command("status")
      .description("Show Influxion plugin status and pending file count")
      .option("--verbose", "List all known skills and pending session files")
      .action(async (opts: { verbose?: boolean }) => {
        if (!cfg) {
          console.warn(NOT_CONFIGURED_MSG);
          return;
        }

        const stateDir = resolveStateDir();
        const [ledger, openClawConfig] = await Promise.all([
          readLedger(stateDir),
          loadOpenClawConfig(stateDir),
        ]);

        const [pendingSessions, allSkills] = await Promise.all([
          collectEligibleSessions(stateDir, ledger, cfg.filter, cfg.upload.maxFilesPerRun),
          cfg.filter.includeSkills
            ? collectSkills(stateDir, cfg.filter, openClawConfig)
            : Promise.resolve([]),
        ]);

        const dirtySkills = allSkills.filter((s) =>
          isSkillDirty(ledger.skills[s.ledgerKey], s.contentHash, s.available),
        );

        const uploadedCount = Object.keys(ledger.files).length;
        const uploadedSkillsCount = Object.keys(ledger.skills ?? {}).length;
        const lastRun = ledger.lastRunAt ?? "never";

        console.log("");
        console.log("Influxion Status");
        console.log("────────────────────────────────");
        console.log(`  API Key:          ${maskApiKey(cfg.apiKey)}`);
        console.log(`  Deployment ID:    ${cfg.deploymentId}`);
        console.log(`  API URL:          ${cfg.apiUrl}`);
        console.log(`  Upload every:     ${cfg.upload.every}`);
        console.log(`  Skills upload:    ${cfg.filter.includeSkills ? "enabled" : "disabled"}`);
        console.log(`  Last run:         ${lastRun}`);
        console.log(`  Pending sessions: ${pendingSessions.length}`);
        console.log(`  Session records:  ${uploadedCount}`);
        if (cfg.filter.includeSkills) {
          console.log(`  Dirty skills:     ${dirtySkills.length} / ${allSkills.length}`);
          console.log(`  Skill records:    ${uploadedSkillsCount}`);
        }

        if (opts.verbose) {
          if (pendingSessions.length > 0) {
            console.log("");
            console.log("  Pending sessions:");
            for (const f of pendingSessions) {
              console.log(`    ${f.agentId}/${f.sessionId}  (${formatBytes(f.stat.size)})`);
            }
          }
          if (cfg.filter.includeSkills && allSkills.length > 0) {
            console.log("");
            console.log("  Skills:");
            for (const s of allSkills) {
              const dirty = isSkillDirty(
                ledger.skills[s.ledgerKey],
                s.contentHash,
                s.available,
              );
              const flags = [
                s.available ? "available" : "unavailable",
                dirty ? "dirty" : "clean",
              ].join(", ");
              console.log(`    [${s.source}] ${s.agentName}/${s.name}  (${flags})`);
            }
          }
        }
        console.log("");
      });

    // ── influxion ledger reset ─────────────────────────────────────────────
    influxion
      .command("ledger reset")
      .description(
        "Clear local ledger entries so the next sync re-uploads from scratch. " +
          "Use --skills or --sessions to reset only one side.",
      )
      .option("--skills", "Clear only skill ledger entries")
      .option("--sessions", "Clear only session ledger entries")
      .action(async (opts: { skills?: boolean; sessions?: boolean }) => {
        if (!cfg) {
          console.warn(NOT_CONFIGURED_MSG);
          return;
        }

        const stateDir = resolveStateDir();
        const ledger = await readLedger(stateDir);

        const resetSkills = !opts.sessions || opts.skills;
        const resetSessions = !opts.skills || opts.sessions;

        if (resetSkills) {
          const count = Object.keys(ledger.skills).length;
          ledger.skills = {};
          console.log(`  Cleared ${count} skill ledger entry/entries.`);
        }
        if (resetSessions) {
          const count = Object.keys(ledger.files).length;
          ledger.files = {};
          console.log(`  Cleared ${count} session ledger entry/entries.`);
        }

        await writeLedger(stateDir, ledger);
        console.log("  Ledger reset. Run `openclaw influxion sync` to re-upload.");
        console.log("");
      });

    // ── influxion sync ─────────────────────────────────────────────────────
    influxion
      .command("sync")
      .description("Trigger an immediate upload cycle (blocking)")
      .action(async () => {
        if (!cfg) {
          console.warn(NOT_CONFIGURED_MSG);
          return;
        }

        const stateDir = resolveStateDir();
        const openClawConfig = await loadOpenClawConfig(stateDir);

        console.log("Running Influxion upload cycle...");

        const logger = {
          info: (msg: string) => console.log(`  ${msg}`),
          warn: (msg: string) => console.warn(`  [warn] ${msg}`),
          error: (msg: string) => console.error(`  [error] ${msg}`),
        };

        try {
          const result = await runUploadCycle({ stateDir, logger, openClawConfig }, cfg);
          console.log("");
          const skillsSummary = cfg.filter.includeSkills
            ? `, skills uploaded: ${result.skillsUploaded}`
            : "";
          console.log(
            `Done — sessions uploaded: ${result.uploaded}, failed: ${result.failed}, ` +
            `lines: ${result.totalLines}, bytes: ${formatBytes(result.totalBytes)}` +
            skillsSummary,
          );
        } catch (err) {
          console.error(`Sync failed: ${String(err)}`);
          process.exitCode = 1;
        }
      });
  };
}
