import { webexSetupAdapter } from "./setup-core.js";
import { webexSetupWizard } from "./setup-surface.js";

export const webexSetupPlugin = {
  setup: webexSetupAdapter,
  setupWizard: webexSetupWizard,
};
