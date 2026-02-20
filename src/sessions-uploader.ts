import { readFile } from "node:fs/promises";
import { computeEtag } from "./ledger.js";
import type { CollectedSession } from "./sessions-collector.js";
import type { InfluxionConfig } from "./config.js";

export type UploadedSessionResult = {
  file: CollectedSession;
  uploadedLines: number;
  etag: string;
};

export type SessionUploadResult = {
  uploaded: UploadedSessionResult[];
  failed: Array<{ file: CollectedSession; error: string }>;
  totalLines: number;
  totalBytes: number;
};

type IngestResponse = {
  accepted: number;
  rejected: number;
  batchId: string;
  warnings?: string[];
  errors?: Array<{ lineIndex: number; reason: string }>;
};

/** One envelope record sent to Influxion per JSONL line. */
type SessionLineEnvelope = {
  deploymentId: string;
  projectId: string;
  /** OpenClaw agent ID — the directory name under ~/.openclaw/agents/ (e.g. "main"). */
  agentId: string;
  /** Agent name — identical to agentId; the directory name is the canonical agent name. */
  agentName: string;
  sessionId: string;
  sessionFile: string;
  lineIndex: number;
  capturedAt: string;
  payload: unknown;
};


async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<IngestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return (await response.json()) as IngestResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function uploadFileWithRetry(
  file: CollectedSession,
  config: InfluxionConfig,
): Promise<UploadedSessionResult> {
  const content = await readFile(file.filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  const capturedAt = new Date().toISOString();
  const sessionFile = file.ledgerKey; // e.g. "agents/main/sessions/abc.jsonl"

  const envelopes: SessionLineEnvelope[] = lines.map((rawLine, i) => {
    let payload: unknown;
    try {
      payload = JSON.parse(rawLine);
    } catch {
      payload = { raw: rawLine };
    }
    const env: SessionLineEnvelope = {
      deploymentId: config.deploymentId,
      projectId: config.projectId,
      agentId: file.agentId,
      agentName: file.agentId,
      sessionId: file.sessionId,
      sessionFile,
      lineIndex: i,
      capturedAt,
      payload,
    };
    return env;
  });

  const requestBody = { lines: envelopes };
  const etag = computeEtag(content);
  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/openclaw/ingest/sessions`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= config.upload.retryAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: backoffMs * attempt
      await sleep(config.upload.retryBackoffMs * attempt);
    }
    try {
      await postJson(url, config.apiKey, requestBody, config.upload.timeoutMs);
      return { file, uploadedLines: lines.length, etag };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error("Upload failed after all retry attempts");
}

/**
 * Upload a batch of collected files to the Influxion API.
 * Respects `maxBytesPerRun`: stops accepting new files once the byte budget
 * would be exceeded (already-started files are not interrupted).
 */
export async function uploadSessionsBatch(
  files: CollectedSession[],
  config: InfluxionConfig,
  maxBytesPerRun: number,
): Promise<SessionUploadResult> {
  const result: SessionUploadResult = {
    uploaded: [],
    failed: [],
    totalLines: 0,
    totalBytes: 0,
  };

  for (const file of files) {
    // Enforce byte budget before starting a new file
    if (result.totalBytes > 0 && result.totalBytes + file.stat.size > maxBytesPerRun) {
      break;
    }

    try {
      const uploaded = await uploadFileWithRetry(file, config);
      result.uploaded.push(uploaded);
      result.totalLines += uploaded.uploadedLines;
      result.totalBytes += file.stat.size;
    } catch (err) {
      result.failed.push({
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
