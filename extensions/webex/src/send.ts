import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
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
  /** Local file path or URL for attachment. */
  mediaUrl?: string;
};

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
