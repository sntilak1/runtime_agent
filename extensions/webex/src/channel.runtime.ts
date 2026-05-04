import { monitorWebexProvider as monitorWebexProviderImpl } from "./monitor.js";
import { probeWebex as probeWebexImpl } from "./probe.js";
import {
  sendMediaWebex as sendMediaWebexImpl,
  sendMessageWebex as sendMessageWebexImpl,
} from "./send.js";

export const webexChannelRuntime = {
  probeWebex: probeWebexImpl,
  sendMessageWebex: sendMessageWebexImpl,
  sendMediaWebex: sendMediaWebexImpl,
  monitorWebexProvider: monitorWebexProviderImpl,
};
