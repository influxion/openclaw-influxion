import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { parseIntervalMs } from "./config.js";
import type { InfluxionConfig } from "./config.js";
import { readLedger, writeLedger } from "./ledger.js";
import { collectEligibleFiles } from "./collector.js";
import { uploadBatch } from "./uploader.js";

/** Minimal logging interface used by the upload cycle, so the CLI can also call it. */
export type UploadCycleLogger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export type UploadCycleContext = {
  stateDir: string;
  logger: UploadCycleLogger;
};

export type UploadCycleResult = {
  uploaded: number;
  failed: number;
  totalLines: number;
  totalBytes: number;
};

/**
 * Run one upload cycle: collect eligible files → upload → update ledger.
 * Safe to call from both the background service and the CLI `sync` command.
 */
export async function runUploadCycle(
  ctx: UploadCycleContext,
  cfg: InfluxionConfig,
): Promise<UploadCycleResult> {
  const { stateDir, logger } = ctx;

  const ledger = await readLedger(stateDir);

  const files = await collectEligibleFiles(
    stateDir,
    ledger,
    cfg.filter,
    cfg.upload.maxFilesPerRun,
  );

  if (files.length === 0) {
    logger.info("influxion: no new or modified files to upload");
    ledger.lastRunAt = new Date().toISOString();
    await writeLedger(stateDir, ledger);
    return { uploaded: 0, failed: 0, totalLines: 0, totalBytes: 0 };
  }

  logger.info(`influxion: uploading ${files.length} file(s)...`);

  const result = await uploadBatch(files, cfg, cfg.upload.maxBytesPerRun);

  // Update ledger entries for successfully uploaded files
  const now = new Date().toISOString();
  for (const { file, uploadedLines, etag } of result.uploaded) {
    ledger.files[file.ledgerKey] = {
      uploadedAt: now,
      uploadedSizeBytes: file.stat.size,
      uploadedLines,
      etag,
    };
  }
  ledger.lastRunAt = now;
  await writeLedger(stateDir, ledger);

  if (result.failed.length > 0) {
    const summary = result.failed
      .map((f) => `${f.file.sessionId}: ${f.error}`)
      .join(", ");
    logger.warn(`influxion: ${result.failed.length} file(s) failed to upload — ${summary}`);
  }

  logger.info(
    `influxion: done — ${result.uploaded.length} uploaded, ` +
      `${result.totalLines} lines, ${result.totalBytes} bytes`,
  );

  return {
    uploaded: result.uploaded.length,
    failed: result.failed.length,
    totalLines: result.totalLines,
    totalBytes: result.totalBytes,
  };
}

/**
 * Create the background UploadService that runs on a configurable interval.
 * Registered via `api.registerService()` in the plugin entry point.
 * Accepts `null` when the plugin is installed but not yet configured — the
 * service will log a warning on start and do nothing until configured.
 */
export function createUploadService(cfg: InfluxionConfig | null): OpenClawPluginService {
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
            { stateDir: ctx.stateDir, logger: ctx.logger },
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
