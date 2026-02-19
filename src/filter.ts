import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Stats } from "node:fs";
import type { InfluxionFilterConfig } from "./config.js";

/**
 * Determine if an agent should be included in the upload.
 * Deny-wins: if agentId appears in the deny list, it is always excluded,
 * even if it also appears in the allow list.
 * If an allow list is configured, only listed agents are included.
 */
export function passesAgentFilter(agentId: string, filter: InfluxionFilterConfig): boolean {
  const { allow, deny } = filter.agents;
  if (deny && deny.includes(agentId)) return false;
  if (allow && allow.length > 0 && !allow.includes(agentId)) return false;
  return true;
}

/**
 * Match a name against a glob-style pattern where only `*` is a wildcard
 * (matches any sequence of characters, not including path separators).
 */
export function matchesGlobPattern(name: string, pattern: string): boolean {
  // Escape all regex special chars except *, then replace * with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/**
 * Determine if a session ID passes the session-level deny patterns.
 */
export function passesSessionPatternFilter(
  sessionId: string,
  filter: InfluxionFilterConfig,
): boolean {
  const { deny } = filter.sessions;
  if (!deny) return true;
  for (const pattern of deny) {
    if (matchesGlobPattern(sessionId, pattern)) return false;
  }
  return true;
}

/**
 * Determine if a file is large enough to be worth uploading.
 */
export function passesSizeFilter(stat: Stats, filter: InfluxionFilterConfig): boolean {
  return stat.size >= filter.minBytes;
}

/**
 * Count non-empty lines in a JSONL file up to `maxLines`.
 * Stops early once maxLines is reached to avoid reading the whole file.
 */
export async function countJsonlLines(filePath: string, maxLines: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    let closed = false;

    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      if (!closed) {
        closed = true;
        rl.close();
        stream.destroy();
        resolve(count);
      }
    };

    rl.on("line", (line) => {
      if (line.trim()) {
        count++;
        if (count >= maxLines) {
          finish();
        }
      }
    });

    rl.on("close", () => resolve(count));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/**
 * Determine if a session file has enough messages to be worth uploading.
 * This is the most expensive filter — it reads the file — so call it last.
 */
export async function passesMessageFilter(
  filePath: string,
  filter: InfluxionFilterConfig,
): Promise<boolean> {
  if (filter.minMessages <= 0) return true;
  const count = await countJsonlLines(filePath, filter.minMessages);
  return count >= filter.minMessages;
}
