import { z } from "zod";

const INTERVAL_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/;

/**
 * Parse an interval string like "5m", "1h", "30m", "500ms" into milliseconds.
 * Defaults to minutes if no unit is given.
 */
export function parseIntervalMs(value: string): number {
  const match = INTERVAL_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid interval string: "${value}". Expected format: "15m", "1h", "30s", etc.`);
  }
  const n = parseFloat(match[1]);
  const unit = match[2] ?? "m";
  switch (unit) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: throw new Error(`Unknown interval unit: "${unit}"`);
  }
}

const InfluxionUploadConfigBaseSchema = z.object({
  /** How often to run the upload cycle (e.g. "15m", "1h"). */
  every: z.string().default("15m"),
  retryAttempts: z.number().int().min(0).default(3),
  retryBackoffMs: z.number().int().min(0).default(5_000),
  timeoutMs: z.number().int().min(1_000).default(30_000),
  maxFilesPerRun: z.number().int().min(1).default(50),
  /** Max total bytes to upload in one cycle. Default: 10 MB. */
  maxBytesPerRun: z.number().int().min(1).default(10 * 1024 * 1024),
});

/**
 * Upload config schema: coerces `undefined` → `{}` so all fields use
 * their defaults when the user omits the `upload` block entirely.
 */
export const InfluxionUploadConfigSchema = z.preprocess(
  (v) => v ?? {},
  InfluxionUploadConfigBaseSchema,
);

const InfluxionAgentsFilterBaseSchema = z.object({
  /** If set, only these agent IDs are uploaded. */
  allow: z.array(z.string()).optional(),
  /** These agent IDs are never uploaded. Deny takes precedence over allow. */
  deny: z.array(z.string()).optional(),
});

const InfluxionSessionsFilterBaseSchema = z.object({
  /** Session IDs matching these glob patterns are never uploaded. */
  deny: z.array(z.string()).optional(),
});

const InfluxionFilterConfigBaseSchema = z.object({
  agents: z.preprocess((v) => v ?? {}, InfluxionAgentsFilterBaseSchema),
  sessions: z.preprocess((v) => v ?? {}, InfluxionSessionsFilterBaseSchema),
  /** Skip sessions with fewer than this many JSONL lines. */
  minMessages: z.number().int().min(0).default(2),
  /** Skip files smaller than this many bytes. */
  minBytes: z.number().int().min(0).default(512),
  /** Future: include skill files in uploads. */
  includeSkills: z.boolean().default(false),
  /** Future: include config snapshots in uploads. */
  includeConfig: z.boolean().default(false),
});

/**
 * Filter config schema: coerces `undefined` → `{}` so all fields use
 * their defaults when the user omits the `filter` block entirely.
 */
export const InfluxionFilterConfigSchema = z.preprocess(
  (v) => v ?? {},
  InfluxionFilterConfigBaseSchema,
);

export type InfluxionUploadConfig = z.infer<typeof InfluxionUploadConfigBaseSchema>;
export type InfluxionFilterConfig = z.infer<typeof InfluxionFilterConfigBaseSchema>;

export const InfluxionConfigSchema = z.object({
  /** Influxion API key (e.g. "inf_live_xxxx"). */
  apiKey: z.string().min(1),
  /** Logical name for this OpenClaw installation. */
  deploymentId: z.string().min(1),
  /** API base URL. Override for self-hosted Influxion. */
  apiUrl: z.url().default("https://api.influxion.io"),
  upload: InfluxionUploadConfigSchema as z.ZodType<InfluxionUploadConfig>,
  filter: InfluxionFilterConfigSchema as z.ZodType<InfluxionFilterConfig>,
});

export type InfluxionConfig = z.infer<typeof InfluxionConfigSchema>;
