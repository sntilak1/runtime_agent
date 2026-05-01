import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

export type WebexTokenSource = "env" | "config" | "account" | "none";

export type ResolvedWebexToken = {
  token: string;
  source: WebexTokenSource;
};

export function resolveWebexToken(
  cfg: OpenClawConfig,
  opts: { accountId?: string | null } = {},
): ResolvedWebexToken {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;

  // Per-account token in accounts.<id>.botToken
  const accountCfg =
    accountId !== DEFAULT_ACCOUNT_ID
      ? ((cfg.channels as Record<string, unknown> | undefined)?.webex as
          | Record<string, unknown>
          | undefined)
      : undefined;
  const accountMap = (accountCfg as { accounts?: Record<string, { botToken?: string }> })?.accounts;
  const perAccountToken =
    accountId !== DEFAULT_ACCOUNT_ID ? accountMap?.[accountId]?.botToken : undefined;
  if (perAccountToken) {
    return { token: perAccountToken, source: "account" };
  }

  // Top-level channels.webex.botToken
  const topToken = (cfg.channels as Record<string, unknown> | undefined)?.webex as
    | { botToken?: string }
    | undefined;
  if (topToken?.botToken) {
    return { token: topToken.botToken, source: "config" };
  }

  // Environment variable
  const envToken = process.env.WEBEX_BOT_TOKEN;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  return { token: "", source: "none" };
}
