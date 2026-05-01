import { Type, type TSchema } from "typebox";

export function buildChannelConfigSchema<S extends TSchema>(
  schema: S,
  opts?: { uiHints?: Record<string, unknown> },
) {
  return { schema, uiHints: opts?.uiHints ?? {} };
}

export const WebexConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the Webex plugin." })),
    botToken: Type.Optional(
      Type.String({ description: "Webex bot access token from developer.webex.com." }),
    ),
    allowFrom: Type.Optional(
      Type.Array(Type.String(), {
        description: "Room IDs or user emails/IDs allowed to interact with this bot.",
      }),
    ),
    groupPolicy: Type.Optional(
      Type.Union([Type.Literal("open"), Type.Literal("allowlist"), Type.Literal("mention")], {
        description:
          'How to gate group messages. "mention" requires @bot in group rooms; "allowlist" restricts by allowFrom; "open" allows any member.',
      }),
    ),
    defaultTo: Type.Optional(
      Type.String({ description: "Default outbound room_id when no target is specified." }),
    ),
    accounts: Type.Optional(
      Type.Record(
        Type.String(),
        Type.Object({
          enabled: Type.Optional(Type.Boolean()),
          botToken: Type.Optional(Type.String()),
          allowFrom: Type.Optional(Type.Array(Type.String())),
          groupPolicy: Type.Optional(
            Type.Union([Type.Literal("open"), Type.Literal("allowlist"), Type.Literal("mention")]),
          ),
          defaultTo: Type.Optional(Type.String()),
        }),
        { description: "Named Webex bot accounts (for multi-bot setups)." },
      ),
    ),
  },
  { additionalProperties: false },
);

export const WebexChannelConfigSchema = buildChannelConfigSchema(WebexConfigSchema);
