/**
 * Type declarations for openclaw/plugin-sdk.
 *
 * This stub covers the subset of the SDK used by this plugin.
 * At runtime, openclaw's gateway resolves `openclaw/plugin-sdk` via jiti,
 * so these declarations are only used at compile time.
 *
 * To regenerate from the real SDK, run:
 *   cd ../openclaw && pnpm build
 * then point tsconfig paths to dist/plugin-sdk/index.d.ts instead.
 */
declare module "openclaw/plugin-sdk" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyObject = Record<string, any>;

  export type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  export type OpenClawConfig = AnyObject;

  export type OpenClawPluginServiceContext = {
    config: OpenClawConfig;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
  };

  export type OpenClawPluginService = {
    id: string;
    start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
  };

  /** Commander program — typed as `any` here; add `commander` as a devDep for full types. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export type CliProgram = any;

  export type OpenClawPluginCliContext = {
    program: CliProgram;
    config: OpenClawConfig;
    workspaceDir?: string;
    logger: PluginLogger;
  };

  export type OpenClawPluginCliRegistrar = (
    ctx: OpenClawPluginCliContext,
  ) => void | Promise<void>;

  export type PluginHookSessionEndEvent = {
    sessionId: string;
    messageCount: number;
    durationMs?: number;
  };

  export type PluginHookSessionContext = {
    agentId?: string;
    sessionId: string;
  };

  export type PluginHookAfterCompactionEvent = {
    messageCount: number;
    tokenCount?: number;
    compactedCount: number;
    /** Path to the session JSONL transcript. */
    sessionFile?: string;
  };

  export type PluginHookAgentContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    workspaceDir?: string;
    messageProvider?: string;
  };

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    config: OpenClawConfig;
    pluginConfig?: AnyObject;
    logger: PluginLogger;
    registerService(service: OpenClawPluginService): void;
    registerCli(registrar: OpenClawPluginCliRegistrar, opts?: { commands?: string[] }): void;
    on(
      event: "session_end",
      handler: (
        event: PluginHookSessionEndEvent,
        ctx: PluginHookSessionContext,
      ) => void | Promise<void>,
    ): void;
    on(
      event: "after_compaction",
      handler: (
        event: PluginHookAfterCompactionEvent,
        ctx: PluginHookAgentContext,
      ) => void | Promise<void>,
    ): void;
    on(event: string, handler: (...args: unknown[]) => unknown): void;
  };

  export function emptyPluginConfigSchema(): AnyObject;
}
