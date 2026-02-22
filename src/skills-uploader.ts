import type { CollectedSkill } from "./skills-collector.js";
import type { InfluxionConfig } from "./config.js";

/** One skill envelope sent to Influxion. */
type SkillEnvelope = {
  deploymentId: string;
  projectId: string;
  agentName: string;
  skillName: string;
  skillDescription: string | null;
  source: string;
  metadataVersion: string | null;
  metadataAuthor: string | null;
  /** Full SKILL.md text. Omitted for clean (unchanged) skills in manifest-only entries. */
  content?: string;
  contentHash: string;
  available: boolean;
};

type IngestSkillsResponse = {
  accepted: number;
  rejected: number;
  batchId: string;
  errors?: Array<{ skillName: string; reason: string }>;
};

export type SkillUploadResult = {
  skill: CollectedSkill;
};

export type SkillsBatchResult = {
  uploaded: SkillUploadResult[];
  failed: Array<{ skill: CollectedSkill; error: string }>;
}

/**
 * The full batch sent in one request: dirty skills carry their SKILL.md content
 * while clean skills are manifest-only (no content field). fullSync=true tells
 * the gateway to mark any DB rows absent from this manifest as unavailable.
 */
export type SkillsBatch = {
  /** Skills whose content has changed — full content included. */
  dirty: CollectedSkill[];
  /** Skills that are unchanged — manifest metadata only, no content. */
  clean: CollectedSkill[];
};

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
): Promise<IngestSkillsResponse> {
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

    return (await response.json()) as IngestSkillsResponse;
  } finally {
    clearTimeout(timer);
  }
}

function resolveMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const val = metadata?.[key];
  return typeof val === "string" ? val : null;
}

/**
 * Upload a batch of skills to the Influxion API.
 *
 * Dirty skills carry their full SKILL.md content; clean skills are sent as
 * manifest-only entries (no content field). Setting fullSync=true tells the
 * gateway to mark any DB rows absent from this manifest as unavailable,
 * which handles skill removals automatically.
 *
 * The entire batch is sent in a single request and retried as a unit on failure.
 */
export async function uploadSkillsBatch(
  batch: SkillsBatch,
  config: InfluxionConfig,
): Promise<SkillsBatchResult> {
  const allSkills = [...batch.dirty, ...batch.clean];
  if (allSkills.length === 0) {
    return { uploaded: [], failed: [] };
  }

  const dirtySet = new Set(batch.dirty.map((s) => s.ledgerKey));

  const envelopes: SkillEnvelope[] = allSkills.map((skill) => {
    const envelope: SkillEnvelope = {
      deploymentId: config.deploymentId,
      projectId: config.projectId,
      agentName: skill.agentName,
      skillName: skill.name,
      skillDescription: skill.frontmatter.description ?? null,
      source: skill.source,
      metadataVersion: resolveMetadataString(skill.frontmatter.metadata, "version"),
      metadataAuthor: resolveMetadataString(skill.frontmatter.metadata, "author"),
      contentHash: skill.contentHash,
      available: skill.available,
    };
    // Only include full content for dirty skills
    if (dirtySet.has(skill.ledgerKey)) {
      envelope.content = skill.content;
    }
    return envelope;
  });

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/openclaw/ingest/skills`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.upload.retryAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(config.upload.retryBackoffMs * attempt);
    }
    try {
      await postJson(
        url,
        config.apiKey,
        { fullSync: true, skills: envelopes },
        config.upload.timeoutMs,
      );
      return {
        uploaded: allSkills.map((skill) => ({ skill })),
        failed: [],
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const error = lastError?.message ?? "Upload failed after all retry attempts";
  return {
    uploaded: [],
    failed: allSkills.map((skill) => ({ skill, error })),
  };
}
