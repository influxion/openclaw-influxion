import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";

export type LedgerEntry = {
  uploadedAt: string;        // ISO 8601
  uploadedSizeBytes: number;
  uploadedLines: number;
  /** sha256 hash of file content at upload time, e.g. "sha256:abc..." */
  etag: string;
};

export type Ledger = {
  schemaVersion: 1;
  lastRunAt: string | null;
  /** Map of relative path (e.g. "agents/main/sessions/abc.jsonl") to entry. */
  files: Record<string, LedgerEntry>;
};

function ledgerPath(stateDir: string): string {
  return join(stateDir, "extensions", "influxion", "state.json");
}

export async function readLedger(stateDir: string): Promise<Ledger> {
  const path = ledgerPath(stateDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Ledger;
    if (parsed.schemaVersion !== 1) {
      return emptyLedger();
    }
    return parsed;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return emptyLedger();
    }
    throw err;
  }
}

export async function writeLedger(stateDir: string, ledger: Ledger): Promise<void> {
  const path = ledgerPath(stateDir);
  await mkdir(join(stateDir, "extensions", "influxion"), { recursive: true });
  await writeFile(path, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, lastRunAt: null, files: {} };
}

/**
 * Returns true if the file has been modified since it was last uploaded,
 * or if it has never been uploaded.
 */
export function isFileDirty(entry: LedgerEntry | undefined, stat: Stats): boolean {
  if (!entry) return true;
  const uploadedAt = new Date(entry.uploadedAt).getTime();
  return stat.mtimeMs > uploadedAt || stat.size !== entry.uploadedSizeBytes;
}

export function computeEtag(content: string): string {
  return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
