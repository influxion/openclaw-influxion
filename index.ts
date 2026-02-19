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
    // Parse and validate the plugin config supplied by the user.
    // If required fields (apiKey, deploymentId) are missing, log a clear error and bail.
    const parseResult = InfluxionConfigSchema.safeParse(api.pluginConfig ?? {});
    if (!parseResult.success) {
      api.logger.error(
        "influxion: invalid configuration — plugin disabled. " +
          "Ensure 'apiKey' and 'deploymentId' are set. " +
          `Details: ${parseResult.error.message}`,
      );
      return;
    }

    const cfg = parseResult.data;

    // Register the background upload service
    api.registerService(createUploadService(cfg));

    // Register the `openclaw influxion` CLI subcommand group
    api.registerCli(registerInfluxionCli(cfg), { commands: ["influxion"] });

    // Hook: session ended — the service will pick up the updated file on next run
    // via mtime comparison. We log here so users can see activity.
    api.on("session_end", (event, ctx) => {
      const agentId = ctx.agentId ?? "unknown";
      api.logger.info(
        `influxion: session ended — agent=${agentId} session=${event.sessionId} ` +
          `messages=${event.messageCount}`,
      );
    });

    // Hook: compaction finished — the transcript has been rewritten, so it will
    // appear dirty to the ledger on the next scheduled run.
    api.on("after_compaction", (event, ctx) => {
      const agentId = ctx.agentId ?? "unknown";
      api.logger.info(
        `influxion: compaction complete — agent=${agentId} ` +
          `session=${ctx.sessionId ?? "unknown"} ` +
          `messages=${event.messageCount} compacted=${event.compactedCount}`,
      );
    });

    api.logger.info(
      `influxion: plugin registered — deployment=${cfg.deploymentId} interval=${cfg.upload.every}`,
    );
  },
};

export default plugin;
