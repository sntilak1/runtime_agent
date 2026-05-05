import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveWebexConversationRoute } from "./conversation-route.js";
import {
  buildRoomContextNote,
  clearPendingRoomSelection,
  findSharedRoomsWithWorkspace,
  getRoomProjectContext,
  hasPendingRoomSelection,
  resolvePendingRoomSelection,
  saveRoomFile,
  storePendingRoomSelection,
} from "./room-workspace.js";
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
      const activity = data?.activity as Record<string, unknown> | undefined;
      if (data?.eventType !== "conversation.activity") return;
      if (!activity || (activity.verb !== "post" && activity.verb !== "share")) return;
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
        .catch((err: unknown) => {
          runtime.error(`webex: GET /messages failed: ${String(err)}`);
        });
    });
  });
}

// 50 MB inbound limit, matching the outbound cap.
const WEBEX_INBOUND_MAX_BYTES = 50 * 1024 * 1024;

type WebexMediaResult = {
  path: string;
  contentType?: string;
  originalFilename?: string;
  buffer?: Buffer;
};

// Webex file content may return 423 (Locked) while being processed/scanned.
const WEBEX_FILE_RETRY_DELAYS_MS = [2000, 4000, 8000];

async function fetchWebexFileWithRetry(
  url: string,
  token: string,
  runtime: RuntimeEnv,
): Promise<Response | null> {
  const delays = [0, ...WEBEX_FILE_RETRY_DELAYS_MS];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    const delayMs = delays[attempt]!;
    if (delayMs > 0) await sleep(delayMs);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      runtime.error(`webex: file fetch error: ${String(err)}`);
      return null;
    }
    if (res.status === 423) {
      continue;
    }
    if (!res.ok) {
      runtime.error(`webex: file fetch HTTP ${res.status}`);
      return null;
    }
    return res;
  }
  return null;
}

// Extensions that Webex may serve as text/plain but are valid inbound attachments.
const WEBEX_INBOUND_ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".txt",
  ".csv",
  ".rtf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
]);

function resolveInboundContentType(
  headerContentType: string | undefined,
  originalFilename: string | undefined,
): string | undefined {
  // Webex frequently reports text/plain for all file types.
  // Use the filename extension to determine the real MIME when the header is unhelpful.
  if (headerContentType && headerContentType !== "text/plain") {
    return headerContentType;
  }
  if (!originalFilename) return headerContentType;
  const ext = originalFilename.slice(originalFilename.lastIndexOf(".")).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".rtf": "application/rtf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? headerContentType;
}

async function downloadWebexFile(
  url: string,
  token: string,
  runtime: RuntimeEnv,
): Promise<WebexMediaResult | null> {
  const res = await fetchWebexFileWithRetry(url, token, runtime);
  if (!res) return null;

  const headerContentType = res.headers.get("content-type") ?? undefined;

  const contentDisposition = res.headers.get("content-disposition") ?? "";
  const filenameMatch = /filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i.exec(contentDisposition);
  const originalFilename = filenameMatch?.[1]?.trim() ?? undefined;

  const resolvedContentType = resolveInboundContentType(headerContentType, originalFilename);

  // Allow if the resolved content-type matches, OR if the extension is on the allowed list
  // (Webex may serve files as text/plain regardless of actual type).
  const ext = originalFilename
    ? originalFilename.slice(originalFilename.lastIndexOf(".")).toLowerCase()
    : "";
  const allowedByExtension = ext !== "" && WEBEX_INBOUND_ALLOWED_EXTENSIONS.has(ext);
  const allowedByMime = isWebexAllowedMime(resolvedContentType);

  if (!allowedByMime && !allowedByExtension) {
    runtime.log(
      `webex: skipping file — content-type: ${headerContentType ?? "(none)"}, filename: ${originalFilename ?? "(none)"}`,
    );
    return null;
  }

  let buffer: Buffer;
  try {
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > WEBEX_INBOUND_MAX_BYTES) return null;
    buffer = Buffer.from(bytes);
  } catch {
    return null;
  }

  runtime.log(
    `webex: downloading file: ${originalFilename ?? "(unnamed)"} type=${resolvedContentType ?? headerContentType ?? "unknown"}`,
  );

  try {
    const saved = await saveMediaBuffer(
      buffer,
      resolvedContentType,
      "inbound",
      WEBEX_INBOUND_MAX_BYTES,
      originalFilename,
    );
    return {
      path: saved.path,
      contentType: saved.contentType ?? resolvedContentType,
      originalFilename,
      buffer,
    };
  } catch {
    return null;
  }
}

async function resolveWebexInboundMedia(
  fileUrls: string[],
  token: string,
  runtime: RuntimeEnv,
): Promise<WebexMediaResult[]> {
  const results = await Promise.all(fileUrls.map((url) => downloadWebexFile(url, token, runtime)));
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

// ---- Room title lookup -------------------------------------------------------

async function fetchRoomTitle(roomId: string, token: string): Promise<string | undefined> {
  try {
    const room = (await webexGet(`/rooms/${encodeURIComponent(roomId)}`, token)) as {
      title?: string;
    };
    return room.title;
  } catch {
    return undefined;
  }
}

// ---- DM project selector flow -----------------------------------------------

async function handleDmProjectSelector(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  msg: WebexInboundMessage;
  botPersonId: string;
  token: string;
  mediaResults: WebexMediaResult[];
}): Promise<boolean> {
  const { cfg, accountId, runtime, msg, botPersonId, token, mediaResults } = params;
  const userEmail = msg.personEmail;

  // If user is currently in the middle of a selection, resolve their reply
  if (hasPendingRoomSelection(userEmail)) {
    const selection = resolvePendingRoomSelection(userEmail, msg.text ?? "");
    if (selection === "invalid") {
      await sendMessageWebex({
        cfg,
        accountId,
        to: msg.roomId,
        markdown: "Please reply with just the number of the project you'd like to reference.",
      });
      return true;
    }
    if (selection) {
      // Route message with the chosen project's context injected
      const { note, filesDir, manifest } = await getRoomProjectContext(selection.roomId);
      const fileCount = Object.keys(manifest.files).length;
      await runAgentTurnWithContext({
        cfg,
        accountId,
        runtime,
        msg,
        botPersonId,
        roomContextNote: note,
        roomFilesDir: filesDir,
        roomTitle: selection.roomTitle,
        fileCount,
        mediaResults,
      });
      return true;
    }
    // selection === null means no pending state (expired) — fall through to fresh lookup
  }

  // Look up shared rooms with a workspace
  const sharedRooms = await findSharedRoomsWithWorkspace({
    token,
    botPersonId,
    userEmail,
  }).catch((err: unknown) => {
    runtime.error(`webex: membership lookup failed: ${String(err)}`);
    return [];
  });

  if (sharedRooms.length === 0) {
    // No project workspaces found — route as plain DM with no project context
    return false;
  }

  if (sharedRooms.length === 1) {
    // Only one shared project — use it automatically
    const room = sharedRooms[0]!;
    const { note, filesDir, manifest } = await getRoomProjectContext(room.roomId);
    const fileCount = Object.keys(manifest.files).length;
    await runAgentTurnWithContext({
      cfg,
      accountId,
      runtime,
      msg,
      botPersonId,
      roomContextNote: note,
      roomFilesDir: filesDir,
      roomTitle: room.roomTitle,
      fileCount,
      mediaResults,
    });
    return true;
  }

  // Multiple shared projects — ask user to choose
  storePendingRoomSelection(userEmail, sharedRooms);
  const list = sharedRooms.map((r, i) => `${i + 1}. ${r.roomTitle}`).join("\n");
  await sendMessageWebex({
    cfg,
    accountId,
    to: msg.roomId,
    markdown: `I can see you're in multiple projects I'm also part of. Which should I reference?\n\n${list}\n\nReply with the number.`,
  });
  return true;
}

// ---- Agent turn with injected project context --------------------------------

async function runAgentTurnWithContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
  runtime: RuntimeEnv;
  msg: WebexInboundMessage;
  botPersonId: string;
  roomContextNote: string | null;
  roomFilesDir: string;
  roomTitle: string;
  fileCount: number;
  mediaResults: WebexMediaResult[];
}): Promise<void> {
  const {
    cfg,
    accountId,
    runtime,
    msg,
    botPersonId,
    roomContextNote,
    roomFilesDir,
    roomTitle,
    fileCount,
    mediaResults,
  } = params;

  const route = resolveWebexConversationRoute({
    cfg,
    accountId,
    roomId: msg.roomId,
    isGroup: false,
    senderId: msg.personEmail,
    senderPersonId: msg.personId,
    mentionedPeople: msg.mentionedPeople,
    botPersonId,
  });
  if (!route) return;

  // Prepend project context to the user's message
  const contextPreamble = roomContextNote
    ? `${roomContextNote}\n[Project files directory: ${roomFilesDir}]\n\n`
    : `[Project: ${roomTitle} — ${fileCount} file(s) in ${roomFilesDir}]\n\n`;

  const bodyForAgent = `${contextPreamble}${msg.text ?? ""}`;

  const firstMedia = mediaResults[0];
  const ctxPayload = finalizeInboundContext({
    From: msg.personEmail,
    Body: msg.text,
    BodyForAgent: bodyForAgent,
    CommandBody: msg.text,
    MessageSid: msg.id,
    AccountId: accountId,
    ChatType: "direct",
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
      ingest: () => ({ id: msg.id, rawText: msg.text }),
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

// ---- Main message processor --------------------------------------------------

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

  // Download any attached files
  let mediaResults: WebexMediaResult[] = [];
  runtime.log(
    `webex: processing message from ${msg.personEmail} roomType=${msg.roomType} files=${msg.files?.length ?? 0}`,
  );
  if (msg.files && msg.files.length > 0 && token) {
    mediaResults = await resolveWebexInboundMedia(msg.files, token, runtime).catch(
      (err: unknown) => {
        runtime.error(`webex: inbound media download error: ${String(err)}`);
        return [];
      },
    );
    runtime.log(
      `webex: downloaded ${mediaResults.length}/${msg.files.length} files: ${mediaResults.map((m) => `${m.originalFilename ?? "?"} (${m.contentType ?? "?"}) -> ${m.path}`).join(", ")}`,
    );
  }

  // For group rooms: persist files to the room workspace (latest-wins per filename)
  if (msg.roomType === "group" && mediaResults.length > 0 && token) {
    const roomTitle = await fetchRoomTitle(msg.roomId, token);
    for (const media of mediaResults) {
      if (!media.buffer || !media.contentType) continue;
      await saveRoomFile({
        roomId: msg.roomId,
        roomTitle,
        buffer: media.buffer,
        contentType: media.contentType,
        originalFilename: media.originalFilename,
        senderEmail: msg.personEmail,
      }).catch((err: unknown) => {
        runtime.error(`webex: room file save failed: ${String(err)}`);
      });
    }
  }

  // For DM messages: run the project selector flow
  if (msg.roomType === "direct" && token) {
    runtime.log(
      `webex: DM message, mediaResults=${mediaResults.length}, hasPending=${hasPendingRoomSelection(msg.personEmail)}`,
    );
    // Clear any stale pending selection if user sends a file in a DM
    if (mediaResults.length > 0) {
      clearPendingRoomSelection(msg.personEmail);
    }
    const handled = await handleDmProjectSelector({
      cfg,
      accountId,
      runtime,
      msg,
      botPersonId,
      token,
      mediaResults,
    }).catch((err: unknown) => {
      runtime.error(`webex: DM project selector failed: ${String(err)}`);
      return false;
    });
    if (handled) return;
  }

  // Standard turn: inject room workspace context note for group rooms
  let bodyForAgent = msg.text ?? "";
  if (msg.roomType === "group") {
    const contextNote = await buildRoomContextNote(msg.roomId).catch(() => null);
    if (contextNote) {
      bodyForAgent = `${contextNote}\n\n${bodyForAgent}`;
    }
  }

  const firstMedia = mediaResults[0];
  const ctxPayload = finalizeInboundContext({
    From: msg.personEmail,
    Body: msg.text,
    BodyForAgent: bodyForAgent,
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
