import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import { accessSync, constants, existsSync } from "node:fs";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { load as loadYaml } from "js-yaml";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { Ledger, SkillLedgerEntry } from "./ledger.js";
import { isSkillDirty } from "./ledger.js";
import type { InfluxionFilterConfig } from "./config.js";

export type SkillSource =
  | "openclaw-bundled"
  | "openclaw-managed"
  | "openclaw-workspace"
  | "agents-skills-personal"
  | "agents-skills-project";

/**
 * The OpenClaw-specific sub-block from a SKILL.md frontmatter's metadata field.
 * Matches OpenClawSkillMetadata from openclaw's src/agents/skills/types.ts.
 */
export type SkillMetadata = {
  always?: boolean;
  skillKey?: string;
  primaryEnv?: string;
  os?: string[];
  requires?: {
    bins?: string[];
    anyBins?: string[];
    env?: string[];
    config?: string[];
  };
  [key: string]: unknown;
};

export type SkillFrontmatter = {
  name?: string;
  description?: string;
  license?: string;
  compatibility?: string;
  /**
   * The raw metadata block from the SKILL.md frontmatter, parsed by js-yaml
   * as a flow mapping. OpenClaw-specific fields live under the `openclaw` key,
   * e.g. `metadata.openclaw.requires`, `metadata.openclaw.os`.
   */
  metadata?: { openclaw?: SkillMetadata; [key: string]: unknown };
};

export type CollectedSkill = {
  name: string;
  source: SkillSource;
  /** Agent ID this skill belongs to (e.g. "main", "coder"). Always a real agent ID, never "_global". */
  agentName: string;
  /** Absolute path to the SKILL.md file. */
  skillMdPath: string;
  /** Raw content of the SKILL.md file. */
  content: string;
  frontmatter: SkillFrontmatter;
  /** sha256 hash of the SKILL.md content, e.g. "sha256:abc..." */
  contentHash: string;
  /** Ledger key, e.g. "skills/main/openclaw-bundled/github". */
  ledgerKey: string;
  /** Whether the skill is available to the agent (not disabled, not blocked by allowlist). */
  available: boolean;
};

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Returns an empty object if parsing fails or no frontmatter is present.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match || !match[1]) return {};
  try {
    const parsed = loadYaml(match[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SkillFrontmatter;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Mirrors OpenClaw's hasBinary from src/shared/config-eval.ts.
 * Scans PATH directories for an executable with the given name.
 */
function hasBinary(bin: string): boolean {
  const parts = (process.env["PATH"] ?? "").split(delimiter).filter(Boolean);
  for (const part of parts) {
    try {
      accessSync(join(part, bin), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Mirrors the isEnvSatisfied lambda from OpenClaw's buildSkillStatus.
 * Checks process.env, per-skill env config, and apiKey shorthand.
 */
function isEnvSatisfied(
  envName: string,
  skillKey: string,
  metadata: SkillMetadata,
  cfg: OpenClawConfig | null,
): boolean {
  if (process.env[envName]) return true;
  const skillCfg = cfg?.skills?.entries?.[skillKey] as Record<string, unknown> | undefined;
  if (skillCfg?.["env"] && (skillCfg["env"] as Record<string, unknown>)[envName]) return true;
  if (skillCfg?.["apiKey"] && metadata.primaryEnv === envName) return true;
  return false;
}

/**
 * Mirrors OpenClaw's isConfigPathTruthy — resolves a dot-notation path
 * against the config object and checks if it is truthy.
 */
function isConfigSatisfied(pathStr: string, cfg: OpenClawConfig | null): boolean {
  if (!cfg) return false;
  const parts = pathStr.split(".");
  let node: unknown = cfg;
  for (const part of parts) {
    if (node == null || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[part];
  }
  return Boolean(node);
}

/**
 * Compute whether a skill is available to the agent.
 * Mirrors OpenClaw's buildSkillStatus eligibility formula:
 *   eligible = !disabled && !blockedByAllowlist && requirementsSatisfied
 */
function computeAvailable(
  source: SkillSource,
  skillKey: string,
  name: string,
  metadata: SkillMetadata,
  cfg: OpenClawConfig | null,
): boolean {
  const disabled = cfg?.skills?.entries?.[skillKey]?.enabled === false;
  const allowlist = Array.isArray(cfg?.skills?.allowBundled) ? cfg.skills.allowBundled : [];
  const blockedByAllowlist =
    source === "openclaw-bundled" &&
    allowlist.length > 0 &&
    !allowlist.includes(skillKey) &&
    !allowlist.includes(name);

  if (disabled || blockedByAllowlist) return false;

  // metadata.always bypasses all requirement checks (mirrors OpenClaw's logic).
  if (metadata.always === true) return true;

  const requires = metadata.requires ?? {};
  const bins = requires.bins ?? [];
  const anyBins = requires.anyBins ?? [];
  const envs = requires.env ?? [];
  const configs = requires.config ?? [];
  const osList = metadata.os ?? [];

  if (bins.some((b) => !hasBinary(b))) return false;
  if (anyBins.length > 0 && !anyBins.some(hasBinary)) return false;
  if (envs.some((e) => !isEnvSatisfied(e, skillKey, metadata, cfg))) return false;
  if (osList.length > 0 && !osList.includes(process.platform)) return false;
  if (configs.some((p) => !isConfigSatisfied(p, cfg))) return false;

  return true;
}

/**
 * Walk up from `startDir` looking for a directory that contains a `skills/`
 * subdirectory. Returns the `skills/` path if found, otherwise null.
 */
function walkUpForSkillsDir(startDir: string): string | null {
  let dir = startDir;
  while (dir !== dirname(dir)) {
    const candidate = join(dir, "skills");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/**
 * Attempt to resolve the bundled skills directory from the openclaw package.
 * Returns null if it cannot be determined.
 */
function resolveBundledSkillsDir(): string | null {
  // Check env var first (same as openclaw's own resolution)
  const envDir = process.env["OPENCLAW_BUNDLED_SKILLS_DIR"];
  if (envDir) {
    return existsSync(envDir) ? envDir : null;
  }

  // Primary: import.meta.resolve is synchronous in Node 20+ and returns a
  // file:// URL without requiring the package to expose ./package.json.
  try {
    const resolvedUrl = import.meta.resolve("openclaw/plugin-sdk");
    return walkUpForSkillsDir(dirname(fileURLToPath(resolvedUrl)));
  } catch {}

  // Fallback: createRequire walk-up for environments where import.meta.resolve
  // is unavailable or behaves differently.
  try {
    const require = createRequire(import.meta.url);
    return walkUpForSkillsDir(dirname(require.resolve("openclaw/plugin-sdk")));
  } catch {}

  return null;
}

export type SkillDirs = {
  managed: string;
  bundled: string | null;
  personal: string;
};

/**
 * Resolve the deployment-wide skill source directories for this installation.
 */
export function resolveSkillDirs(stateDir: string): SkillDirs {
  return {
    managed: join(stateDir, "skills"),
    bundled: resolveBundledSkillsDir(),
    personal: join(os.homedir(), ".agents", "skills"),
  };
}

// ---------------------------------------------------------------------------
// Agent workspace resolution (mirrors openclaw's logic without importing
// internal modules that are not part of the plugin-sdk surface)
// ---------------------------------------------------------------------------

const DEFAULT_AGENT_ID = "main";

/** Minimal normalization matching openclaw's normalizeAgentId. */
function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim().toLowerCase();
  return trimmed || DEFAULT_AGENT_ID;
}

/**
 * Resolve the "default" agent ID from config.
 * Mirrors `resolveDefaultAgentId` from openclaw's agent-scope.ts.
 */
function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const list = cfg.agents?.list ?? [];
  if (list.length === 0) return DEFAULT_AGENT_ID;
  const defaultEntry = list.find((a) => a.default) ?? list[0];
  return normalizeAgentId(defaultEntry?.id);
}

/**
 * Return the list of agent IDs from config, always including the default.
 * Mirrors `listAgentIds` from openclaw's agent-scope.ts.
 */
function listAgentIds(cfg: OpenClawConfig | null): string[] {
  const list = cfg?.agents?.list ?? [];
  if (list.length === 0) return [DEFAULT_AGENT_ID];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of list) {
    const id = normalizeAgentId(entry?.id);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids.length > 0 ? ids : [DEFAULT_AGENT_ID];
}

/** Expand a path that may start with '~'. */
function expandHome(p: string): string {
  if (p.startsWith("~")) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/**
 * Resolve the workspace directory for a given agent.
 * Mirrors `resolveAgentWorkspaceDir` from openclaw's agent-scope.ts.
 */
function resolveAgentWorkspaceDir(
  cfg: OpenClawConfig | null,
  stateDir: string,
  agentId: string,
): string {
  const normalizedId = normalizeAgentId(agentId);
  const agentEntry = (cfg?.agents?.list ?? []).find(
    (a) => normalizeAgentId(a.id) === normalizedId,
  );
  if (agentEntry?.workspace?.trim()) {
    return expandHome(agentEntry.workspace.trim());
  }
  const defaultId = resolveDefaultAgentId(cfg ?? {});
  if (normalizedId === defaultId) {
    const defaultWorkspace = cfg?.agents?.defaults?.workspace?.trim();
    if (defaultWorkspace) {
      return expandHome(defaultWorkspace);
    }
    return join(stateDir, "workspace");
  }
  return join(stateDir, `workspace-${normalizedId}`);
}

// ---------------------------------------------------------------------------
// Directory scanner
// ---------------------------------------------------------------------------

/**
 * Scan a skill source directory and return CollectedSkill objects for each
 * skill directory that contains a readable SKILL.md file.
 *
 * @param dir - Absolute path to scan.
 * @param source - Skill source label.
 * @param agentName - Agent this collection belongs to.
 * @param ledgerKeyPrefix - Prefix for ledger keys, e.g. "skills/main/managed".
 * @param skillLedger - Current ledger entries for dirty-checking.
 * @param openClawConfig - OpenClaw config for status computation.
 */
async function collectFromDir(
  dir: string,
  source: SkillSource,
  agentName: string,
  ledgerKeyPrefix: string,
  skillLedger: Record<string, SkillLedgerEntry>,
  openClawConfig: OpenClawConfig | null,
): Promise<CollectedSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const results: CollectedSkill[] = [];

  for (const entry of entries) {
    const skillMdPath = join(dir, entry, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillMdPath, "utf8");
    } catch {
      // Not a skill dir or unreadable — skip silently
      continue;
    }

    const contentHash = "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
    const ledgerKey = `${ledgerKeyPrefix}/${entry}`;

    const frontmatter = parseSkillFrontmatter(content);
    const name = frontmatter.name ?? entry;
    // skillKey mirrors openclaw: metadata.openclaw.skillKey ?? dirName
    const ocMeta = frontmatter.metadata?.openclaw ?? {};
    const skillKey = typeof ocMeta.skillKey === "string" ? ocMeta.skillKey : entry;
    const available = computeAvailable(source, skillKey, name, ocMeta, openClawConfig);

    if (!isSkillDirty(skillLedger[ledgerKey], contentHash, available)) {
      continue;
    }

    results.push({
      name,
      source,
      agentName,
      skillMdPath,
      content,
      frontmatter,
      contentHash,
      ledgerKey,
      available,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main collector
// ---------------------------------------------------------------------------

/**
 * Collect all skills that are new or changed since the last upload.
 *
 * Every skill is exported under a real agent ID. Shared sources
 * (openclaw-bundled, openclaw-managed, agents-skills-personal) appear once per
 * agent so that per-agent availability is tracked independently. Per-agent
 * sources (openclaw-workspace, agents-skills-project) appear only under their
 * owning agent.
 *
 * Source strings match OpenClaw's own classification. Ledger key format:
 * "skills/{agentId}/{source}/{skillDirName}"
 *
 * Skills upload is gated by `filter.includeSkills` — callers should check
 * that before calling this function.
 */
export async function collectSkills(
  stateDir: string,
  ledger: Ledger,
  _filter: InfluxionFilterConfig,
  openClawConfig: OpenClawConfig | null,
): Promise<CollectedSkill[]> {
  const dirs = resolveSkillDirs(stateDir);
  const skillLedger = ledger.skills ?? {};
  const agentIds = listAgentIds(openClawConfig);

  // Track canonical workspace paths to avoid scanning the same directory for
  // two agents that share the same workspace.
  const seenWorkspaceDirs = new Set<string>();

  const tasks: Promise<CollectedSkill[]>[] = [];

  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(openClawConfig, stateDir, agentId);
    const canonicalWorkspace = resolve(workspaceDir);

    // Per-agent sources: workspace and project (.agents/skills/).
    // Deduplicate agents that share the same workspace directory.
    if (!seenWorkspaceDirs.has(canonicalWorkspace)) {
      seenWorkspaceDirs.add(canonicalWorkspace);
      tasks.push(
        collectFromDir(
          join(workspaceDir, "skills"),
          "openclaw-workspace",
          agentId,
          `skills/${agentId}/openclaw-workspace`,
          skillLedger,
          openClawConfig,
        ),
      );
      tasks.push(
        collectFromDir(
          join(workspaceDir, ".agents", "skills"),
          "agents-skills-project",
          agentId,
          `skills/${agentId}/agents-skills-project`,
          skillLedger,
          openClawConfig,
        ),
      );
    }

    // Shared sources: managed, bundled, personal — one record per agent for
    // independent per-agent status tracking.
    tasks.push(
      collectFromDir(
        dirs.managed,
        "openclaw-managed",
        agentId,
        `skills/${agentId}/openclaw-managed`,
        skillLedger,
        openClawConfig,
      ),
    );
    if (dirs.bundled) {
      tasks.push(
        collectFromDir(
          dirs.bundled,
          "openclaw-bundled",
          agentId,
          `skills/${agentId}/openclaw-bundled`,
          skillLedger,
          openClawConfig,
        ),
      );
    }
    tasks.push(
      collectFromDir(
        dirs.personal,
        "agents-skills-personal",
        agentId,
        `skills/${agentId}/agents-skills-personal`,
        skillLedger,
        openClawConfig,
      ),
    );
  }

  const batches = await Promise.all(tasks);
  return batches.flat();
}
