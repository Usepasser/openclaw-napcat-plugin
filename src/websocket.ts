import { WebSocket } from "ws";
import { setNapCatWs } from "./runtime.js";
import { handleNapCatWebsocket } from "./webhook.js";

// WebSocket client class for NapCat bidirectional communication
class NapCatWebSocket {
    private ws: any = null;
    private config: any;
    private setStatus: any;
    private abortSignal: any;
    private stopped = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = 10;
    private baseReconnectDelayMs = 1000;
    private messageHandler: ((event: any) => Promise<void>) | null = null;
    private wsUrl: string;
    private token: string;

    constructor(config: any, setStatus: any, abortSignal: any) {
        this.config = config;
        this.setStatus = setStatus;
        this.abortSignal = abortSignal;
        const baseUrl = config.url || "http://127.0.0.1:3000";
        this.wsUrl = baseUrl.replace('http://', 'ws://').replace('https://', 'wss://');
        this.token = String(config.token || "").trim();

        if (abortSignal) {
            abortSignal.addEventListener('abort', () => this.close());
        }
    }

    setMessageHandler(handler: (event: any) => Promise<void>) {
        this.messageHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.stopped) return;

        try {
            this.ws = new WebSocket(
                this.wsUrl,
                this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined
            );

            this.ws.on('open', () => {
                console.log("[NapCat] WebSocket connected");
                this.setStatus({ connected: true, lastEventAt: Date.now() });
                this.reconnectAttempts = 0;
                setNapCatWs(this.ws);
            });

            this.ws.on('message', async (data: any) => {
                try {
                    const message = JSON.parse(data.toString());
                    console.log(`[NapCat] WS received event: ${JSON.stringify(message).substring(0, 100)}`);
                    if (this.messageHandler) {
                        await this.messageHandler(message);
                    }
                } catch (err) {
                    console.error("[NapCat] Failed to process WS message:", err);
                }
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                console.log(`[NapCat] WebSocket closed: code=${code} reason=${reason.toString()}`);
                setNapCatWs(null);
                if (!this.stopped) {
                    this.scheduleReconnect();
                }
            });

            this.ws.on('error', (err: any) => {
                console.error("[NapCat] WebSocket error:", err);
            });

        } catch (err) {
            console.error("[NapCat] Failed to connect WebSocket:", err);
            if (!this.stopped) {
                this.scheduleReconnect();
            }
        }
    }

    private scheduleReconnect() {
        this.reconnectAttempts++;
        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            const delay = this.baseReconnectDelayMs * Math.min(this.reconnectAttempts * 2, 30);
            console.log(`[NapCat] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.connect(), delay);
        } else {
            console.error("[NapCat] Max reconnect attempts reached");
            this.setStatus({ connected: false, lastEventAt: Date.now() });
        }
    }

    close() {
        this.stopped = true;
        if (this.ws) {
            this.ws.close();
        }
    }

    isConnected(): boolean {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    getWs() {
        return this.ws;
    }
}

export { NapCatWebSocket };
