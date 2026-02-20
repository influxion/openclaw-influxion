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
  content: string;
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
 * Upload a batch of collected skills to the Influxion API.
 * Sends all skills in a single request; retries the whole batch on failure.
 */
export async function uploadSkillsBatch(
  skills: CollectedSkill[],
  config: InfluxionConfig,
): Promise<SkillsBatchResult> {
  if (skills.length === 0) {
    return { uploaded: [], failed: [] };
  }

  const envelopes: SkillEnvelope[] = skills.map((skill) => ({
    deploymentId: config.deploymentId,
    projectId: config.projectId,
    agentName: skill.agentName,
    skillName: skill.name,
    skillDescription: skill.frontmatter.description ?? null,
    source: skill.source,
    metadataVersion: resolveMetadataString(skill.frontmatter.metadata, "version"),
    metadataAuthor: resolveMetadataString(skill.frontmatter.metadata, "author"),
    content: skill.content,
    contentHash: skill.contentHash,
    available: skill.available,
  }));

  const url = `${config.apiUrl.replace(/\/+$/, "")}/v1/openclaw/ingest/skills`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.upload.retryAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(config.upload.retryBackoffMs * attempt);
    }
    try {
      await postJson(url, config.apiKey, { skills: envelopes }, config.upload.timeoutMs);
      return {
        uploaded: skills.map((skill) => ({ skill })),
        failed: [],
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const error = lastError?.message ?? "Upload failed after all retry attempts";
  return {
    uploaded: [],
    failed: skills.map((skill) => ({ skill, error })),
  };
}
