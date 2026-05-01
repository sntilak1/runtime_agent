import {
  collectSecretInputAssignment,
  getChannelRecord,
  type ResolverContext,
  type SecretDefaults,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const secretTargetRegistryEntries = [
  {
    id: "channels.webex.botToken",
    targetType: "channels.webex.botToken",
    configFile: "openclaw.json",
    pathPattern: "channels.webex.botToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] satisfies SecretTargetRegistryEntry[];

export function collectRuntimeConfigAssignments(params: {
  config: { channels?: Record<string, unknown> };
  defaults?: SecretDefaults;
  context: ResolverContext;
}): void {
  const webex = getChannelRecord(params.config, "webex");
  if (!webex) return;
  collectSecretInputAssignment({
    value: (webex as Record<string, unknown>).botToken,
    path: "channels.webex.botToken",
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: (webex as { enabled?: boolean }).enabled !== false,
    inactiveReason: "Webex channel is disabled.",
    apply: (value) => {
      (webex as Record<string, unknown>).botToken = value;
    },
  });
}

export const channelSecrets = {
  envKeys: ["WEBEX_BOT_TOKEN"],
  configPaths: ["channels.webex.botToken"],
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
};
