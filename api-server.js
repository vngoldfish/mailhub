// ─── API Server Module ───────────────────────────────────────────
// Express REST API + WebSocket for real-time updates + serves UI

import express from "express";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import cookieParser from "cookie-parser";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log, getLogBuffer, clearLogBuffer } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
    getAccounts, getAccountsSafe, getEnabledAccounts, getAccountById,
    addAccount, updateAccount, deleteAccount, getTotalAccounts, updateAccountsForWebhook
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

        // 1. Email received notification
        addNotification({
            type: 'in',
            title: '📩 Email mới nhận được',
            message: `Tài khoản: ${data.email}\nTừ: ${from}\nTiêu đề: ${data.subject}`,
            email: data.email
        });

        // 2. Webhook result notification (if any)
        if (data.webhookResults && data.webhookResults.length > 0) {
            const whDetails = data.webhookResults.map(r => `${r.name}: ${r.success ? '✅' : '❌'}`).join('\n');
            addNotification({
                type: data.success ? 'ok' : 'er',
                title: data.success ? '🔗 Webhook thành công' : '⚠️ Webhook thất bại',
                message: `Kết quả gửi cho email: ${data.subject}\n${whDetails}`,
                email: data.email
            });
        }
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
    const USERS_FILE = path.resolve("./users.json");
    const AUTH_SECRET = "mailhub_temp_secret_123";

    app.use(express.json());
    app.use(cookieParser(AUTH_SECRET));

    // Role-Based Auth Middleware
    const auth = (req, res, next) => {
        const p = req.path;
        if (p === "/login" || p === "/health") return next();

        const session = req.signedCookies.mh_token;
        if (!session) return res.status(401).json({ error: "Unauthorized" });

        const role = session.role;
        // RBAC logic
        const m = req.method;

        if (role === "viewer") {
            if (m !== "GET") return res.status(403).json({ error: "Quyền 'Xem' không được phép thực hiện thao tác này" });
        } else if (role === "editor") {
            if (m === "DELETE") return res.status(403).json({ error: "Quyền 'Editor' không được phép xóa dữ liệu" });
            if (p === "/config" && m === "PUT") return res.status(403).json({ error: "Chỉ Admin mới có thể thay đổi cấu hình hệ thống" });
            if (p === "/logs" && m === "DELETE") return res.status(403).json({ error: "Chỉ Admin mới có quyền xóa Logs" });
        }

        req.user = session; // Attach full session data
        next();
    };

    app.use("/api", auth);
    app.use(express.static(path.join(__dirname, "public")));

    // Serve SPA for both / and /login
    app.get(["/", "/login"], (req, res) => {
        res.sendFile(path.join(__dirname, "public", "index.html"));
    });

    // ─── Auth Endpoints ────────────────────────────────────
    app.post("/api/login", (req, res) => {
        const { username, password } = req.body;
        try {
            if (existsSync(USERS_FILE)) {
                const users = JSON.parse(readFileSync(USERS_FILE, "utf-8"));
                const user = users[username];
                if (user && user.password === password) {
                    res.cookie("mh_token", { username, role: user.role || "viewer" }, {
                        httpOnly: true,
                        signed: true,
                        maxAge: 86400000 // 24 hours
                    });
                    return res.json({ success: true, message: "Logged in", username, role: user.role });
                }
            }
            res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu" });
        } catch (e) {
            res.status(500).json({ error: "Lỗi hệ thống" });
        }
    });

    app.post("/api/logout", (req, res) => {
        res.clearCookie("mh_token");
        res.json({ success: true, message: "Logged out" });
    });

    app.get("/api/me", (req, res) => {
        const session = req.signedCookies.mh_token;
        if (!session) return res.status(401).json({ error: "Unauthorized" });
        res.json({ authenticated: true, username: session.username, role: session.role });
    });

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
        const { email, appPassword, authType, cookie, imapHost, imapPort, imapSecure, enabled, webhookIds } = req.body;
        if (!email || (!appPassword && !cookie)) {
            return res.status(400).json({ error: "email and (appPassword or cookie) are required" });
        }
        try {
            const acc = addAccount({ email, appPassword, authType, cookie, imapHost, imapPort, imapSecure, enabled, webhookIds });
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

    app.get("/api/logs/webhooks", (req, res) => {
        const { webhookId } = req.query;
        let logs = getLogBuffer().filter(l => l.tag === "WEBHOOK" || l.tag.startsWith("WEBHOOK:"));

        if (webhookId) {
            logs = logs.filter(l => l.webhookId === webhookId);
        }

        res.json({ logs: logs.reverse() });
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

    // ─── Individual Webhook Management ─────────────────────
    // Note: These manipulate the 'webhooks' array in config.json

    app.post("/api/webhooks", (req, res) => {
        const { name, url, accountIds, filters, enabled } = req.body;
        if (!url) return res.status(400).json({ error: "Webhook URL is required" });

        const cfg = getConfig();
        const id = `wh_${Math.random().toString(36).slice(2, 8)}`;
        const newWh = { id, name: name || id, url, enabled: enabled !== false, filters: filters || {} };

        const webhooks = [...(cfg.webhooks || []), newWh];
        updateConfig({ webhooks });

        if (Array.isArray(accountIds)) {
            updateAccountsForWebhook(id, accountIds);
        }

        res.status(201).json({ webhook: newWh, message: "Webhook created" });
    });

    app.put("/api/webhooks/:id", (req, res) => {
        const { id } = req.params;
        const { name, url, accountIds, filters, enabled } = req.body;

        const cfg = getConfig();
        const webhooks = cfg.webhooks || [];
        const idx = webhooks.findIndex(w => w.id === id);

        if (idx === -1) return res.status(404).json({ error: "Webhook not found" });

        if (name !== undefined) webhooks[idx].name = name;
        if (url !== undefined) webhooks[idx].url = url;
        if (filters !== undefined) webhooks[idx].filters = filters;
        if (enabled !== undefined) webhooks[idx].enabled = !!enabled;

        updateConfig({ webhooks });

        if (Array.isArray(accountIds)) {
            updateAccountsForWebhook(id, accountIds);
        }

        res.json({ webhook: webhooks[idx], message: "Webhook updated" });
    });

    app.delete("/api/webhooks/:id", (req, res) => {
        const { id } = req.params;
        const cfg = getConfig();
        const webhooks = (cfg.webhooks || []).filter(w => w.id !== id);

        updateConfig({ webhooks });
        // Remove this webhook from all accounts
        updateAccountsForWebhook(id, []);

        res.json({ message: "Webhook deleted" });
    });

    // ─── Notifications ─────────────────────────────────────
    app.get("/api/notifications", (req, res) => {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(Number(req.query.limit) || 10, 50);

        const allNotifs = getNotifications();
        const totalCount = allNotifs.length;
        const totalPages = Math.ceil(totalCount / limit);
        const startIdx = (page - 1) * limit;
        const paged = allNotifs.slice(startIdx, startIdx + limit);

        res.json({
            notifications: paged,
            totalCount,
            page,
            totalPages,
            limit
        });
    });

    // ─── WebSocket ─────────────────────────────────────────
    wss = new WebSocketServer({ server });
    wss.on("connection", (ws, req) => {
        // Authenticate WS
        const cookiesStr = req.headers.cookie || "";
        const cookieObj = {};
        cookiesStr.split(/;\s*/).forEach(c => {
            const [k, ...v] = c.split("=");
            if (k) {
                try {
                    cookieObj[k.trim()] = decodeURIComponent(v.join("="));
                } catch (e) { }
            }
        });
        const parsed = cookieParser.signedCookies(cookieObj, AUTH_SECRET);
        let session = parsed.mh_token;
        if (session && typeof session === 'string' && session.startsWith('j:')) {
            try { session = JSON.parse(session.substring(2)); } catch (e) { }
        }

        if (!session || !session.role) {
            log("warn", "WS", "Unauthorized WS connection attempt");
            ws.close(4001, "Unauthorized");
            return;
        }

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
