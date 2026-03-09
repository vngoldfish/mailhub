// ─── API Server Module ───────────────────────────────────────────
// Express REST API + WebSocket for real-time updates + serves UI

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { log, getLogBuffer, clearLogBuffer } from "./logger.js";
import {
    getAccounts, getAccountsSafe, getEnabledAccounts, getAccountById,
    addAccount, updateAccount, deleteAccount, getTotalAccounts
} from "./account-manager.js";
import {
    getAllWatcherStatuses, getWatcherStatus, getStats,
    startWatcher, stopWatcher, fetchRecentEmails, fetchEmailDetail
} from "./imap-watcher.js";
import { getConfig, updateConfig, getImapPresets } from "./config-manager.js";
import { addNotification, getNotifications } from "./notification-manager.js";


let wss;
const wsClients = new Set();

export function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(msg);
    }

    // Save to server-side notification history
    if (data.type === 'email') {
        const from = data.from || 'Không rõ';
        addNotification({
            type: data.success ? 'ok' : 'er',
            title: 'Email mới nhận được',
            message: `Từ: ${from}\nĐến: ${data.email}\nNội dung: ${data.subject}`,
            email: data.email
        });
    } else if (data.type === 'status' && data.status === 'error') {
        const acc = getAccountById(data.accountId);
        if (acc) {
            addNotification({
                type: 'er',
                title: 'Lỗi kết nối',
                message: `Tài khoản ${acc.email} gặp lỗi: ${data.error}`,
                email: acc.email
            });
        }
    }
}

export function createApiServer() {
    const app = express();
    const server = createServer(app);

    app.use(express.json());
    app.use(express.static("public"));

    // ─── Health Check ──────────────────────────────────────
    app.get("/api/health", (_req, res) => {
        const watchers = getAllWatcherStatuses();
        const errorAccounts = Object.entries(watchers)
            .filter(([, w]) => w.status === "error")
            .map(([id, w]) => ({ id, email: w.email, error: w.lastError }));

        res.json({
            status: "ok",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            stats: getStats(),
            errorAccounts
        });
    });

    // ─── Accounts CRUD with pagination, search, filter ────
    app.get("/api/accounts", (_req, res) => {
        const page = Math.max(1, Number(_req.query.page) || 1);
        const limit = Math.min(Number(_req.query.limit) || 20, 50);
        const search = (_req.query.search || "").trim().toLowerCase();
        const statusFilter = (_req.query.status || "").trim(); // connected, error, stopped, all

        const allAccounts = getAccountsSafe();
        const watchers = getAllWatcherStatuses();

        // Enrich with watcher status
        let enriched = allAccounts.map(a => ({
            ...a,
            watcherStatus: watchers[a.id]?.status || "stopped",
            lastError: watchers[a.id]?.lastError || null
        }));

        // Filter by search
        if (search) {
            enriched = enriched.filter(a => a.email.toLowerCase().includes(search));
        }

        // Filter by status
        if (statusFilter && statusFilter !== "all") {
            enriched = enriched.filter(a => a.watcherStatus === statusFilter);
        }

        const totalCount = enriched.length;
        const totalPages = Math.ceil(totalCount / limit);
        const startIdx = (page - 1) * limit;
        const paged = enriched.slice(startIdx, startIdx + limit);

        res.json({
            accounts: paged,
            totalCount,
            page,
            totalPages,
            limit
        });
    });

    app.post("/api/accounts", (req, res) => {
        const { email, appPassword, authType, cookie, imapHost, imapPort, imapSecure, enabled } = req.body;
        if (!email || (!appPassword && !cookie)) {
            return res.status(400).json({ error: "email and (appPassword or cookie) are required" });
        }
        try {
            const acc = addAccount({ email, appPassword, authType, cookie, imapHost, imapPort, imapSecure, enabled });
            res.status(201).json({
                account: { ...acc, appPassword: "••••••••" },
                message: "Account created."
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.put("/api/accounts/:id", (req, res) => {
        const updated = updateAccount(req.params.id, req.body);
        if (!updated) return res.status(404).json({ error: "Account not found" });
        res.json({ account: { ...updated, appPassword: "••••••••" } });
    });

    app.delete("/api/accounts/:id", async (req, res) => {
        await stopWatcher(req.params.id);
        const deleted = deleteAccount(req.params.id);
        if (!deleted) return res.status(404).json({ error: "Account not found" });
        res.json({ message: "Account deleted" });
    });

    // ─── Watcher Controls ─────────────────────────────────
    app.get("/api/watchers", (_req, res) => {
        res.json({ watchers: getAllWatcherStatuses() });
    });

    app.post("/api/accounts/:id/start", (req, res) => {
        const acc = getAccountById(req.params.id);
        if (!acc) return res.status(404).json({ error: "Account not found" });
        const existing = getWatcherStatus(acc.id);
        if (existing && existing.status === "connected") {
            return res.json({ message: "Already watching", status: existing });
        }
        startWatcher(acc, broadcast);
        res.json({ message: `Watcher started for ${acc.email}` });
    });

    app.post("/api/accounts/:id/stop", async (req, res) => {
        const stopped = await stopWatcher(req.params.id);
        if (!stopped) return res.status(404).json({ error: "No active watcher" });
        res.json({ message: "Watcher stopped" });
    });

    // ─── Recent Emails (paginated) ───────────────────────────
    app.get("/api/accounts/:id/emails", async (req, res) => {
        const acc = getAccountById(req.params.id);
        if (!acc) return res.status(404).json({ error: "Account not found" });

        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(Number(req.query.limit) || 10, 20);

        try {
            const cfg = getConfig();
            const filterObj = { page, limit, sinceDays: 2 };

            const result = await fetchRecentEmails(acc, filterObj);
            res.json({ ...result, accountId: acc.id, email: acc.email });
        } catch (e) {
            res.status(500).json({ error: `Failed to fetch emails: ${e.message}` });
        }
    });

    // ─── Email Detail ────────────────────────────────────────
    app.get("/api/accounts/:id/emails/:uid", async (req, res) => {
        const acc = getAccountById(req.params.id);
        if (!acc) return res.status(404).json({ error: "Account not found" });
        const uid = Number(req.params.uid);
        if (!uid) return res.status(400).json({ error: "Invalid UID" });
        try {
            const detail = await fetchEmailDetail(acc, uid);
            if (!detail) return res.status(404).json({ error: "Email not found" });
            res.json({ email: detail, accountId: acc.id, accountEmail: acc.email });
        } catch (e) {
            res.status(500).json({ error: `Failed to fetch email: ${e.message}` });
        }
    });

    // ─── Unified Inbox (paginated) ──────────────────────────
    app.get("/api/inbox", async (req, res) => {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(Number(req.query.limit) || 10, 20);
        const accounts = getAccounts().filter(a => a.enabled !== false);

        // Fetch ALL unread from all accounts (max 100 each)
        const promises = accounts.map(async (acc) => {
            try {
                const cfg = getConfig();
                const filterObj = { page: 1, limit: 100, sinceDays: 2 };

                const result = await fetchRecentEmails(acc, filterObj);
                return (result.emails || []).map(e => ({ ...e, accountId: acc.id, accountEmail: acc.email }));
            } catch {
                return [];
            }
        });

        const allEmails = (await Promise.all(promises)).flat();
        allEmails.sort((a, b) => new Date(b.date) - new Date(a.date));

        // Cap at 100 total
        const cappedEmails = allEmails.slice(0, 100);
        const totalCount = cappedEmails.length;
        const totalPages = Math.ceil(totalCount / limit);
        const startIdx = (page - 1) * limit;
        const paged = cappedEmails.slice(startIdx, startIdx + limit);

        res.json({ emails: paged, totalCount, page, totalPages, totalAccounts: accounts.length });
    });

    // ─── Logs ──────────────────────────────────────────────
    app.get("/api/logs", (req, res) => {
        const limit = Math.min(Number(req.query.limit) || 100, 500);
        const logs = getLogBuffer().slice(-limit);
        res.json({ logs });
    });

    app.delete("/api/logs", (_req, res) => {
        clearLogBuffer();
        res.json({ message: "Logs cleared" });
    });

    // ─── Config ────────────────────────────────────────────────
    app.get("/api/config", (_req, res) => {
        res.json({ config: getConfig() });
    });

    app.put("/api/config", (req, res) => {
        try {
            const updated = updateConfig(req.body);
            res.json({ config: updated, message: "Config updated" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    app.get("/api/config/imap-presets", (_req, res) => {
        res.json({ presets: getImapPresets() });
    });

    // ─── Notifications ─────────────────────────────────────
    app.get("/api/notifications", (_req, res) => {
        res.json({ notifications: getNotifications() });
    });

    // ─── WebSocket ─────────────────────────────────────────
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
        wsClients.add(ws);
        log("info", "WS", "Client connected");
        ws.send(JSON.stringify({
            type: "init",
            watchers: getAllWatcherStatuses(),
            stats: getStats()
        }));
        ws.on("close", () => wsClients.delete(ws));
    });

    const port = getConfig().apiPort || 8899;
    server.listen(port, "0.0.0.0", () => {
        log("info", "API", `Server running on http://0.0.0.0:${port}`);
        log("info", "API", `Dashboard: http://localhost:${port}`);
    });

    return { app, server, wss };
}
