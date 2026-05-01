import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/channel-contract";
import { probeWebex } from "./probe.js";
import { resolveWebexToken } from "./token.js";

export const webexSetupAdapter: ChannelSetupAdapter = {
  async isConfigured({ cfg }) {
    const { token } = resolveWebexToken(cfg);
    return Boolean(token);
  },
  async validate({ cfg }) {
    const { token } = resolveWebexToken(cfg);
    if (!token) {
      return {
        ok: false,
        error: "No bot token found. Set channels.webex.botToken or WEBEX_BOT_TOKEN.",
      };
    }
    const probe = await probeWebex(token);
    if (!probe.ok) {
      return { ok: false, error: probe.error ?? "Token validation failed." };
    }
    return { ok: true };
  },
};
