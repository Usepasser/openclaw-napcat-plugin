import type { IncomingMessage, ServerResponse } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getNapCatConfig } from "./runtime.js";
import { handleNapCatMessageEvent } from "./webhook.js";

function extractNapCatEvents(body: any): any[] {
    if (!body || typeof body !== "object") return [];
    if (Array.isArray(body)) return body.filter((item) => item && typeof item === "object");
    if (body.post_type) return [body];
    if (Array.isArray(body.events)) return body.events.filter((item: any) => item && typeof item === "object");
    if (Array.isArray(body.data)) return body.data.filter((item: any) => item && typeof item === "object");
    if (body.data && typeof body.data === "object") return [body.data];
    if (body.payload && typeof body.payload === "object") return [body.payload];
    return [];
}

async function logInboundMessage(event: any, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    const baseDir = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const senderId = String(event.user_id || event.group_id || "unknown");
    const filePath = resolve(baseDir, `qq-${senderId}.log`);
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        time: event.time,
        self_id: event.self_id,
        post_type: event.post_type,
        message_type: event.message_type,
        sub_type: event.sub_type,
        message_id: event.message_id,
        user_id: event.user_id,
        group_id: event.group_id,
        message: event.message,
        raw_message: event.raw_message || "",
        sender: event.sender || {},
    }) + "\n";

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

async function logInboundParseFailure(rawBody: string, config: any): Promise<void> {
    if (config.enableInboundLogging === false) return;
    const baseDirRaw = String(config.inboundLogDir || "./logs/napcat-inbound").trim() || "./logs/napcat-inbound";
    const filePath = resolve(baseDirRaw, "parse-error.log");
    const line = JSON.stringify({
        ts: new Date().toISOString(),
        kind: "parse_error",
        raw_body: rawBody,
    }) + "\n";
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line, "utf8");
}

function readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks);
                if (body.length === 0) {
                    resolve({});
                    return;
                }
                const contentType = req.headers["content-type"] || "";
                if (contentType.includes("application/json")) {
                    resolve(JSON.parse(body.toString("utf8")));
                } else if (contentType.includes("application/x-www-form-urlencoded")) {
                    const params = new URLSearchParams(body.toString("utf8"));
                    const obj: Record<string, any> = {};
                    for (const [k, v] of params.entries()) {
                        try {
                            obj[k] = JSON.parse(v);
                        } catch {
                            obj[k] = v;
                        }
                    }
                    resolve(obj);
                } else {
                    resolve(JSON.parse(body.toString("utf8")));
                }
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

// Media proxy: fetch media from NapCat and stream to client (avoids CORS issues)
async function handleMediaProxyRequest(res: ServerResponse, url: string): Promise<void> {
    const config = getNapCatConfig();
    const napcatBase = String(config.url || "http://127.0.0.1:3000").replace(/\/$/, "");

    // Extract the file path from the proxy URL
    // Expected format: /napcat/media?file=<filepath>
    let filePath = "";
    try {
        const u = new URL(url, "http://localhost");
        filePath = u.searchParams.get("file") || "";
    } catch {
        res.statusCode = 400;
        res.end("Invalid URL");
        return;
    }

    if (!filePath) {
        res.statusCode = 400;
        res.end("Missing file parameter");
        return;
    }

    // Construct the source URL on NapCat
    const sourceUrl = `${napcatBase}/forward?file=${encodeURIComponent(filePath)}`;
    const token = String(config.token || "").trim();

    try {
        console.log(`[NapCat] Media proxy fetching: ${sourceUrl}`);

        const headers: Record<string, string> = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const response = await fetch(sourceUrl, { headers });

        if (!response.ok) {
            console.error(`[NapCat] Media proxy failed: ${response.status} ${response.statusText}`);
            res.statusCode = 502;
            res.end("Upstream error");
            return;
        }

        const contentType = response.headers.get("content-type") || "application/octet-stream";
        const contentLength = response.headers.get("content-length");

        res.statusCode = 200;
        res.setHeader("Content-Type", contentType);
        if (contentLength) res.setHeader("Content-Length", contentLength);
        res.setHeader("Cache-Control", "public, max-age=86400");

        if (response.body) {
            for await (const chunk of response.body) {
                res.write(chunk);
            }
        }

        res.end();
    } catch (err) {
        console.error("[NapCat] Media proxy error:", err);
        res.statusCode = 500;
        res.end("Proxy error");
    }
}

// HTTP webhook handler for NapCat events
export async function handleNapCatWebhook(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const config = getNapCatConfig();

    // WS mode: NapCat sends events via WebSocket, ignore HTTP callbacks
    if (config.connectionMethod === "websocket") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"ok"}');
        return true;
    }

    const url = req.url || "";
    const method = req.method || "UNKNOWN";

    console.log(`[NapCat] Incoming request: ${method} ${url}`);

    // Accept /napcat, /napcat/, or any path starting with /napcat
    if (!url.startsWith("/napcat")) return false;

    if (method === "GET") {
        return handleMediaProxyRequest(res, url);
    }

    if (method !== "POST") {
        // For non-POST requests to /napcat endpoints, return 405
        res.statusCode = 405;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"error","message":"Method Not Allowed"}');
        return true;
    }

    try {
        const body = await readBody(req);
        const events = extractNapCatEvents(body);

        try {
            if (body?.__parseError && typeof body.__raw === "string" && body.__raw.trim()) {
                await logInboundParseFailure(body.__raw, config);
            }
            for (const event of events) {
                await logInboundMessage(event, config);
            }
        } catch (err) {
            console.error("[NapCat] Failed to write inbound log:", err);
        }

        const event = events[0] || body;

        // Heartbeat / Lifecycle
        if (event.post_type === "meta_event") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        if (event.post_type === "message") {
            // Delegate to shared message handler
            await handleNapCatMessageEvent(event, config);
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"status":"ok"}');
            return true;
        }

        // Default OK for handled path
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end('{"status":"ok"}');
        return true;
    } catch (err) {
        console.error("NapCat Webhook Error:", err);
        res.statusCode = 500;
        res.end("error");
        return true;
    }
}

export { readBody, extractNapCatEvents };
