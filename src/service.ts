import type {
  OpenClawConfig,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import { parseIntervalMs } from "./config.js";
import type { InfluxionConfig } from "./config.js";
import { readLedger, writeLedger } from "./ledger.js";
import { collectEligibleSessions } from "./sessions-collector.js";
import { uploadSessionsBatch } from "./sessions-uploader.js";
import { collectSkills } from "./skills-collector.js";
import { uploadSkillsBatch, type SkillsBatch } from "./skills-uploader.js";
import { isSkillDirty } from "./ledger.js";

/** Minimal logging interface used by the upload cycle, so the CLI can also call it. */
export type UploadCycleLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type UploadCycleContext = {
  stateDir: string;
  logger: UploadCycleLogger;
  openClawConfig: OpenClawConfig | null;
};

export type UploadCycleResult = {
  uploaded: number;
  failed: number;
  totalLines: number;
  totalBytes: number;
  skillsUploaded: number;
  skillsFailed: number;
};

/**
 * Run one upload cycle: collect eligible files → upload → update ledger.
 * Safe to call from both the background service and the CLI `sync` command.
 */
export async function runUploadCycle(
  ctx: UploadCycleContext,
  cfg: InfluxionConfig,
): Promise<UploadCycleResult> {
  const { stateDir, logger, openClawConfig } = ctx;

  const ledger = await readLedger(stateDir);

  const files = await collectEligibleSessions(
    stateDir,
    ledger,
    cfg.filter,
    cfg.upload.maxFilesPerRun,
  );

  const now = new Date().toISOString();

  let sessionUploaded = 0;
  let sessionFailed = 0;
  let totalLines = 0;
  let totalBytes = 0;

  if (files.length === 0) {
    logger.info("influxion: no new or modified session files to upload");
  } else {
    logger.info(`influxion: uploading ${files.length} session file(s)...`);

    const result = await uploadSessionsBatch(files, cfg, cfg.upload.maxBytesPerRun);

    // Update ledger entries for successfully uploaded files
    for (const { file, uploadedLines, etag } of result.uploaded) {
      ledger.files[file.ledgerKey] = {
        uploadedAt: now,
        uploadedSizeBytes: file.stat.size,
        uploadedLines,
        etag,
      };
    }

    if (result.failed.length > 0) {
      const summary = result.failed
        .map((f) => `${f.file.sessionId}: ${f.error}`)
        .join(", ");
      logger.warn(`influxion: ${result.failed.length} session file(s) failed — ${summary}`);
    }

    sessionUploaded = result.uploaded.length;
    sessionFailed = result.failed.length;
    totalLines = result.totalLines;
    totalBytes = result.totalBytes;
  }

  // Skills upload cycle
  let skillsUploaded = 0;
  let skillsFailed = 0;

  if (cfg.filter.includeSkills) {
    // Collect the full current set of skills (all agents); the gateway will use
    // the complete manifest to detect and mark removed skills as unavailable.
    const allSkills = await collectSkills(stateDir, cfg.filter, openClawConfig);

    if (allSkills.length === 0) {
      logger.info("influxion: no skills found to upload");
    } else {
      // Split into dirty (need content) and clean (manifest-only)
      const batch: SkillsBatch = { dirty: [], clean: [] };
      for (const skill of allSkills) {
        const entry = ledger.skills[skill.ledgerKey];
        if (isSkillDirty(entry, skill.contentHash, skill.available)) {
          batch.dirty.push(skill);
        } else {
          batch.clean.push(skill);
        }
      }

      logger.info(
        `influxion: syncing ${allSkills.length} skill(s) ` +
          `(${batch.dirty.length} dirty, ${batch.clean.length} clean)...`,
      );

      const skillResult = await uploadSkillsBatch(batch, cfg);

      // Only update ledger entries for dirty skills; clean ones are unchanged
      for (const { skill } of skillResult.uploaded) {
        if (batch.dirty.includes(skill)) {
          ledger.skills[skill.ledgerKey] = {
            uploadedAt: now,
            contentHash: skill.contentHash,
            available: skill.available,
          };
        }
      }

      if (skillResult.failed.length > 0) {
        const summary = skillResult.failed
          .map((f) => `${f.skill.name}: ${f.error}`)
          .join(", ");
        logger.warn(`influxion: ${skillResult.failed.length} skill(s) failed — ${summary}`);
      }

      skillsUploaded = batch.dirty.length - skillResult.failed.filter(
        (f) => batch.dirty.includes(f.skill),
      ).length;
      skillsFailed = skillResult.failed.length;
    }
  }

  ledger.lastRunAt = now;
  await writeLedger(stateDir, ledger);

  logger.info(
    `influxion: done — sessions: ${sessionUploaded} uploaded, ` +
      `${totalLines} lines, ${totalBytes} bytes` +
      (cfg.filter.includeSkills
        ? `; skills: ${skillsUploaded} uploaded`
        : ""),
  );

  return {
    uploaded: sessionUploaded,
    failed: sessionFailed,
    totalLines,
    totalBytes,
    skillsUploaded,
    skillsFailed,
  };
}

/**
 * Create the background UploadService that runs on a configurable interval.
 * Registered via `api.registerService()` in the plugin entry point.
 * Accepts `null` cfg when the plugin is installed but not yet configured — the
 * service will log a warning on start and do nothing until configured.
 */
export function createUploadService(
  cfg: InfluxionConfig | null,
  openClawConfig: OpenClawConfig | null,
): OpenClawPluginService {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    id: "influxion",

    async start(ctx: OpenClawPluginServiceContext) {
      if (!cfg) {
        ctx.logger.warn(
          "influxion: upload service not started — set apiKey and deploymentId to enable uploads",
        );
        return;
      }

      const intervalMs = parseIntervalMs(cfg.upload.every);

      ctx.logger.info(
        `influxion: upload service started (interval: ${cfg.upload.every}, deployment: ${cfg.deploymentId})`,
      );

      const run = async () => {
        try {
          await runUploadCycle(
            { stateDir: ctx.stateDir, logger: ctx.logger, openClawConfig },
            cfg,
          );
        } catch (err) {
          ctx.logger.error(`influxion: upload cycle error — ${String(err)}`);
        }
        scheduleNext();
      };

      const scheduleNext = () => {
        timer = setTimeout(run, intervalMs);
      };

      // Short initial delay so the gateway finishes starting before the first run
      timer = setTimeout(run, 10_000);
    },

    async stop() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
