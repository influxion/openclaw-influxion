import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectEligibleSessions } from "./sessions-collector.js";
import { emptyLedger, type Ledger } from "./ledger.js";
import { InfluxionFilterConfigSchema } from "./config.js";

const defaultFilter = InfluxionFilterConfigSchema.parse({ minBytes: 0, minMessages: 0 });

async function createAgentSession(
  stateDir: string,
  agentId: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const dir = join(stateDir, "agents", agentId, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${sessionId}.jsonl`), content, "utf8");
}

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "influxion-sessions-collector-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true });
});

// ── Basic collection ─────────────────────────────────────────────────────────

describe("collectEligibleSessions", () => {
  it("returns empty array when agents directory does not exist", async () => {
    const files = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 100);
    expect(files).toEqual([]);
  });

  it("collects a single new session file", async () => {
    await createAgentSession(stateDir, "main", "abc123", '{"type":"message"}\n');

    const files = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 100);

    expect(files).toHaveLength(1);
    expect(files[0].agentId).toBe("main");
    expect(files[0].sessionId).toBe("abc123");
    expect(files[0].ledgerKey).toBe("agents/main/sessions/abc123.jsonl");
  });

  it("collects files from multiple agents", async () => {
    await createAgentSession(stateDir, "main", "session1", '{"type":"message"}\n');
    await createAgentSession(stateDir, "coder", "session2", '{"type":"message"}\n');

    const files = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 100);

    const agentIds = files.map((f) => f.agentId).sort();
    expect(agentIds).toEqual(["coder", "main"]);
  });

  it("ignores non-JSONL files in the sessions directory", async () => {
    const sessionsDir = join(stateDir, "agents", "main", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, "sessions.json"), '{"sessions":[]}', "utf8");
    await writeFile(join(sessionsDir, "notes.txt"), "notes", "utf8");
    await writeFile(join(sessionsDir, "abc.jsonl"), '{"type":"message"}\n', "utf8");

    const files = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 100);

    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("abc");
  });

  it("skips files that are already up-to-date in the ledger", async () => {
    await createAgentSession(stateDir, "main", "abc123", '{"type":"message"}\n');

    // Run first collection to discover the file
    const firstRun = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 100);
    expect(firstRun).toHaveLength(1);

    // Build a ledger that marks the file as already uploaded with current mtime
    const ledger: Ledger = {
      schemaVersion: 1,
      lastRunAt: new Date().toISOString(),
      files: {},
      skills: {},
    };
    const f = firstRun[0];
    ledger.files[f.ledgerKey] = {
      uploadedAt: new Date(f.stat.mtimeMs + 1).toISOString(), // uploaded after mtime
      uploadedSizeBytes: f.stat.size,
      uploadedLines: 1,
      etag: "sha256:x",
    };

    // Second run with up-to-date ledger: should skip the file
    const secondRun = await collectEligibleSessions(stateDir, ledger, defaultFilter, 100);
    expect(secondRun).toHaveLength(0);
  });

  it("respects the maxFiles limit", async () => {
    for (let i = 0; i < 5; i++) {
      await createAgentSession(stateDir, "main", `session${i}`, '{"type":"message"}\n');
    }

    const files = await collectEligibleSessions(stateDir, emptyLedger(), defaultFilter, 3);
    expect(files).toHaveLength(3);
  });

  it("applies agent deny filter", async () => {
    await createAgentSession(stateDir, "main", "s1", '{"type":"message"}\n');
    await createAgentSession(stateDir, "private", "s2", '{"type":"message"}\n');

    const filter = InfluxionFilterConfigSchema.parse({
      agents: { deny: ["private"] },
      minBytes: 0,
      minMessages: 0,
    });

    const files = await collectEligibleSessions(stateDir, emptyLedger(), filter, 100);

    expect(files).toHaveLength(1);
    expect(files[0].agentId).toBe("main");
  });

  it("applies session deny pattern filter", async () => {
    await createAgentSession(stateDir, "main", "tmp-abc", '{"type":"message"}\n');
    await createAgentSession(stateDir, "main", "real-session", '{"type":"message"}\n');

    const filter = InfluxionFilterConfigSchema.parse({
      sessions: { deny: ["tmp-*"] },
      minBytes: 0,
      minMessages: 0,
    });

    const files = await collectEligibleSessions(stateDir, emptyLedger(), filter, 100);

    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("real-session");
  });

  it("applies minBytes filter (skips small files)", async () => {
    await createAgentSession(stateDir, "main", "tiny", "{}"); // 2 bytes — well below threshold
    // Generate content that is clearly above 100 bytes
    const bigContent = Array.from({ length: 10 }, (_, i) => `{"type":"message","i":${i}}`).join(
      "\n",
    );
    await createAgentSession(stateDir, "main", "normal", bigContent);

    const filter = InfluxionFilterConfigSchema.parse({ minBytes: 100, minMessages: 0 });

    const files = await collectEligibleSessions(stateDir, emptyLedger(), filter, 100);

    // Only the normal file should pass (tiny is 2 bytes)
    const ids = files.map((f) => f.sessionId);
    expect(ids).not.toContain("tiny");
    expect(ids).toContain("normal");
  });

  it("applies minMessages filter (skips sessions with too few lines)", async () => {
    // 1 line session — below minMessages: 2
    await createAgentSession(stateDir, "main", "short", '{"type":"message"}\n');
    // 3 line session — passes
    await createAgentSession(
      stateDir,
      "main",
      "long",
      '{"type":"message"}\n{"type":"message"}\n{"type":"message"}\n',
    );

    const filter = InfluxionFilterConfigSchema.parse({ minBytes: 0, minMessages: 2 });

    const files = await collectEligibleSessions(stateDir, emptyLedger(), filter, 100);

    expect(files).toHaveLength(1);
    expect(files[0].sessionId).toBe("long");
  });
});
