import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
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

const RECONNECT_INITIAL_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_MULTIPLIER = 2;
const WEBEX_API = "https://webexapis.com/v1";

async function webexGet(path: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${WEBEX_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`webex GET ${path} failed: HTTP ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

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

  const me = (await webexGet("/people/me", token)) as {
    id: string;
    emails: string[];
    displayName: string;
  };
  const botPersonId = me.id;
  runtime.log(`webex: connected as ${me.displayName} (${me.emails[0] ?? ""})`);

  await runWebexWdmLoop({ token, botPersonId, cfg, accountId, runtime, abortSignal });
}

async function discoverWdmUrl(token: string): Promise<string> {
  const u2cUrl = process.env.U2C_SERVICE_URL ?? "https://u2c.wbx2.com/u2c/api/v1";
  const catalogRes = await fetch(`${u2cUrl}/user/catalog`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!catalogRes.ok) throw new Error(`webex: U2C catalog failed: HTTP ${catalogRes.status}`);
  const catalog = (await catalogRes.json()) as {
    serviceLinks?: Record<string, unknown>;
    services?: Array<{ name: string; serviceUrl?: string; url?: string }>;
  };
  const wdmEntry = catalog.serviceLinks?.wdm ?? catalog.services?.find((s) => s.name === "wdm");
  if (wdmEntry)
    return typeof wdmEntry === "string"
      ? wdmEntry
      : ((wdmEntry as { serviceUrl?: string; url?: string }).serviceUrl ??
          (wdmEntry as { url?: string }).url ??
          "https://wdm-a.wbx2.com/wdm/api/v1");
  return "https://wdm-a.wbx2.com/wdm/api/v1";
}

async function runWebexWdmLoop(opts: {
  token: string;
  botPersonId: string;
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { token, botPersonId, cfg, accountId, runtime, abortSignal } = opts;
  const { WebSocket } = await import("ws");

  const wdmBaseUrl = await discoverWdmUrl(token);
  const regRes = await fetch(`${wdmBaseUrl}/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "openclaw-bot",
      deviceType: "WEB",
      model: "web-js-sdk",
      localizedModel: "webex-js-sdk",
      systemName: "WEBEX_JS_SDK",
      systemVersion: "1.0.0",
    }),
  });
  if (!regRes.ok) {
    const text = await regRes.text().catch(() => "");
    throw new Error(`webex: WDM device registration failed: HTTP ${regRes.status} ${text}`);
  }
  const device = (await regRes.json()) as { webSocketUrl?: string };
  const wsUrl = device.webSocketUrl;
  if (!wsUrl) throw new Error("webex: WDM device registration did not return webSocketUrl");

  runtime.log("webex: WebSocket listener active (outbound WSS — no inbound port required)");

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
    const cleanup = () => {
      try {
        ws.close();
      } catch {}
    };
    abortSignal?.addEventListener("abort", () => {
      cleanup();
      resolve();
    });
    ws.on("error", (err: Error) => {
      cleanup();
      reject(err);
    });
    ws.on("close", () => resolve());
    ws.on("message", (raw: Buffer) => {
      let envelope: Record<string, unknown>;
      try {
        envelope = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const data = envelope?.data as Record<string, unknown> | undefined;
      if (data?.eventType !== "conversation.activity") return;
      const activity = data?.activity as Record<string, unknown> | undefined;
      if (!activity || activity.verb !== "post") return;
      const actor = activity.actor as Record<string, unknown> | undefined;
      if (actor?.entryUUID === botPersonId || actor?.id === botPersonId) return;
      const msgId = (activity.id ?? activity.url) as string | undefined;
      if (!msgId) return;
      const cleanId = msgId.replace(/.*\/messages\//, "");
      webexGet(`/messages/${encodeURIComponent(cleanId)}`, token)
        .then((msg) => {
          const inbound = msg as unknown as WebexInboundMessage;
          if (!inbound || inbound.personId === botPersonId) return;
          void processWebexMessage({ cfg, accountId, runtime, msg: inbound, botPersonId }).catch(
            (err: unknown) => {
              runtime.error(`webex: dispatch error: ${String(err)}`);
            },
          );
        })
        .catch(() => {});
    });
  });
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

function isWebexSenderAllowed(
  cfg: OpenClawConfig,
  accountId: string,
  senderEmail: string | undefined,
): boolean {
  const webexCfg = (cfg.channels as Record<string, unknown> | undefined)?.webex as
    | Record<string, unknown>
    | undefined;
  const accountCfg =
    accountId !== "default"
      ? (webexCfg?.accounts as Record<string, { allowFrom?: string[] }> | undefined)?.[accountId]
      : undefined;
  const allowFrom = accountCfg?.allowFrom ?? (webexCfg?.allowFrom as string[] | undefined);
  if (!allowFrom || allowFrom.length === 0) return true;
  if (!senderEmail) return false;
  const sender = senderEmail.toLowerCase();
  return allowFrom.some((entry) => {
    const e = String(entry).toLowerCase();
    if (e === "*") return true;
    if (e.startsWith("@")) return sender.endsWith(e);
    return sender === e;
  });
}

async function processWebexMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  msg: WebexInboundMessage;
  botPersonId: string;
}): Promise<void> {
  const { cfg, accountId, runtime, msg, botPersonId } = params;

  if (!isWebexSenderAllowed(cfg, accountId, msg.personEmail)) return;

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
