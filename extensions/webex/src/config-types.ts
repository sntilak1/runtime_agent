export type WebexAccountConfig = {
  enabled?: boolean;
  botToken?: string;
  /** Allowlist of room IDs or user emails that may interact with the bot. */
  allowFrom?: Array<string>;
  /** "open" = any room member; "allowlist" = only allowFrom; "mention" = require @mention in groups. */
  groupPolicy?: "open" | "allowlist" | "mention";
  /** Default outbound target room_id when no explicit `to` is given. */
  defaultTo?: string;
};

export type WebexConfig = WebexAccountConfig & {
  accounts?: Record<string, WebexAccountConfig>;
};
