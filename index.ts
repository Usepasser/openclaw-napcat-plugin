import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
// import { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { napcatPlugin } from "./src/channel.js";
import { handleNapCatWebhook } from "./src/webhook.js";
import { setNapCatRuntime } from "./src/runtime.js";

const plugin = {
  id: "napcat",
  name: "NapCatQQ",
  description: "QQ channel via NapCat (OneBot 11)",
//   configSchema: OpenClawPluginConfigSchema(),
  setRuntime: setNapCatRuntime,
  registerFull(api: any) {
    // setNapCatRuntime(api.runtime);
    api.registerChannel({ plugin: napcatPlugin as any });

    // Compatibility: old SDKs expose registerHttpHandler, newer SDKs prefer registerHttpRoute.
    const anyApi = api as any;
    if (typeof anyApi.registerHttpRoute === "function") {
      anyApi.registerHttpRoute({
        path: "/napcat",
        handler: handleNapCatWebhook,
        auth: "plugin",
      });
    } else if (typeof anyApi.registerHttpHandler === "function") {
      anyApi.registerHttpHandler(handleNapCatWebhook);
    } else {
      throw new Error("NapCat plugin: no HTTP registration API found (registerHttpRoute/registerHttpHandler)");
    }
  },
};

export default defineChannelPluginEntry(plugin);

