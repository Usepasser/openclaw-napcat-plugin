import { buildNapCatMediaCq } from "./media.js";
import { getNapCatRuntime } from "./runtime.js";
import { NapCatApiClient } from "./api-client.js";
import { sendToNapCat } from "./api-client.js";
import { handleNapCatWebhook } from "./http-handler.js";

// Re-export HTTP handler for backward compatibility
export { handleNapCatWebhook };

// Module-level API client for sending replies
let apiClient: NapCatApiClient | null = null;

export function setNapCatApiClient(client: NapCatApiClient | null) {
    apiClient = client;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNapCatStreamingModeEnabled(config: any): boolean {
    return config?.streaming_mode === true;
}

// Send message via WebSocket connection
export async function sendToNapCatWS(ws: any, payload: any, action: string, token?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const obPayload = {
            action: action.replace("/", ""),
            params: payload,
        };
        const data = JSON.stringify(obPayload);
        if (ws.readyState !== ws.OPEN) {
            reject(new Error("WebSocket not open"));
            return;
        }
        ws.send(data, (err: any) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

// Handle incoming NapCat events via WebSocket
// This processes events received on the WebSocket connection
export async function handleNapCatWebsocket(event: any, config: any): Promise<void> {
    // Process the event - same logic as handleNapCatWebhook for message events
    if (!event || typeof event !== "object") return;

    // Handle lifecycle/meta events
    if (event.post_type === "meta_event") {
        console.log(`[NapCat] WS meta_event: ${event.meta_event_type || "unknown"}`);
        return;
    }

    // Handle messages (the main case)
    if (event.post_type === "message") {
        await handleNapCatMessageEvent(event, config);
        return;
    }

    // Log other event types for debugging
    console.log(`[NapCat] WS unhandled event type: ${event.post_type || "unknown"}`);
}

// Build inbound message text from event
async function buildInboundMessageText(event: any, config: any): Promise<string> {
    const text = event.message || "";
    if (event.raw_message) return event.raw_message;

    // For CQ code images, replace with file path if available
    const normalizedText = text
        .replace(/\[CQ:image,file=(.+?)(?:,url=([^,\]]+))?\]/gi, (_match, file, _url) => {
            if (file?.startsWith("file://")) {
                return file;
            }
            return "";
        })
        .replace(/\[CQ:record,file=(.+?)(?:,url=([^,\]]+))?\]/gi, (_match, file, _url) => {
            if (file?.startsWith("file://")) {
                return `[${file}]`;
            }
            return "";
        })
        .trim();

    return normalizedText;
}

// Build outbound message from reply payload for NapCat
async function buildNapCatMessageFromReply(payload: any, config: any): Promise<string | null> {
    if (!payload) return null;

    const parts: string[] = [];

    if (payload.text) {
        parts.push(payload.text);
    }

    if (payload.attachments && Array.isArray(payload.attachments)) {
        for (const attachment of payload.attachments) {
            if (attachment["content-type"]?.startsWith("image/") || attachment.type === "image") {
                const file = attachment.file_url || attachment.url || attachment.path || attachment.name;
                if (file) {
                    if (file.startsWith("file://") || file.startsWith("http")) {
                        const cqCode = `[CQ:image,file=${file}]`;
                        parts.push(cqCode);
                    }
                }
            } else if (attachment["content-type"]?.startsWith("audio/") || attachment.type === "audio") {
                const file = attachment.file_url || attachment.url || attachment.path || attachment.name;
                if (file) {
                    if (file.startsWith("file://") || file.startsWith("http")) {
                        const cqCode = `[CQ:record,file=${file}]`;
                        parts.push(cqCode);
                    }
                }
            }
        }
    }

    return parts.join("\n") || null;
}

// Process a NapCat message event (shared by HTTP webhook and WS)
async function handleNapCatMessageEvent(event: any, config: any): Promise<void> {
    const runtime = getNapCatRuntime();
    const isGroup = event.message_type === "group";
    const groupId = isGroup ? String(event.group_id || "") : "";
    const senderId = String(event.user_id);
    const rawText = event.raw_message || "";
    let text = await buildInboundMessageText(event, config);

    // Get allowUsers from config
    const allowUsers = config.allowUsers || [];
    const isAllowUser = allowUsers.includes(senderId);

    if (allowUsers.length > 0 && !isAllowUser) {
        console.log(`[NapCat] Ignoring message from ${senderId} (not in allowlist)`);
        return;
    }

    // Group message handling
    const enableGroupMessages = config.enableGroupMessages || false;
    const groupMentionOnly = config.groupMentionOnly !== false;
    const groupWhitelist = Array.isArray(config.groupWhitelist)
        ? config.groupWhitelist.map((id: any) => String(id).trim()).filter(Boolean)
        : [];
    let wasMentioned = !isGroup;

    if (isGroup) {
        if (!enableGroupMessages) {
            console.log(`[NapCat] Ignoring group message (group messages disabled)`);
            return;
        }

        if (groupWhitelist.length > 0 && !groupWhitelist.includes(groupId)) {
            console.log(`[NapCat] Ignoring group message from ${groupId} (not in group whitelist)`);
            return;
        }

        const botId = event.self_id || config.selfId;
        if (groupMentionOnly && botId) {
            const mentionPatternCQ = new RegExp(`\\[CQ:at,qq=${botId}\\]`, 'i');
            const allMentionPatternCQ = /\[CQ:at,qq=all\]/i;
            const mentionPatternPlain1 = new RegExp(`@[^\\s]+ \\(${botId}\\)`, 'i');
            const mentionPatternPlain2 = new RegExp(`@${botId}(?:\\s|$|,)`, 'i');

            const mentionSource = rawText || text;
            const isMentionedCQ = mentionPatternCQ.test(mentionSource) || allMentionPatternCQ.test(mentionSource);
            const isMentionedPlain = mentionPatternPlain1.test(text) || mentionPatternPlain2.test(text);

            if (!isMentionedCQ && !isMentionedPlain) {
                console.log(`[NapCat] Ignoring group message (bot not mentioned)`);
                return;
            }
            wasMentioned = true;
        } else if (groupMentionOnly) {
            return;
        }

        // Strip mentions from text
        if (botId) {
            const stripCQ = new RegExp(`^\\[CQ:at,qq=${botId}\\]\\s*`, 'i');
            const stripAll = /^\[CQ:at,qq=all\]\s*/i;
            const stripAllPlain = /^@全体成员\s*/i;
            const stripPlain1 = new RegExp(`^@[^\\s]+ \\(${botId}\\)\\s*`, 'i');
            const stripPlain2 = new RegExp(`^@${botId}(?:\\s|$|,)\\s*`, 'i');
            text = text
                .replace(stripCQ, '')
                .replace(stripAll, '')
                .replace(stripAllPlain, '')
                .replace(stripPlain1, '')
                .replace(stripPlain2, '')
                .trim();
        }
    }

    const messageId = String(event.message_id);
    const conversationId = isGroup ? `group:${event.group_id}` : `private:${senderId}`;
    const senderName = event.sender?.nickname || senderId;

    const baseSessionKey = isGroup
        ? `session:napcat:group:${event.group_id}`
        : `session:napcat:private:${senderId}`;
    const cfg = runtime.config?.loadConfig?.() || {};
    const peer = isGroup
        ? { kind: "group", id: String(event.group_id) }
        : { kind: "direct", id: senderId };

    const route = await runtime.channel.routing.resolveAgentRoute({
        channel: "napcat",
        conversationId,
        senderId,
        text,
        cfg,
        ctx: {},
        peer,
    });

    if (!route?.agentId) {
        console.log("[NapCat] No route found for message, ignoring");
        return;
    }

    const configuredAgentId = String(config.agentId || "").trim().toLowerCase();
    const routeAgentId = String(route.agentId || "").trim().toLowerCase();
    const effectiveAgentId = routeAgentId || configuredAgentId || "main";
    const sessionKey = `agent:${effectiveAgentId}:${baseSessionKey}`;

    route.agentId = effectiveAgentId;
    route.sessionKey = sessionKey;

    const ctxPayload = {
        Body: text,
        RawBody: rawText,
        CommandBody: text,
        From: `napcat:${conversationId}`,
        To: "me",
        SessionKey: sessionKey,
        SessionDisplayName: sessionKey,
        displayName: sessionKey,
        name: sessionKey,
        Title: sessionKey,
        ConversationTitle: sessionKey,
        Topic: sessionKey,
        Subject: sessionKey,
        AccountId: route.accountId,
        ChatType: isGroup ? "group" : "direct",
        ConversationLabel: sessionKey,
        SenderName: senderName,
        SenderId: senderId,
        Provider: "napcat",
        Surface: "napcat",
        MessageSid: messageId,
        WasMentioned: wasMentioned,
        CommandAuthorized: true,
        OriginatingChannel: "napcat",
        OriginatingTo: conversationId,
    };

    let dispatcher: any = null;
    let dispatcherReplyOptions: Record<string, unknown> = {};

    const replyTarget = conversationId;

    // Import getNapCatWs for use in deliver callback
    const { getNapCatWs } = await import("./runtime.js");

    if (runtime.channel.reply.createReplyDispatcherWithTyping) {
        const result = await runtime.channel.reply.createReplyDispatcherWithTyping({
            responsePrefix: "",
            responsePrefixContextProvider: () => ({}),
            humanDelay: 0,
            deliver: async (payload: any) => {
                const isGroupTarget = replyTarget.startsWith("group:");
                const targetId = isGroupTarget ? replyTarget.replace("group:", "") : replyTarget.replace("private:", "");
                const endpoint = isGroupTarget ? "/send_group_msg" : "/send_private_msg";
                const message = await buildNapCatMessageFromReply(payload, config);
                if (!message) {
                    console.log("[NapCat] Skip empty reply payload");
                    return;
                }
                const msgPayload: Record<string, string> = { message };
                if (isGroupTarget) msgPayload.group_id = targetId;
                else msgPayload.user_id = targetId;

                try {
                    if (apiClient) {
                        await apiClient.sendMessage(endpoint, msgPayload);
                        console.log("[NapCat] Reply sent via apiClient");
                    } else {
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const token = String(config.token || "").trim();
                        const ws = getNapCatWs();
                        if (ws && ws.readyState === ws.OPEN) {
                            await sendToNapCatWS(ws, msgPayload, endpoint, token);
                            console.log("[NapCat] WS reply sent successfully");
                        } else {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token);
                            console.log("[NapCat] HTTP reply sent successfully");
                        }
                    }
                } catch (err) {
                    console.error("[NapCat] Reply delivery failed:", err);
                }
            },
            onError: (err: any, info: any) => {
                console.error(`[NapCat] Reply error (${info.kind}):`, err);
            },
            onReplyStart: () => { },
            onIdle: () => { },
        });
        dispatcher = result.dispatcher;
        dispatcherReplyOptions = result.replyOptions || {};
    } else if (runtime.channel.reply.createReplyDispatcher) {
        dispatcher = runtime.channel.reply.createReplyDispatcher({
            responsePrefix: "",
            responsePrefixContextProvider: () => ({}),
            humanDelay: 0,
            deliver: async (payload: any) => {
                const isGroupTarget = replyTarget.startsWith("group:");
                const targetId = isGroupTarget ? replyTarget.replace("group:", "") : replyTarget.replace("private:", "");
                const endpoint = isGroupTarget ? "/send_group_msg" : "/send_private_msg";
                const message = await buildNapCatMessageFromReply(payload, config);
                if (!message) {
                    console.log("[NapCat] Skip empty reply payload");
                    return;
                }
                const msgPayload: Record<string, string> = { message };
                if (isGroupTarget) msgPayload.group_id = targetId;
                else msgPayload.user_id = targetId;

                try {
                    if (apiClient) {
                        await apiClient.sendMessage(endpoint, msgPayload);
                    } else {
                        const baseUrl = config.url || "http://127.0.0.1:3000";
                        const token = String(config.token || "").trim();
                        const ws = getNapCatWs();
                        if (ws && ws.readyState === ws.OPEN) {
                            await sendToNapCatWS(ws, msgPayload, endpoint, token);
                        } else {
                            await sendToNapCat(`${baseUrl}${endpoint}`, msgPayload, token);
                        }
                    }
                } catch (err) {
                    console.error("[NapCat] Reply delivery failed:", err);
                }
            },
            onError: (err: any, info: any) => {
                console.error(`[NapCat] Reply error (${info.kind}):`, err);
            },
        });
    }

    if (!dispatcher) {
        console.error("[NapCat] Could not create dispatcher");
        return;
    }

    try {
        await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg,
            dispatcher,
            replyOptions: {
                ...dispatcherReplyOptions,
                disableBlockStreaming: !isNapCatStreamingModeEnabled(config),
            },
        });
    } catch (err) {
        console.error("[NapCat] Dispatch error:", err);
    }
}
