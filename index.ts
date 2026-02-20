import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { InfluxionConfigSchema } from "./src/config.js";
import { createUploadService } from "./src/service.js";
import { registerInfluxionCli } from "./src/cli.js";

const plugin = {
  id: "influxion",
  name: "Influxion Agent Manager",
  description:
    "Periodically uploads agent session transcripts to Influxion for performance evaluation.",
  // The real config schema is declared in openclaw.plugin.json and validated there.
  // We use emptyPluginConfigSchema here and do our own Zod validation at register time.
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Parse the plugin config. A missing or incomplete config is not fatal —
    // the plugin registers normally but skips uploads until configured.
    const parseResult = InfluxionConfigSchema.safeParse(api.pluginConfig ?? {});
    const cfg = parseResult.success ? parseResult.data : null;

    if (!cfg) {
      api.logger.warn(
        "influxion: missing or invalid configuration — uploads disabled. " +
          "Set apiKey and deploymentId to enable. " +
          `(${parseResult.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")})`,
      );
    }

    // Always register the service (it no-ops when cfg is null)
    api.registerService(createUploadService(cfg, api.config));

    // Always register the CLI so users can run `openclaw influxion status`
    api.registerCli(registerInfluxionCli(cfg), { commands: ["influxion"] });

    // Hook: session ended
    api.on("session_end", (event, ctx) => {
      if (!cfg) return;
      const agentId = ctx.agentId ?? "unknown";
      api.logger.info(
        `influxion: session ended — agent=${agentId} session=${event.sessionId} ` +
          `messages=${event.messageCount}`,
      );
    });

    // Hook: compaction finished — transcript rewritten, will appear dirty on next run
    api.on("after_compaction", (event, ctx) => {
      if (!cfg) return;
      const agentId = ctx.agentId ?? "unknown";
      api.logger.info(
        `influxion: compaction complete — agent=${agentId} ` +
          `session=${ctx.sessionId ?? "unknown"} ` +
          `messages=${event.messageCount} compacted=${event.compactedCount}`,
      );
    });

    if (cfg) {
      api.logger.info(
        `influxion: plugin registered — deployment=${cfg.deploymentId} interval=${cfg.upload.every}`,
      );
    }
  },
};

export default plugin;
