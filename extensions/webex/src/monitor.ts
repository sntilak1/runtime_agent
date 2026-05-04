import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { waitForAbortSignal } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWebexConversationRoute } from "./conversation-route.js";
import { getWebexRuntime } from "./runtime.js";
import { isWebexAllowedMime, sendMessageWebex } from "./send.js";
import { resolveWebexToken } from "./token.js";

export type WebexInboundMessage = {
  id: string;
  roomId: string;
  roomType: "direct" | "group";
  text: string;
  markdown?: string;
  personId: string;
  personEmail: string;
  created: string;
  mentionedPeople?: string[];
  files?: string[];
};

export type MonitorWebexOpts = {
  cfg: OpenClawConfig;
  accountId?: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
};

// Webex SDK loaded lazily to keep startup cost minimal.
type WebexInstance = {
  messages: {
    listen: () => Promise<void>;
    stopListening: () => Promise<void>;
    on: (
      event: string,
      handler: (event: { data: WebexInboundMessage }) => void | Promise<void>,
    ) => void;
  };
  people: {
    get: (id: "me") => Promise<{ id: string; emails: string[]; displayName: string }>;
  };
};

async function loadWebexSdk(): Promise<{
  init: (opts: { credentials: { access_token: string } }) => WebexInstance;
}> {
  const mod = await import("webex");
  return (mod.default ?? mod) as unknown as {
    init: (opts: { credentials: { access_token: string } }) => WebexInstance;
  };
}

const RECONNECT_INITIAL_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MULTIPLIER = 2;

export async function monitorWebexProvider(opts: MonitorWebexOpts): Promise<void> {
  const { cfg, accountId = "default", runtime, abortSignal } = opts;

  let backoffMs = RECONNECT_INITIAL_MS;
  let stopped = false;

  abortSignal?.addEventListener("abort", () => {
    stopped = true;
  });

  while (!stopped) {
    try {
      await runWebexSession({ cfg, accountId, runtime, abortSignal });
      break;
    } catch (err) {
      if (stopped) break;
      const msg = err instanceof Error ? err.message : String(err);
      runtime.error(`webex monitor error (retrying in ${backoffMs}ms): ${msg}`);
      await sleep(backoffMs, abortSignal);
      backoffMs = Math.min(backoffMs * RECONNECT_MULTIPLIER, RECONNECT_MAX_MS);
    }
  }
}

async function runWebexSession(opts: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, accountId, runtime, abortSignal } = opts;
  const { token } = resolveWebexToken(cfg, { accountId });

  if (!token) {
    throw new Error("webex: no bot token — set channels.webex.botToken or WEBEX_BOT_TOKEN");
  }

  const Webex = await loadWebexSdk();
  const webex = Webex.init({ credentials: { access_token: token } });

  const me = await webex.people.get("me");
  const botPersonId = me.id;
  runtime.log(`webex: connected as ${me.displayName} (${me.emails[0] ?? ""})`);

  await webex.messages.listen();
  runtime.log("webex: WebSocket listener active (outbound WSS — no inbound port required)");

  webex.messages.on("created", (event: { data: WebexInboundMessage }) => {
    const msg = event.data;
    // Ignore own messages.
    if (msg.personId === botPersonId) return;

    void processWebexMessage({ cfg, accountId, runtime, msg, botPersonId }).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        runtime.error(`webex: dispatch error: ${message}`);
      },
    );
  });

  await waitForAbortSignal(abortSignal);
  await webex.messages.stopListening().catch(() => {});
}

// 50 MB inbound limit, matching the outbound cap.
const WEBEX_INBOUND_MAX_BYTES = 50 * 1024 * 1024;

type WebexMediaResult = {
  path: string;
  contentType?: string;
};

async function downloadWebexFile(url: string, token: string): Promise<WebexMediaResult | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? undefined;
  if (!isWebexAllowedMime(contentType)) return null;

  let buffer: Buffer;
  try {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > WEBEX_INBOUND_MAX_BYTES) return null;
    buffer = Buffer.from(bytes);
  } catch {
    return null;
  }

  const contentDisposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i.exec(contentDisposition);
  const originalFilename = filenameMatch?.[1]?.trim() ?? undefined;

  try {
    const saved = await saveMediaBuffer(
      buffer,
      contentType,
      "inbound",
      WEBEX_INBOUND_MAX_BYTES,
      originalFilename,
    );
    return { path: saved.path, contentType: saved.contentType };
  } catch {
    return null;
  }
}

async function resolveWebexInboundMedia(
  fileUrls: string[],
  token: string,
): Promise<WebexMediaResult[]> {
  const results = await Promise.all(fileUrls.map((url) => downloadWebexFile(url, token)));
  return results.filter((r): r is WebexMediaResult => r !== null);
}

async function processWebexMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  msg: WebexInboundMessage;
  botPersonId: string;
}): Promise<void> {
  const { cfg, accountId, runtime, msg, botPersonId } = params;

  const route = resolveWebexConversationRoute({
    cfg,
    accountId,
    roomId: msg.roomId,
    isGroup: msg.roomType === "group",
    senderId: msg.personEmail,
    senderPersonId: msg.personId,
    mentionedPeople: msg.mentionedPeople,
    botPersonId,
  });
  if (!route) return;

  const { token } = resolveWebexToken(cfg, { accountId });

  let mediaResults: WebexMediaResult[] = [];
  if (msg.files && msg.files.length > 0 && token) {
    mediaResults = await resolveWebexInboundMedia(msg.files, token).catch((err: unknown) => {
      runtime.error(`webex: inbound media download error: ${String(err)}`);
      return [];
    });
  }

  const firstMedia = mediaResults[0];
  const ctxPayload = finalizeInboundContext({
    From: msg.personEmail,
    Body: msg.text,
    BodyForAgent: msg.text,
    CommandBody: msg.text,
    MessageSid: msg.id,
    AccountId: accountId,
    ChatType: msg.roomType === "direct" ? "direct" : "group",
    Channel: "webex",
    ...(firstMedia
      ? {
          MediaPath: firstMedia.path,
          MediaUrl: firstMedia.path,
          MediaType: firstMedia.contentType,
          MediaPaths: mediaResults.map((m) => m.path),
          MediaUrls: mediaResults.map((m) => m.path),
          MediaTypes: mediaResults.map((m) => m.contentType ?? ""),
        }
      : {}),
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "webex",
    accountId,
  });

  const core = getWebexRuntime();

  await core.channel.turn.run({
    channel: "webex",
    accountId,
    raw: msg,
    adapter: {
      ingest: () => ({
        id: msg.id,
        rawText: msg.text,
      }),
      resolveTurn: () => ({
        cfg,
        channel: "webex",
        accountId,
        agentId: route.agentId,
        routeSessionKey: route.sessionKey,
        storePath: core.channel.session.resolveStorePath(undefined, { agentId: route.agentId }),
        ctxPayload,
        recordInboundSession: core.channel.session.recordInboundSession,
        dispatchReplyWithBufferedBlockDispatcher:
          core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
        dispatcherOptions: { ...replyPipeline },
        replyOptions: { onModelSelected },
        delivery: {
          deliver: async (payload: ReplyPayload, _info) => {
            const text = payload.text ?? "";
            if (!text) return;
            await sendMessageWebex({ cfg, accountId, to: msg.roomId, markdown: text });
          },
          onError: (err: unknown, _info) => {
            runtime.error(`webex: reply delivery failed: ${String(err)}`);
          },
        },
      }),
    },
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
