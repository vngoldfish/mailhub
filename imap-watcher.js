// ─── IMAP Watcher Module ─────────────────────────────────────────
// Simple & reliable: connect → check new mail → disconnect → wait → repeat

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { postWebhook } from "./webhook.js";
import { log } from "./logger.js";
import { getConfig } from "./config-manager.js";

// Helper: get IMAP settings for an account (per-account overrides global)
function getImapSettings(acc) {
    const cfg = getConfig();
    return {
        host: acc.imapHost || cfg.imapHost || "imap.gmail.com",
        port: Number(acc.imapPort || cfg.imapPort || 993),
        secure: acc.imapSecure !== undefined ? acc.imapSecure : (cfg.imapSecure !== undefined ? cfg.imapSecure : true)
    };
}

function getWebhookUrl() { return getConfig().webhookUrl; }
function getPollInterval() { return getConfig().pollIntervalMs || 3000; }

// Track watcher state per account
const watchers = new Map();

// Stats tracking
const stats = {
    totalEmailsProcessed: 0,
    totalWebhooksSent: 0,
    totalWebhooksFailed: 0,
    startedAt: new Date().toISOString()
};

export function getStats() { return { ...stats }; }
export function getWatcherStatus(accountId) { return watchers.get(accountId) || null; }

export function getAllWatcherStatuses() {
    const result = {};
    for (const [id, w] of watchers) {
        result[id] = {
            status: w.status,
            email: w.email,
            lastUid: w.lastUid,
            emailsProcessed: w.emailsProcessed,
            lastError: w.lastError,
            connectedAt: w.connectedAt,
            reconnects: w.reconnects
        };
    }
    return result;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processNewEmails(acc, state, client, broadcastFn) {
    if (state.lastUid === 0) {
        state.lastUid = client.mailbox.uidNext - 1;
        log("info", acc.id, `Initial UID set to ${state.lastUid}`);
        return;
    }

    try {
        // Find if there are actually any new UIDs
        const uids = await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true });
        if (!uids || uids.length === 0) return;

        log("info", acc.id, `📨 New mail detected! Processing UIDs: ${uids.join(", ")}`);

        const range = `${state.lastUid + 1}:*`;
        for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true }, { uid: true })) {
            if (msg.uid <= state.lastUid) continue;

            const startTime = Date.now();
            try {
                const parsed = await simpleParser(msg.source);
                const fetchMs = Date.now() - startTime;

                const payload = {
                    event: "new_mail",
                    accountId: acc.id,
                    email: acc.email,
                    mailbox: "INBOX",
                    uid: msg.uid,
                    subject: parsed.subject || "",
                    date: parsed.date?.toISOString?.() || "",
                    from: parsed.from?.value || [],
                    to: parsed.to?.value || [],
                    messageId: parsed.messageId || "",
                    text: parsed.text || "",
                    html: parsed.html || "",
                    attachments: (parsed.attachments || []).map(a => ({
                        filename: a.filename,
                        contentType: a.contentType,
                        size: a.size
                    })),
                    receivedAt: new Date().toISOString()
                };

                const success = await postWebhook(getWebhookUrl(), payload);

                state.lastUid = msg.uid;
                state.emailsProcessed++;
                stats.totalEmailsProcessed++;

                if (success) stats.totalWebhooksSent++;
                else stats.totalWebhooksFailed++;

                broadcastFn?.({
                    type: "email",
                    accountId: acc.id,
                    email: acc.email,
                    uid: msg.uid,
                    subject: parsed.subject || "(no subject)",
                    from: parsed.from?.text || "",
                    success,
                    time: new Date().toISOString()
                });

                log("info", acc.id, `✅ uid=${msg.uid} "${parsed.subject}" in ${fetchMs}ms`);
            } catch (fetchErr) {
                log("error", acc.id, `Error processing uid=${msg.uid}: ${fetchErr.message}`);
                state.lastUid = msg.uid; // Skip this one to avoid stuck loop
            }
        }
    } catch (err) {
        log("error", acc.id, `Error searching new emails: ${err.message}`);
    }
}

export async function startWatcher(acc, broadcastFn) {
    const state = {
        status: "connecting",
        email: acc.email,
        lastUid: 0,
        emailsProcessed: 0,
        lastError: null,
        connectedAt: null,
        reconnects: 0,
        stopped: false
    };

    watchers.set(acc.id, state);
    log("info", acc.id, `Starting IDLE watcher for ${acc.email}`);

    let errorBackoff = 3000;

    while (!state.stopped) {
        broadcastFn?.({ type: "status", accountId: acc.id, status: "connecting" });
        const imap = getImapSettings(acc);
        const client = new ImapFlow({
            host: imap.host,
            port: imap.port,
            secure: imap.secure,
            auth: { user: acc.email, pass: acc.appPassword },
            logger: false
        });

        try {
            await client.connect();
            state.status = "connected";
            state.connectedAt = new Date().toISOString();
            state.lastError = null;
            errorBackoff = 3000; // Reset backoff
            broadcastFn?.({ type: "status", accountId: acc.id, status: "connected" });

            const lock = await client.getMailboxLock("INBOX");
            try {
                // Initialize UID and process any missed emails before entering IDLE
                await processNewEmails(acc, state, client, broadcastFn);

                // Setup real-time event listener for new emails
                await new Promise((resolve) => {
                    let processing = false;
                    const onExists = async () => {
                        if (state.stopped || processing) return;
                        processing = true;
                        try {
                            await processNewEmails(acc, state, client, broadcastFn);
                        } catch (e) {
                            log("error", acc.id, `Exception in exists event: ${e.message}`);
                        } finally {
                            processing = false;
                        }
                    };

                    client.on("exists", onExists);
                    client.on("close", () => resolve());
                    client.on("error", () => resolve());

                    // Monitor stop signal
                    const checkInterval = setInterval(() => {
                        if (state.stopped || !client.usable) {
                            clearInterval(checkInterval);
                            resolve();
                        }
                    }, 500);
                });
            } finally {
                // Ignore lock release errors if connection dropped
                try { lock.release(); } catch (e) { }
            }
        } catch (e) {
            state.lastError = e?.message || String(e);
            state.status = "error";
            state.reconnects++;
            log("error", acc.id, `Connection error: ${state.lastError}`);
            broadcastFn?.({ type: "status", accountId: acc.id, status: "error", error: state.lastError });
            errorBackoff = Math.min(errorBackoff * 1.5, 60000);
        } finally {
            try { await client.logout(); } catch { }
        }

        if (!state.stopped) {
            log("info", acc.id, `Reconnecting in ${Math.round(errorBackoff / 1000)}s...`);
            await sleep(errorBackoff);
        }
    }

    state.status = "stopped";
    watchers.delete(acc.id);
    broadcastFn?.({ type: "status", accountId: acc.id, status: "stopped" });
    log("info", acc.id, `Watcher stopped`);
}

export async function stopWatcher(accountId) {
    const state = watchers.get(accountId);
    if (!state) return false;
    state.stopped = true;
    log("info", accountId, `Stop requested`);
    return true;
}

export async function stopAllWatchers() {
    for (const [id] of watchers) {
        await stopWatcher(id);
    }
}

// ─── Fetch recent unread emails for an account (with pagination + date filter) ──
export async function fetchRecentEmails(acc, { page = 1, limit = 10, sinceDays = 2 } = {}) {
    const imap = getImapSettings(acc);
    const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: acc.email, pass: acc.appPassword },
        logger: false
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");

        try {
            // To get exactly today + yesterday, we need the start of yesterday.
            let sinceDate = new Date();
            let subtractDays = sinceDays > 1 ? sinceDays - 1 : 0;
            sinceDate.setDate(sinceDate.getDate() - subtractDays);
            sinceDate.setHours(0, 0, 0, 0);

            // imapflow search requires simple JS Date for 'since'
            let searchCriteria = { seen: false, since: sinceDate };
            let fallbackCriteria = { since: sinceDate };

            // Search UNSEEN emails since date
            let uids = await client.search(searchCriteria, { uid: true });

            // If no unread, get latest emails since date instead
            if (!uids || uids.length === 0) {
                uids = await client.search(fallbackCriteria, { uid: true });
            }

            if (!uids || uids.length === 0) return { emails: [], totalCount: 0, page, totalPages: 0 };

            // Cap at 100
            uids.sort((a, b) => b - a);
            const cappedUids = uids.slice(0, 100);
            const totalCount = cappedUids.length;
            const totalPages = Math.ceil(totalCount / limit);

            // Paginate
            const startIdx = (page - 1) * limit;
            const pageUids = cappedUids.slice(startIdx, startIdx + limit);

            if (pageUids.length === 0) return { emails: [], totalCount, page, totalPages };

            const emails = [];
            const uidRange = pageUids.join(",");

            for await (const msg of client.fetch(uidRange, {
                uid: true,
                envelope: true,
                flags: true,
                bodyStructure: true
            }, { uid: true })) {
                const env = msg.envelope || {};
                const fromAddr = env.from?.[0];

                emails.push({
                    uid: msg.uid,
                    subject: env.subject || "(no subject)",
                    from: fromAddr ? {
                        name: fromAddr.name || "",
                        address: fromAddr.address || `${fromAddr.mailbox || ""}@${fromAddr.host || ""}`
                    } : { name: "", address: "" },
                    date: env.date?.toISOString?.() || "",
                    flags: msg.flags ? [...msg.flags] : [],
                    seen: msg.flags?.has("\\Seen") || false,
                    messageId: env.messageId || ""
                });
            }

            emails.sort((a, b) => b.uid - a.uid);
            return { emails, totalCount, page, totalPages };

        } finally {
            lock.release();
        }
    } catch (e) {
        log("error", acc.id || "FETCH", `Error fetching recent emails: ${e.message}`);
        throw e;
    } finally {
        try { await client.logout(); } catch { }
    }
}

// ─── Fetch single email detail with body ─────────────────────────
export async function fetchEmailDetail(acc, uid) {
    const imap = getImapSettings(acc);
    const client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: acc.email, pass: acc.appPassword },
        logger: false
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock("INBOX");

        try {
            const msg = await client.fetchOne(
                uid,
                { uid: true, envelope: true, source: true, flags: true, bodyStructure: true },
                { uid: true }
            );

            if (!msg) return null;

            const parsed = await simpleParser(msg.source);
            const env = msg.envelope || {};

            return {
                uid: msg.uid,
                subject: parsed.subject || env.subject || "",
                from: parsed.from?.value || [],
                to: parsed.to?.value || [],
                cc: parsed.cc?.value || [],
                date: parsed.date?.toISOString?.() || env.date?.toISOString?.() || "",
                messageId: parsed.messageId || "",
                text: parsed.text || "",
                html: parsed.html || "",
                flags: msg.flags ? [...msg.flags] : [],
                seen: msg.flags?.has("\\Seen") || false,
                attachments: (parsed.attachments || []).map(a => ({
                    filename: a.filename,
                    contentType: a.contentType,
                    size: a.size
                }))
            };

        } finally {
            lock.release();
        }
    } catch (e) {
        log("error", acc.id || "FETCH", `Error fetching email detail uid=${uid}: ${e.message}`);
        throw e;
    } finally {
        try { await client.logout(); } catch { }
    }
}
