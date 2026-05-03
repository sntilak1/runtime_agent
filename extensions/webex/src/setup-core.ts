import {
  createPatchedAccountSetupAdapter,
  createSetupInputPresenceValidator,
} from "openclaw/plugin-sdk/setup-runtime";

const channel = "webex" as const;

export const webexSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: createSetupInputPresenceValidator({
    defaultAccountOnlyEnvError:
      "WEBEX_BOT_TOKEN env var can only be used for the default account.",
    whenNotUseEnv: [
      {
        someOf: ["botToken"],
        message: "Webex requires --bot-token.",
      },
    ],
  }),
  buildPatch: (input) => {
    if (input.useEnv) return {};
    const botToken = input.botToken?.trim();
    return botToken ? { botToken } : {};
  },
});
