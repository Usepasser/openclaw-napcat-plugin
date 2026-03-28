import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
// import { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import { napcatPlugin } from "./src/channel.js";
import { handleNapCatWebhook } from "./src/webhook.js";
import { setNapCatRuntime, setNapCatConfig } from "./src/runtime.js";

let registered = false;

const plugin = {
	id: "napcat",
	name: "NapCatQQ",
	description: "QQ channel via NapCat (OneBot 11)",
	configSchema: napcatPlugin.configSchema,
	setRuntime: setNapCatRuntime,
	registerFull(api: any) {
		registered = true;
		const config = api.config.channels?.napcat || {};
		setNapCatConfig(config);
		// setNapCatRuntime(api.runtime);
		api.registerChannel({ plugin: napcatPlugin as any });

		// Only register HTTP handler when using HTTP mode (WebSocket mode uses bidirectional connection)
		const connectionMethod = config.connectionMethod || "http";
		if (connectionMethod === "http") {
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
		}
	},
};

export default defineChannelPluginEntry(plugin);

