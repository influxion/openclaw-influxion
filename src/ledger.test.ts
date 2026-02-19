import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Stats } from "node:fs";
import {
  readLedger,
  writeLedger,
  emptyLedger,
  isFileDirty,
  computeEtag,
  type LedgerEntry,
} from "./ledger.js";

function makeStat(size: number, mtimeMs: number): Stats {
  return { size, mtimeMs } as unknown as Stats;
}

function makeEntry(overrides?: Partial<LedgerEntry>): LedgerEntry {
  return {
    uploadedAt: new Date(1_000_000).toISOString(),
    uploadedSizeBytes: 1024,
    uploadedLines: 10,
    etag: "sha256:abc",
    ...overrides,
  };
}

// ── readLedger / writeLedger ───────────────────────────────────────────────

describe("readLedger", () => {
  it("returns an empty ledger when state.json does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-ledger-"));
    try {
      const ledger = await readLedger(dir);
      expect(ledger.schemaVersion).toBe(1);
      expect(ledger.lastRunAt).toBeNull();
      expect(ledger.files).toEqual({});
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("round-trips a ledger through write → read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-ledger-"));
    try {
      const original = emptyLedger();
      original.lastRunAt = "2026-02-18T12:00:00.000Z";
      original.files["agents/main/sessions/abc.jsonl"] = makeEntry();

      await writeLedger(dir, original);
      const restored = await readLedger(dir);

      expect(restored.schemaVersion).toBe(1);
      expect(restored.lastRunAt).toBe("2026-02-18T12:00:00.000Z");
      expect(restored.files["agents/main/sessions/abc.jsonl"]).toEqual(
        original.files["agents/main/sessions/abc.jsonl"],
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("creates the extensions/influxion directory on write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-ledger-"));
    try {
      await writeLedger(dir, emptyLedger());
      // readLedger should succeed because the file now exists
      const ledger = await readLedger(dir);
      expect(ledger.schemaVersion).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("returns an empty ledger when schemaVersion is unrecognised", async () => {
    const dir = await mkdtemp(join(tmpdir(), "influxion-ledger-"));
    try {
      // Write a ledger with a future schema version
      const corrupt = { schemaVersion: 99, lastRunAt: null, files: {} };
      await writeLedger(dir, corrupt as never);
      const ledger = await readLedger(dir);
      // Should reset to empty rather than loading unknown schema
      expect(ledger.files).toEqual({});
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

// ── isFileDirty ────────────────────────────────────────────────────────────

describe("isFileDirty", () => {
  it("returns true when entry is undefined (never uploaded)", () => {
    expect(isFileDirty(undefined, makeStat(1024, Date.now()))).toBe(true);
  });

  it("returns false when file mtime and size match the ledger entry", () => {
    const uploadedAt = new Date(1_000_000).toISOString();
    const entry = makeEntry({ uploadedAt, uploadedSizeBytes: 1024 });
    // mtime is before uploadedAt → not dirty
    expect(isFileDirty(entry, makeStat(1024, 999_000))).toBe(false);
  });

  it("returns true when file mtime is after uploadedAt", () => {
    const uploadedAt = new Date(1_000_000).toISOString();
    const entry = makeEntry({ uploadedAt, uploadedSizeBytes: 1024 });
    // mtime is after uploadedAt → dirty
    expect(isFileDirty(entry, makeStat(1024, 1_000_001))).toBe(true);
  });

  it("returns true when file size changed even if mtime is older", () => {
    const uploadedAt = new Date(1_000_000).toISOString();
    const entry = makeEntry({ uploadedAt, uploadedSizeBytes: 1024 });
    // Same mtime as upload time but different size
    expect(isFileDirty(entry, makeStat(2048, 999_000))).toBe(true);
  });
});

// ── computeEtag ────────────────────────────────────────────────────────────

describe("computeEtag", () => {
  it("produces a sha256: prefixed hex string", () => {
    const etag = computeEtag("hello world");
    expect(etag).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(computeEtag("same content")).toBe(computeEtag("same content"));
  });

  it("differs for different content", () => {
    expect(computeEtag("content A")).not.toBe(computeEtag("content B"));
  });
});
