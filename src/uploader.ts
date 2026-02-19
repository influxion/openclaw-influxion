import { readFile } from "node:fs/promises";
import { computeEtag } from "./ledger.js";
import type { CollectedFile } from "./collector.js";
import type { InfluxionConfig } from "./config.js";

export type UploadedFileResult = {
  file: CollectedFile;
  uploadedLines: number;
  etag: string;
};

export type UploadResult = {
  uploaded: UploadedFileResult[];
  failed: Array<{ file: CollectedFile; error: string }>;
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
  agentId: string;
  sessionId: string;
  sessionFile: string;
  lineIndex: number;
  capturedAt: string;
  payload: unknown;
};

function buildEnvelopeLine(
  deploymentId: string,
  agentId: string,
  sessionId: string,
  sessionFile: string,
  lineIndex: number,
  capturedAt: string,
  payload: unknown,
): string {
  const envelope: SessionLineEnvelope = {
    deploymentId,
    agentId,
    sessionId,
    sessionFile,
    lineIndex,
    capturedAt,
    payload,
  };
  return JSON.stringify(envelope);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postNdjson(
  url: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
): Promise<IngestResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-ndjson",
      },
      body,
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
  file: CollectedFile,
  config: InfluxionConfig,
): Promise<UploadedFileResult> {
  const content = await readFile(file.filePath, "utf8");
  const lines = content.split("\n").filter((l) => l.trim());
  const capturedAt = new Date().toISOString();
  const sessionFile = file.ledgerKey; // e.g. "agents/main/sessions/abc.jsonl"

  const ndJsonLines: string[] = lines.map((rawLine, i) => {
    let payload: unknown;
    try {
      payload = JSON.parse(rawLine);
    } catch {
      // Preserve unparseable lines as raw strings
      payload = { raw: rawLine };
    }
    return buildEnvelopeLine(
      config.deploymentId,
      file.agentId,
      file.sessionId,
      sessionFile,
      i,
      capturedAt,
      payload,
    );
  });

  const body = ndJsonLines.join("\n");
  const etag = computeEtag(content);
  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/ingest/sessions`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= config.upload.retryAttempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: backoffMs * attempt
      await sleep(config.upload.retryBackoffMs * attempt);
    }
    try {
      await postNdjson(url, config.apiKey, body, config.upload.timeoutMs);
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
export async function uploadBatch(
  files: CollectedFile[],
  config: InfluxionConfig,
  maxBytesPerRun: number,
): Promise<UploadResult> {
  const result: UploadResult = {
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
