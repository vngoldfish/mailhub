// ─── Webhook Module ──────────────────────────────────────────────
// Sends webhooks with retry + exponential backoff

import { log } from "./logger.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Hàng đợi đơn giản để xử lý tuần tự (tránh làm sập n8n)
let isProcessingQueue = false;
const webhookQueue = [];

export async function postWebhook(url, payload, retries = MAX_RETRIES) {
    return new Promise((resolve) => {
        webhookQueue.push({ url, payload, retries, resolve });
        processQueue();
    });
}

async function processQueue() {
    if (isProcessingQueue || webhookQueue.length === 0) return;

    isProcessingQueue = true;

    while (webhookQueue.length > 0) {
        const { url, payload, retries, resolve } = webhookQueue.shift();

        const success = await _executeWebhook(url, payload, retries);

        // Delay 1 giây giữa các webhook liên tiếp để nhả tải cho server n8n
        if (webhookQueue.length > 0) {
            await new Promise(r => setTimeout(r, 1000));
        }

        resolve(success);
    }

    isProcessingQueue = false;
}

async function _executeWebhook(url, payload, retries) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15000) // 15s timeout
            });

            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`HTTP ${res.status}: ${body}`);
            }

            log("info", "WEBHOOK", `Sent successfully`, {
                accountId: payload.accountId,
                uid: payload.uid,
                attempt
            });
            return true;
        } catch (e) {
            const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
            log("warn", "WEBHOOK", `Attempt ${attempt}/${retries} failed: ${e.message}`, {
                accountId: payload.accountId
            });

            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delay));
            } else {
                log("error", "WEBHOOK", `All ${retries} attempts failed`, {
                    accountId: payload.accountId,
                    uid: payload.uid
                });
                return false;
            }
        }
    }
    return false;
}
