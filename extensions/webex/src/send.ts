import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { resolveWebexToken } from "./token.js";

export type SendWebexResult = {
  messageId: string;
  roomId: string;
};

export type SendWebexParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text?: string;
  markdown?: string;
};

export type SendWebexMediaParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

// Webex supports up to 100 MB per file; use a conservative 50 MB limit.
const WEBEX_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

// MIME types accepted for Webex file attachments.
export const WEBEX_ALLOWED_MIME_PREFIXES = [
  // Images
  "image/",
  // PDF
  "application/pdf",
  // Office documents (Word, Excel, PowerPoint — both legacy and OOXML)
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.oasis.opendocument.",
];

export function isWebexAllowedMime(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const normalized = contentType.split(";")[0].trim().toLowerCase();
  return WEBEX_ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export async function sendMessageWebex(params: SendWebexParams): Promise<SendWebexResult> {
  const { token } = resolveWebexToken(params.cfg, { accountId: params.accountId });
  if (!token) {
    throw new Error("webex: no bot token configured");
  }

  const body: Record<string, unknown> = { roomId: params.to };
  if (params.markdown) {
    body.markdown = params.markdown;
  } else if (params.text) {
    body.text = params.text;
  }

  const res = await fetch("https://webexapis.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`webex send failed: HTTP ${res.status} ${errorText}`);
  }

  const data = (await res.json()) as { id: string; roomId: string };
  return { messageId: data.id, roomId: data.roomId };
}

export async function sendMediaWebex(params: SendWebexMediaParams): Promise<SendWebexResult> {
  const { token } = resolveWebexToken(params.cfg, { accountId: params.accountId });
  if (!token) {
    throw new Error("webex: no bot token configured");
  }

  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: WEBEX_MEDIA_MAX_BYTES,
    mediaAccess: params.mediaAccess,
    mediaLocalRoots: params.mediaLocalRoots,
    mediaReadFile: params.mediaReadFile,
  });

  const mimeType = media.contentType ?? "application/octet-stream";

  if (!isWebexAllowedMime(mimeType)) {
    throw new Error(
      `webex: unsupported file type "${mimeType}" — only images, PDFs, and Office documents are supported`,
    );
  }

  const filename = media.fileName ?? "attachment";

  const form = new FormData();
  form.append("roomId", params.to);
  if (params.text) {
    form.append("text", params.text);
  }
  form.append("files", new Blob([new Uint8Array(media.buffer)], { type: mimeType }), filename);

  const res = await fetch("https://webexapis.com/v1/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(`webex send media failed: HTTP ${res.status} ${errorText}`);
  }

  const data = (await res.json()) as { id: string; roomId: string };
  return { messageId: data.id, roomId: data.roomId };
}
