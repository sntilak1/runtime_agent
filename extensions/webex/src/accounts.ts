import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { WebexAccountConfig } from "./config-types.js";
import { resolveWebexToken } from "./token.js";

export type ResolvedWebexAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "account" | "none";
  config: WebexAccountConfig;
};

function getWebexChannelConfig(cfg: OpenClawConfig): WebexAccountConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.webex as
    | WebexAccountConfig
    | undefined;
}

function getWebexAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): WebexAccountConfig | undefined {
  const channel = getWebexChannelConfig(cfg);
  if (!channel) return undefined;
  if (accountId === DEFAULT_ACCOUNT_ID) return channel;
  return (channel.accounts as Record<string, WebexAccountConfig> | undefined)?.[accountId];
}

export function listWebexAccountIds(cfg: OpenClawConfig): string[] {
  const channel = getWebexChannelConfig(cfg);
  if (!channel) return [];
  const named = Object.keys(channel.accounts ?? {});
  return named.length > 0 ? named : [DEFAULT_ACCOUNT_ID];
}

export function resolveWebexAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedWebexAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const channel = getWebexChannelConfig(params.cfg);
  const accountCfg = getWebexAccountConfig(params.cfg, accountId) ?? {};
  const baseEnabled = channel?.enabled !== false;
  const accountEnabled = accountCfg.enabled !== false;
  const tokenResolution = resolveWebexToken(params.cfg, { accountId });
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    token: tokenResolution.token,
    tokenSource: tokenResolution.source,
    config: accountCfg,
  };
}

export function listEnabledWebexAccounts(cfg: OpenClawConfig): ResolvedWebexAccount[] {
  return listWebexAccountIds(cfg)
    .map((accountId) => resolveWebexAccount({ cfg, accountId }))
    .filter((a) => a.enabled);
}
