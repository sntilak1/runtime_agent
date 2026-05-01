import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-contract";

export const webexSetupWizard: ChannelSetupWizard = {
  steps: [
    {
      id: "botToken",
      label: "Webex Bot Token",
      description:
        "Create a bot at https://developer.webex.com/my-apps — copy the bot access token and paste it here.",
      field: {
        key: "channels.webex.botToken",
        type: "secret",
        placeholder: "paste bot token here",
        label: "Bot Access Token",
      },
    },
  ],
};
