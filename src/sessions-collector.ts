import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";
import type { Ledger } from "./ledger.js";
import { isFileDirty } from "./ledger.js";
import type { InfluxionFilterConfig } from "./config.js";
import {
  passesAgentFilter,
  passesMessageFilter,
  passesSizeFilter,
  passesSessionPatternFilter,
} from "./filter.js";

export type CollectedSession = {
  agentId: string;
  sessionId: string;
  /** Absolute path to the .jsonl file. */
  filePath: string;
  stat: Stats;
  /** Relative ledger key, e.g. "agents/main/sessions/abc123.jsonl". */
  ledgerKey: string;
};

/**
 * Scan the stateDir for session JSONL files that are eligible to upload.
 *
 * Eligibility criteria (applied cheapest-first):
 *   1. Agent passes the agent allow/deny filter.
 *   2. Session ID does not match any session deny pattern.
 *   3. File is new or modified since last upload (per the ledger).
 *   4. File meets the minimum byte size requirement.
 *   5. File contains at least minMessages non-empty lines (most expensive).
 *
 * Returns at most `maxFiles` results.
 */
export async function collectEligibleSessions(
  stateDir: string,
  ledger: Ledger,
  filter: InfluxionFilterConfig,
  maxFiles: number,
): Promise<CollectedSession[]> {
  const agentsDir = join(stateDir, "agents");

  let agentIds: string[];
  try {
    agentIds = await readdir(agentsDir);
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") return [];
    throw err;
  }

  const results: CollectedSession[] = [];

  for (const agentId of agentIds) {
    if (!passesAgentFilter(agentId, filter)) continue;

    const sessionsDir = join(agentsDir, agentId, "sessions");
    let filenames: string[];
    try {
      filenames = await readdir(sessionsDir);
    } catch {
      // Agent may not have a sessions dir — skip silently
      continue;
    }

    for (const filename of filenames) {
      if (!filename.endsWith(".jsonl")) continue;

      // Derive sessionId by stripping the .jsonl extension
      const sessionId = filename.slice(0, -".jsonl".length);

      if (!passesSessionPatternFilter(sessionId, filter)) continue;

      const filePath = join(sessionsDir, filename);
      const ledgerKey = `agents/${agentId}/sessions/${filename}`;

      let fileStat: Stats;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      // Skip unchanged files according to the ledger
      if (!isFileDirty(ledger.files[ledgerKey], fileStat)) continue;

      // Size filter (cheap)
      if (!passesSizeFilter(fileStat, filter)) continue;

      // Message count filter (reads the file — do this last)
      const passes = await passesMessageFilter(filePath, filter);
      if (!passes) continue;

      results.push({ agentId, sessionId, filePath, stat: fileStat, ledgerKey });

      if (results.length >= maxFiles) return results;
    }
  }

  return results;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
