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

export type SkillLedgerEntry = {
  uploadedAt: string;        // ISO 8601
  /** sha256 hash of SKILL.md content at upload time, e.g. "sha256:abc..." */
  contentHash: string;
  /** Whether the skill was available to the agent at upload time. */
  available: boolean;
};

export type Ledger = {
  schemaVersion: 1;
  lastRunAt: string | null;
  /** Map of relative path (e.g. "agents/main/sessions/abc.jsonl") to entry. */
  files: Record<string, LedgerEntry>;
  /** Map of skill ledger key (e.g. "skills/managed/github") to entry. */
  skills: Record<string, SkillLedgerEntry>;
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
    // Backfill skills map for ledgers written before skills support was added
    if (!parsed.skills) {
      parsed.skills = {};
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
  return { schemaVersion: 1, lastRunAt: null, files: {}, skills: {} };
}

/**
 * Returns true if the skill needs uploading: never uploaded before, content
 * changed, or availability changed since the last upload.
 */
export function isSkillDirty(
  entry: SkillLedgerEntry | undefined,
  contentHash: string,
  available: boolean,
): boolean {
  if (!entry) return true;
  return entry.contentHash !== contentHash || entry.available !== available;
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
