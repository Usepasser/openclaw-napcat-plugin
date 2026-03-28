import { WebSocket } from "ws";
import { getNapCatConfig } from "./runtime.js";

// Standalone HTTP sender (fallback when apiClient is not available)
async function postJsonWithNodeHttpStandalone(
    url: string,
    payload: any,
    timeoutMs: number,
    opts?: { connectionClose?: boolean; token?: string }
): Promise<{ statusCode: number; statusText: string; bodyText: string }> {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const body = JSON.stringify(payload);
    const http = require("http");
    const https = require("https");
    const transport = isHttps ? https.request : http.request;
    const connectionClose = opts?.connectionClose === true;
    const normalizedToken = String(opts?.token ?? "").trim();

    return new Promise((resolve, reject) => {
        const headers: Record<string, string | number> = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Connection": connectionClose ? "close" : "keep-alive",
        };
        if (normalizedToken) {
            headers["Authorization"] = `Bearer ${normalizedToken}`;
        }
        const req = transport(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: "POST",
                headers,
            },
            (res: any) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer) => chunks.push(chunk));
                res.on("end", () => {
                    const bodyText = Buffer.concat(chunks).toString("utf8");
                    resolve({ statusCode: res.statusCode || 0, statusText: res.statusMessage || "", bodyText });
                });
            }
        );
        req.setTimeout(timeoutMs, () => {
            req.destroy();
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

function isRetryableNapCatErrorStandalone(err: any): boolean {
    const code = String(err?.cause?.code || err?.code || "");
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"].includes(code);
}

// Standalone sendToNapCat for use when NapCatApiClient is not available
export async function sendToNapCat(url: string, payload: any, token?: string): Promise<any> {
    const cfg = getNapCatConfig();
    const maxAttempts = 3;
    const timeoutsMs = [5000, 7000, 9000];
    const connectionClose = cfg.connectionClose !== false;
    const target = new URL(url);
    const targetInfo = `${target.protocol}//${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}${target.pathname}`;

    let lastErr: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const startedAt = Date.now();
        try {
            const timeoutMs = timeoutsMs[Math.min(attempt - 1, timeoutsMs.length - 1)];
            const res = await postJsonWithNodeHttpStandalone(url, payload, timeoutMs, { connectionClose, token });

            if (res.statusCode < 200 || res.statusCode >= 300) {
                throw new Error(`NapCat API Error: ${res.statusCode} ${res.statusText}${res.bodyText ? ` | ${res.bodyText.slice(0, 300)}` : ""}`);
            }

            const elapsedMs = Date.now() - startedAt;
            console.log(`[NapCat] sendToNapCat success attempt ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms`);

            if (!res.bodyText) return { status: "ok" };
            try {
                return JSON.parse(res.bodyText);
            } catch {
                return { status: "ok", raw: res.bodyText };
            }
        } catch (err: any) {
            lastErr = err;
            const retryable = isRetryableNapCatErrorStandalone(err);
            const backoffMs = Math.min(attempt * attempt * 200, 5000);

            console.log(`[NapCat] sendToNapCat attempt ${attempt}/${maxAttempts} failed (retryable=${retryable}): ${err.message}`);

            if (retryable && attempt < maxAttempts) {
                await new Promise(r => setTimeout(r, backoffMs));
            } else {
                break;
            }
        }
    }
    throw lastErr;
}

// HTTP agents for connection pooling
const napcatHttpAgent = new (require('http').Agent)({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 20,
    maxFreeSockets: 10,
});

const napcatHttpsAgent = new (require('https').Agent)({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 20,
    maxFreeSockets: 10,
});

function isRetryableNapCatError(err: any): boolean {
    const code = String(err?.cause?.code || err?.code || "");
    return ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "ECONNABORTED"].includes(code);
}

async function postJsonWithNodeHttp(
    url: string,
    payload: any,
    timeoutMs: number,
    opts?: { connectionClose?: boolean; token?: string }
): Promise<{ statusCode: number; statusText: string; bodyText: string }> {
    const target = new URL(url);
    const isHttps = target.protocol === "https:";
    const body = JSON.stringify(payload);
    const transport = isHttps ? require('https').request : require('http').request;
    const connectionClose = opts?.connectionClose === true;
    const normalizedToken = String(opts?.token ?? "").trim();
    const agent = connectionClose ? undefined : (isHttps ? napcatHttpsAgent : napcatHttpAgent);

    return new Promise((resolve, reject) => {
        const headers: Record<string, string | number> = {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Connection": connectionClose ? "close" : "keep-alive",
        };
        if (normalizedToken) {
            headers["Authorization"] = `Bearer ${normalizedToken}`;
        }
        const req = transport(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (isHttps ? 443 : 80),
                path: `${target.pathname}${target.search}`,
                method: "POST",
                agent,
                headers,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on("end", () => {
                    const bodyText = Buffer.concat(chunks).toString("utf8");
                    resolve({
                        statusCode: res.statusCode || 0,
                        statusText: res.statusMessage || "",
                        bodyText,
                    });
                });
            }
        );

        req.setTimeout(timeoutMs, () => {
            req.destroy(Object.assign(new Error(`NapCat request timeout after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
        });

        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// NapCat API client supporting both HTTP and WebSocket transport
class NapCatApiClient {
    private config: any;
    private ws: any = null;

    constructor(config: any) {
        this.config = config;
    }

    setWebSocket(ws: any) {
        this.ws = ws;
    }

    // Send message to a user (private chat)
    async sendPrivateMsg(userId: string | number, message: string): Promise<any> {
        return this.sendMessage("/send_private_msg", { user_id: String(userId), message });
    }

    // Send message to a group
    async sendGroupMsg(groupId: string | number, message: string): Promise<any> {
        return this.sendMessage("/send_group_msg", { group_id: String(groupId), message });
    }

    // Core message sending - tries WS first, falls back to HTTP
    async sendMessage(action: string, params: Record<string, any>): Promise<any> {
        const baseUrl = this.config.url || "http://127.0.0.1:3000";
        const token = String(this.config.token || "").trim();

        // Try WebSocket first if available
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                await this.sendViaWebSocket(action, params, token);
                return { status: "ok", via: "websocket" };
            } catch (err: any) {
                console.warn(`[NapCat] WS send failed, falling back to HTTP: ${err.message}`);
            }
        }

        // Fall back to HTTP
        const fullUrl = `${baseUrl}${action}`;
        return this.sendViaHttp(fullUrl, params, token);
    }

    // Send via WebSocket using OneBot 11 format
    private sendViaWebSocket(action: string, params: Record<string, any>, token?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const obPayload = {
                action: action.replace("/", ""),
                params,
            };
            const data = JSON.stringify(obPayload);
            if (this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error("WebSocket not open"));
                return;
            }
            this.ws.send(data, (err: any) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    // Send via HTTP with retry logic
    private async sendViaHttp(url: string, payload: any, token?: string): Promise<any> {
        const cfg = getNapCatConfig();
        const maxAttempts = 3;
        const timeoutsMs = [5000, 7000, 9000];
        const connectionClose = cfg.connectionClose !== false;
        const target = new URL(url);
        const targetInfo = `${target.protocol}//${target.hostname}:${target.port || (target.protocol === "https:" ? "443" : "80")}${target.pathname}`;

        let lastErr: any = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const startedAt = Date.now();
            try {
                const timeoutMs = timeoutsMs[Math.min(attempt - 1, timeoutsMs.length - 1)];
                const res = await postJsonWithNodeHttp(url, payload, timeoutMs, { connectionClose, token });

                if (res.statusCode < 200 || res.statusCode >= 300) {
                    throw new Error(`NapCat API Error: ${res.statusCode} ${res.statusText}${res.bodyText ? ` | ${res.bodyText.slice(0, 300)}` : ""}`);
                }

                const elapsedMs = Date.now() - startedAt;
                console.log(`[NapCat] HTTP send success attempt ${attempt}/${maxAttempts} ${targetInfo} in ${elapsedMs}ms (connection=${connectionClose ? "close" : "keep-alive"})`);

                if (!res.bodyText) return { status: "ok" };
                try {
                    return JSON.parse(res.bodyText);
                } catch {
                    return { status: "ok", raw: res.bodyText };
                }
            } catch (err: any) {
                lastErr = err;
                const retryable = isRetryableNapCatError(err);
                const backoffAttempt = attempt;
                const backoffMs = Math.min(backoffAttempt * backoffAttempt * 200, 5000);

                console.log(`[NapCat] sendToNapCat attempt ${attempt}/${maxAttempts} failed (retryable=${retryable}): ${err.message}`);

                if (retryable && attempt < maxAttempts) {
                    console.log(`[NapCat] Retrying in ${backoffMs}ms...`);
                    await new Promise(r => setTimeout(r, backoffMs));
                } else {
                    break;
                }
            }
        }

        throw lastErr;
    }
}

export { NapCatApiClient, sendToNapCat };
