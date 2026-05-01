import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { sendMessageWebex } from "./send.js";

type WebexChannelRuntime = {
  sendMessageWebex?: typeof sendMessageWebex;
};

export type WebexRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    webex?: WebexChannelRuntime;
  };
};

const {
  setRuntime: setWebexRuntime,
  clearRuntime: clearWebexRuntime,
  getRuntime: getWebexRuntime,
} = createPluginRuntimeStore<WebexRuntime>({
  pluginId: "webex",
  errorMessage: "Webex runtime not initialized — plugin not registered",
});

export { clearWebexRuntime, getWebexRuntime, setWebexRuntime };
