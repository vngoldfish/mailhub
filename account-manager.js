// ─── Account Manager Module ──────────────────────────────────────
// Manages accounts with CRUD, file persistence, and password encryption

import fs from "fs";
import path from "path";
import { log } from "./logger.js";
import { encrypt, decrypt, isEncrypted } from "./crypto-util.js";

const ACCOUNTS_FILE = path.resolve("./accounts.json");

let accounts = [];

export function loadAccounts() {
    try {
        const raw = fs.readFileSync(ACCOUNTS_FILE, "utf8");
        const json = JSON.parse(raw);
        accounts = json.accounts || [];

        // Auto-encrypt any plaintext passwords on load
        let needsSave = false;
        for (const acc of accounts) {
            if (acc.appPassword && !isEncrypted(acc.appPassword)) {
                acc.appPassword = encrypt(acc.appPassword);
                needsSave = true;
            }
        }
        if (needsSave) {
            saveAccountsRaw();
            log("info", "ACCOUNTS", "Encrypted existing plaintext passwords");
        }

        log("info", "ACCOUNTS", `Loaded ${accounts.length} account(s)`);
        return accounts;
    } catch (e) {
        log("error", "ACCOUNTS", `Failed to load accounts: ${e.message}`);
        accounts = [];
        return accounts;
    }
}

function saveAccountsRaw() {
    const data = JSON.stringify({ accounts }, null, 2);
    fs.writeFileSync(ACCOUNTS_FILE, data, "utf8");
}

function saveAccounts() {
    try {
        saveAccountsRaw();
        log("info", "ACCOUNTS", `Saved ${accounts.length} account(s) to disk`);
    } catch (e) {
        log("error", "ACCOUNTS", `Failed to save accounts: ${e.message}`);
        throw e;
    }
}

// Get all accounts (with decrypted password for internal use)
export function getAccounts() {
    return accounts.map(a => ({
        ...a,
        appPassword: decrypt(a.appPassword)
    }));
}

// Get raw accounts (encrypted, for API responses — password masked)
export function getAccountsSafe() {
    return accounts.map(a => ({
        ...a,
        appPassword: "••••••••",
        encrypted: isEncrypted(a.appPassword)
    }));
}

export function getEnabledAccounts() {
    return accounts
        .filter(a => a.enabled !== false)
        .map(a => ({ ...a, appPassword: decrypt(a.appPassword) }));
}

export function getAccountById(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return null;
    return { ...acc, appPassword: decrypt(acc.appPassword) };
}

export function addAccount({ email, appPassword, authType, cookie, imapHost, imapPort, imapSecure, enabled = true, webhookIds = [] }) {
    const id = `acc_${String(Date.now()).slice(-6)}_${Math.random().toString(36).slice(2, 6)}`;
    const cleanPassword = appPassword ? appPassword.replace(/\s+/g, '') : appPassword;
    const newAcc = {
        id,
        email: email.trim(),
        authType: authType || 'app_password',
        appPassword: encrypt(cleanPassword || ""),
        cookie: encrypt(cookie || ""),
        imapHost,
        imapPort,
        imapSecure,
        enabled,
        webhookIds: Array.isArray(webhookIds) ? webhookIds : []
    };
    accounts.push(newAcc);
    saveAccounts();
    log("info", "ACCOUNTS", `Added account ${id}: ${email} (${newAcc.authType})`);
    return { ...newAcc, appPassword: decrypt(newAcc.appPassword), cookie: decrypt(newAcc.cookie) };
}

export function updateAccount(id, updates) {
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;

    const allowed = ["email", "appPassword", "authType", "cookie", "enabled", "imapHost", "imapPort", "imapSecure", "webhookIds"];
    for (const key of allowed) {
        if (updates[key] !== undefined) {
            if (key === "appPassword") {
                const cleanPassword = updates[key] ? updates[key].replace(/\s+/g, '') : updates[key];
                accounts[idx][key] = encrypt(cleanPassword || "");
            } else if (key === "cookie") {
                accounts[idx][key] = encrypt(updates[key] || "");
            } else if (key === "email" && typeof updates[key] === "string") {
                accounts[idx][key] = updates[key].trim();
            } else if (key === "webhookIds") {
                accounts[idx][key] = Array.isArray(updates[key]) ? updates[key] : [];
            } else {
                accounts[idx][key] = updates[key];
            }
        }
    }

    saveAccounts();
    log("info", "ACCOUNTS", `Updated account ${id}`);
    return { ...accounts[idx], appPassword: decrypt(accounts[idx].appPassword) };
}

export function deleteAccount(id) {
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) return false;

    const removed = accounts.splice(idx, 1)[0];
    saveAccounts();
    log("info", "ACCOUNTS", `Deleted account ${id}: ${removed.email}`);
    return true;
}

export function getTotalAccounts() {
    return accounts.length;
}

/**
 * Updates all accounts to either include or exclude a specific webhookId
 * based on the provided accountIds list.
 */
export function updateAccountsForWebhook(webhookId, activeAccountIds) {
    let changed = false;
    for (const acc of accounts) {
        if (!acc.webhookIds) acc.webhookIds = [];
        const isCurrentlyActive = acc.webhookIds.includes(webhookId);
        const shouldBeActive = activeAccountIds.includes(acc.id);

        if (shouldBeActive && !isCurrentlyActive) {
            acc.webhookIds.push(webhookId);
            changed = true;
        } else if (!shouldBeActive && isCurrentlyActive) {
            acc.webhookIds = acc.webhookIds.filter(id => id !== webhookId);
            changed = true;
        }
    }
    if (changed) {
        saveAccounts();
    }
    return changed;
}
