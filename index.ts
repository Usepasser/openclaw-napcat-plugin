import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { napcatPlugin } from "./src/channel.js";
import { handleNapCatWebhook } from "./src/webhook.js";
import { setNapCatRuntime, setNapCatConfig } from "./src/runtime.js";

let registered = false;

const plugin = {
	id: "napcat",
	name: "NapCatQQ",
	description: "QQ channel via NapCat (OneBot 11)",
	configSchema: napcatPlugin.configSchema,
	register(api: OpenClawPluginApi) {
		registered = true;
		setNapCatRuntime(api.runtime);
		const config = api.config.channels?.napcat || {};
		console.log(config)
		setNapCatConfig(config);
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

export default plugin;