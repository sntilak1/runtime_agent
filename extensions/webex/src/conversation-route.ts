import {
  buildChannelOutboundSessionRoute,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAgentRoute, type ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";

export type WebexConversationRouteParams = {
  cfg: OpenClawConfig;
  accountId: string;
  roomId: string;
  isGroup: boolean;
  senderId?: string;
  senderPersonId?: string;
  mentionedPeople?: string[];
  botPersonId?: string;
};

/**
 * Resolves an inbound Webex message to an agent route.
 *
 * Returns null when the message should be silently dropped (group policy gate,
 * empty room id, etc.). The returned route carries both agentId and sessionKey,
 * which the turn runner needs.
 *
 * The room_id is always the peer id for both 1:1 direct messages and group
 * spaces, giving full per-room conversation isolation automatically.
 */
export function resolveWebexConversationRoute(
  params: WebexConversationRouteParams,
): ResolvedAgentRoute | null {
  const { cfg, accountId, roomId, isGroup } = params;

  if (!roomId) return null;

  // Group policy gate — drop if mention required but bot not @mentioned.
  const webexCfg = (cfg.channels as Record<string, unknown> | undefined)?.webex as
    | { groupPolicy?: string; accounts?: Record<string, { groupPolicy?: string }> }
    | undefined;
  const accountCfg = accountId !== "default" ? webexCfg?.accounts?.[accountId] : undefined;
  const groupPolicy = accountCfg?.groupPolicy ?? webexCfg?.groupPolicy ?? "mention";

  if (isGroup && groupPolicy === "mention") {
    const { mentionedPeople, botPersonId } = params;
    if (botPersonId && !mentionedPeople?.includes(botPersonId)) {
      return null;
    }
  }

  return resolveAgentRoute({
    cfg,
    channel: "webex",
    accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: roomId,
    },
  });
}

/** Resolves outbound session route from a `to` target string (used by the outbound adapter). */
export function resolveWebexOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
): ReturnType<typeof buildChannelOutboundSessionRoute> | null {
  const target = params.target?.trim();
  if (!target) return null;

  const roomId = target
    .replace(/^webex:/i, "")
    .replace(/^(group|direct):/i, "")
    .trim();
  if (!roomId) return null;

  const isGroup = !target.toLowerCase().startsWith("webex:direct:");

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId ?? "default",
    channel: "webex",
    accountId: params.accountId,
    peer: {
      kind: isGroup ? "group" : "direct",
      id: roomId,
    },
    chatType: isGroup ? "group" : "direct",
    from: isGroup ? `webex:group:${roomId}` : `webex:${roomId}`,
    to: roomId,
  });
}
