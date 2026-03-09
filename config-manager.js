// ─── Config Manager ──────────────────────────────────────────────
// Manages global settings with file persistence

import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const CONFIG_FILE = path.resolve("./config.json");

const DEFAULTS = {
    webhooks: [], // Array of { id, name, url, filters }
    imapHost: "imap.gmail.com",
    imapPort: 993,
    imapSecure: true,
    connectStaggerMs: 500,
    apiPort: 8899,
    logLevel: "info",
    pollIntervalMs: 3000
};

// Pre-defined IMAP presets for common providers
export const IMAP_PRESETS = {
    gmail: { label: "Gmail", host: "imap.gmail.com", port: 993, secure: true },
    outlook: { label: "Outlook / Hotmail", host: "imap-mail.outlook.com", port: 993, secure: true },
    yahoo: { label: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993, secure: true },
    icloud: { label: "iCloud Mail", host: "imap.mail.me.com", port: 993, secure: true },
    zoho: { label: "Zoho Mail", host: "imap.zoho.com", port: 993, secure: true },
    yandex: { label: "Yandex Mail", host: "imap.yandex.com", port: 993, secure: true },
    custom: { label: "Tùy chỉnh", host: "", port: 993, secure: true }
};

let config = { ...DEFAULTS };

export function loadConfig() {
    // Load from file first
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, "utf8");
            const json = JSON.parse(raw);
            config = { ...DEFAULTS, ...json };
            log("info", "CONFIG", `Loaded config from ${CONFIG_FILE}`);
        }
    } catch (e) {
        log("warn", "CONFIG", `Failed to load config file: ${e.message}`);
    }

    // Environment variables override file config
    if (process.env.N8N_WEBHOOK_URL) config.webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (process.env.IMAP_HOST) config.imapHost = process.env.IMAP_HOST;
    if (process.env.IMAP_PORT) config.imapPort = Number(process.env.IMAP_PORT);
    if (process.env.IMAP_SECURE) config.imapSecure = process.env.IMAP_SECURE === "true";
    if (process.env.CONNECT_STAGGER_MS) config.connectStaggerMs = Number(process.env.CONNECT_STAGGER_MS);
    if (process.env.API_PORT) config.apiPort = Number(process.env.API_PORT);
    if (process.env.LOG_LEVEL) config.logLevel = process.env.LOG_LEVEL;
    if (process.env.POLL_INTERVAL_MS) config.pollIntervalMs = Number(process.env.POLL_INTERVAL_MS);

    // Save merged config
    saveConfig();
    return config;
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    } catch (e) {
        log("error", "CONFIG", `Failed to save config: ${e.message}`);
    }
}

export function getConfig() {
    return { ...config };
}

export function updateConfig(updates) {
    const allowed = ["webhooks", "imapHost", "imapPort", "imapSecure", "connectStaggerMs", "logLevel", "pollIntervalMs", "filterStartDate", "filterEndDate"];
    for (const key of allowed) {
        if (updates[key] !== undefined) {
            config[key] = updates[key];
        }
    }
    saveConfig();
    log("info", "CONFIG", "Config updated");
    return { ...config };
}

export function getImapPresets() {
    return IMAP_PRESETS;
}
