import { describe, it, expect } from "vitest";
import type { Stats } from "node:fs";
import {
  passesAgentFilter,
  passesSessionPatternFilter,
  passesSizeFilter,
  matchesGlobPattern,
  countJsonlLines,
} from "./filter.js";
import { InfluxionFilterConfigSchema } from "./config.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const defaultFilter = InfluxionFilterConfigSchema.parse({});

// Helper to build a partial Stats-like object
function makeStat(size: number, mtimeMs = Date.now()): Stats {
  return { size, mtimeMs } as unknown as Stats;
}

// ── Agent filter ─────────────────────────────────────────────────────────────

describe("passesAgentFilter", () => {
  it("allows all agents when no allow/deny configured", () => {
    expect(passesAgentFilter("main", defaultFilter)).toBe(true);
    expect(passesAgentFilter("coder", defaultFilter)).toBe(true);
    expect(passesAgentFilter("anything", defaultFilter)).toBe(true);
  });

  it("denies agents in the deny list", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      agents: { deny: ["private", "work"] },
    });
    expect(passesAgentFilter("private", filter)).toBe(false);
    expect(passesAgentFilter("work", filter)).toBe(false);
    expect(passesAgentFilter("main", filter)).toBe(true);
  });

  it("allows only agents in the allow list when allow is set", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      agents: { allow: ["main", "coder"] },
    });
    expect(passesAgentFilter("main", filter)).toBe(true);
    expect(passesAgentFilter("coder", filter)).toBe(true);
    expect(passesAgentFilter("other", filter)).toBe(false);
  });

  it("deny-wins: denied agent is rejected even if also in allow list", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      agents: {
        allow: ["main", "secret"],
        deny: ["secret"],
      },
    });
    expect(passesAgentFilter("main", filter)).toBe(true);
    expect(passesAgentFilter("secret", filter)).toBe(false);
  });

  it("deny-wins: empty allow list does not restrict if not set", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      agents: { allow: [] }, // empty allow = no restriction
    });
    expect(passesAgentFilter("anything", filter)).toBe(true);
  });
});

// ── Session pattern filter ───────────────────────────────────────────────────

describe("passesSessionPatternFilter", () => {
  it("allows all sessions when no deny patterns configured", () => {
    expect(passesSessionPatternFilter("session-abc", defaultFilter)).toBe(true);
  });

  it("denies sessions matching exact pattern", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      sessions: { deny: ["tmp-session"] },
    });
    expect(passesSessionPatternFilter("tmp-session", filter)).toBe(false);
    expect(passesSessionPatternFilter("real-session", filter)).toBe(true);
  });

  it("denies sessions matching wildcard pattern", () => {
    const filter = InfluxionFilterConfigSchema.parse({
      sessions: { deny: ["tmp-*", "scratch-*"] },
    });
    expect(passesSessionPatternFilter("tmp-abc", filter)).toBe(false);
    expect(passesSessionPatternFilter("tmp-123", filter)).toBe(false);
    expect(passesSessionPatternFilter("scratch-test", filter)).toBe(false);
    expect(passesSessionPatternFilter("real-session", filter)).toBe(true);
    expect(passesSessionPatternFilter("my-tmp-session", filter)).toBe(true); // prefix doesn't match
  });
});

// ── Glob pattern matching ────────────────────────────────────────────────────

describe("matchesGlobPattern", () => {
  it("matches exact strings", () => {
    expect(matchesGlobPattern("abc", "abc")).toBe(true);
    expect(matchesGlobPattern("abc", "xyz")).toBe(false);
  });

  it("matches * wildcard", () => {
    expect(matchesGlobPattern("tmp-123", "tmp-*")).toBe(true);
    expect(matchesGlobPattern("tmp-", "tmp-*")).toBe(true);
    expect(matchesGlobPattern("notmp-123", "tmp-*")).toBe(false);
  });

  it("handles regex special chars in pattern safely", () => {
    expect(matchesGlobPattern("a.b", "a.b")).toBe(true); // dot is literal
    expect(matchesGlobPattern("axb", "a.b")).toBe(false);
    expect(matchesGlobPattern("(test)", "(test)")).toBe(true);
  });

  it("* matches zero or more characters", () => {
    expect(matchesGlobPattern("", "*")).toBe(true);
    expect(matchesGlobPattern("anything", "*")).toBe(true);
  });
});

// ── Size filter ───────────────────────────────────────────────────────────────

describe("passesSizeFilter", () => {
  it("passes files at or above minBytes", () => {
    const filter = InfluxionFilterConfigSchema.parse({ minBytes: 512 });
    expect(passesSizeFilter(makeStat(512), filter)).toBe(true);
    expect(passesSizeFilter(makeStat(1024), filter)).toBe(true);
  });

  it("rejects files below minBytes", () => {
    const filter = InfluxionFilterConfigSchema.parse({ minBytes: 512 });
    expect(passesSizeFilter(makeStat(511), filter)).toBe(false);
    expect(passesSizeFilter(makeStat(0), filter)).toBe(false);
  });

  it("passes any file when minBytes is 0", () => {
    const filter = InfluxionFilterConfigSchema.parse({ minBytes: 0 });
    expect(passesSizeFilter(makeStat(0), filter)).toBe(true);
  });
});

// ── Line counting ─────────────────────────────────────────────────────────────

describe("countJsonlLines", () => {
  it("counts non-empty lines in a JSONL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-test-"));
    try {
      const path = join(dir, "session.jsonl");
      await writeFile(
        path,
        ['{"type":"message","role":"user","content":"hello"}',
         '{"type":"message","role":"assistant","content":"hi"}',
         '{"type":"message","role":"user","content":"bye"}',
         "",
        ].join("\n"),
        "utf8",
      );

      const count = await countJsonlLines(path, 100);
      expect(count).toBe(3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("stops counting at maxLines (early-exit)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-test-"));
    try {
      const path = join(dir, "session.jsonl");
      const lines = Array.from({ length: 10 }, (_, i) => `{"i":${i}}`);
      await writeFile(path, lines.join("\n"), "utf8");

      const count = await countJsonlLines(path, 3);
      expect(count).toBe(3);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns 0 for an empty file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-test-"));
    try {
      const path = join(dir, "empty.jsonl");
      await writeFile(path, "", "utf8");

      const count = await countJsonlLines(path, 10);
      expect(count).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
