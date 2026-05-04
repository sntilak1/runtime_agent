import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { projectConfigWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  listDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import type { ChannelPlugin, OpenClawConfig } from "../runtime-api.js";
import {
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "../runtime-api.js";
import { listWebexAccountIds, resolveWebexAccount } from "./accounts.js";
import { WebexChannelConfigSchema } from "./config-schema.js";
import { resolveWebexOutboundSessionRoute } from "./conversation-route.js";
import type { ProbeWebexResult } from "./probe.js";
import { webexSetupAdapter } from "./setup-core.js";
import { webexSetupWizard } from "./setup-surface.js";
import { resolveWebexToken } from "./token.js";

type ResolvedWebexAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
};

const loadWebexRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "webexChannelRuntime",
);

const webexConfigAdapter = createTopLevelChannelConfigAdapter<
  ResolvedWebexAccount,
  { allowFrom?: string[]; defaultTo?: string }
>({
  sectionKey: "webex",
  listAccountIds: (cfg) => listWebexAccountIds(cfg),
  resolveAccount: (cfg) => {
    const { token } = resolveWebexToken(cfg);
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      enabled: (cfg.channels as Record<string, { enabled?: boolean }>)?.webex?.enabled !== false,
      configured: Boolean(token),
    };
  },
  resolveAccessorAccount: ({ cfg }) => ({
    allowFrom: (cfg.channels as Record<string, { allowFrom?: string[] }>)?.webex?.allowFrom,
    defaultTo: (cfg.channels as Record<string, { defaultTo?: string }>)?.webex?.defaultTo,
  }),
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) => formatAllowFromLowercase({ allowFrom }),
  resolveDefaultTo: (account) => account.defaultTo,
});

export const webexPlugin: ChannelPlugin<ResolvedWebexAccount, ProbeWebexResult> =
  createChatChannelPlugin({
    base: {
      id: "webex",
      meta: {
        id: "webex",
        label: "Webex",
        selectionLabel: "Webex (WebSocket Bot)",
        docsPath: "/channels/webex",
        docsLabel: "webex",
        blurb:
          "Cisco Webex rooms via outbound WebSocket — works behind NAT and in private subnets.",
        aliases: ["cisco-webex"],
        order: 65,
      },
      setupWizard: webexSetupWizard,
      capabilities: {
        chatTypes: ["direct", "group"],
        threads: false,
        media: true,
        polls: false,
      },
      reload: { configPrefixes: ["channels.webex"] },
      configSchema: WebexChannelConfigSchema,
      config: {
        ...webexConfigAdapter,
        isConfigured: (account, cfg) =>
          Boolean(resolveWebexToken(cfg, { accountId: account.accountId }).token),
        resolveAccount: (cfg, accountId) => {
          const resolved = resolveWebexAccount({ cfg, accountId });
          return {
            accountId: resolved.accountId,
            enabled: resolved.enabled,
            configured: resolved.tokenSource !== "none",
          };
        },
        describeAccount: (account) =>
          describeAccountSnapshot({ account, configured: account.configured }),
      },
      setup: webexSetupAdapter,
      messaging: {
        normalizeTarget: (target: string) => target.trim() || null,
        resolveOutboundSessionRoute: (params) => resolveWebexOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: (raw: string) =>
            // Webex room IDs are base64url-encoded, typically 60+ chars
            /^[A-Za-z0-9+/=_-]{40,}$/.test(raw.trim()),
          hint: "<room_id>",
        },
      },
      directory: createChannelDirectoryAdapter({
        self: async ({ cfg }) => {
          const { token } = resolveWebexToken(cfg);
          if (!token) return null;
          try {
            const res = await fetch("https://webexapis.com/v1/people/me", {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { id: string; displayName?: string };
            return { kind: "user" as const, id: data.id, name: data.displayName };
          } catch {
            return null;
          }
        },
        listPeers: async ({ cfg, query, limit }) =>
          listDirectoryEntriesFromSources({
            kind: "user",
            sources: [
              (cfg.channels as Record<string, { allowFrom?: string[] }>)?.webex?.allowFrom ?? [],
            ],
            query,
            limit,
            normalizeId: (raw) => raw.trim(),
          }),
        listGroups: async () => [],
      }),
      status: createComputedAccountStatusAdapter<ResolvedWebexAccount, ProbeWebexResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, { port: null }),
        probeAccount: async ({ cfg }) => {
          const { token } = resolveWebexToken(cfg);
          return (await loadWebexRuntime()).probeWebex(token);
        },
        formatCapabilitiesProbe: ({ probe }) => {
          const lines: Array<{ text: string; tone?: "error" }> = [];
          if (probe?.displayName) lines.push({ text: `Bot: ${probe.displayName}` });
          if (probe?.botEmail) lines.push({ text: `Email: ${probe.botEmail}` });
          return lines;
        },
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: { port: null },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorWebexProvider } = await loadWebexRuntime();
          ctx.log?.info("webex: starting outbound WebSocket monitor");
          return monitorWebexProvider({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
          });
        },
      },
    },
    security: {
      collectWarnings: projectConfigWarningCollector<{ cfg: OpenClawConfig }>(({ cfg }) =>
        cfg.channels &&
        "webex" in cfg.channels &&
        (cfg.channels as Record<string, { groupPolicy?: string }>).webex?.groupPolicy === "open"
          ? [
              '- Webex: groupPolicy="open" allows any room member to trigger the bot. Set channels.webex.groupPolicy="allowlist" or "mention" to restrict.',
            ]
          : [],
      ),
    },
    pairing: {
      text: {
        idLabel: "webexRoomId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^webex:/i),
        notify: async ({ cfg, id, message }) => {
          const { sendMessageWebex } = await loadWebexRuntime();
          await sendMessageWebex({ cfg, to: id, text: message });
        },
      },
    },
    outbound: {
      deliveryMode: "direct",
      chunker: chunkTextForOutbound,
      chunkerMode: "markdown",
      // Webex message limit is 7439 chars for Markdown; use a safe margin.
      textChunkLimit: 7000,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadWebexRuntime,
        sendText: {
          resolve: (runtime) => async (ctx) => {
            const result = await runtime.sendMessageWebex({
              cfg: ctx.cfg,
              accountId: ctx.accountId,
              to: ctx.to,
              markdown: ctx.text,
            });
            return { channel: "webex" as const, messageId: result.messageId };
          },
        },
        sendMedia: {
          resolve: (runtime) => async (ctx) => {
            const result = await runtime.sendMediaWebex({
              cfg: ctx.cfg,
              accountId: ctx.accountId,
              to: ctx.to,
              text: ctx.text || undefined,
              mediaUrl: ctx.mediaUrl!,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
            });
            return { channel: "webex" as const, messageId: result.messageId };
          },
        },
      }),
    },
  });
