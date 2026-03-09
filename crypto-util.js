// ─── Crypto Module ───────────────────────────────────────────────
// AES-256-GCM encryption for sensitive data (app passwords)

import crypto from "crypto";
import fs from "fs";
import path from "path";

const KEY_FILE = path.resolve("./encryption.key");
const ALGORITHM = "aes-256-gcm";

let encryptionKey = null;

function getKey() {
    if (encryptionKey) return encryptionKey;

    // Try from env first
    if (process.env.ENCRYPTION_KEY) {
        encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
        return encryptionKey;
    }

    // Try from file
    if (fs.existsSync(KEY_FILE)) {
        encryptionKey = Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex");
        return encryptionKey;
    }

    // Generate new key
    encryptionKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, encryptionKey.toString("hex"), "utf8");
    console.log("[CRYPTO] Generated new encryption key → encryption.key");
    return encryptionKey;
}

export function encrypt(text) {
    if (!text) return text;
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    // Format: enc:iv:tag:ciphertext
    return `enc:${iv.toString("hex")}:${tag}:${encrypted}`;
}

export function decrypt(text) {
    if (!text) return text;
    // If not encrypted, return as-is (backward compatibility)
    if (!text.startsWith("enc:")) return text;

    const key = getKey();
    const parts = text.split(":");
    if (parts.length !== 4) return text;

    const iv = Buffer.from(parts[1], "hex");
    const tag = Buffer.from(parts[2], "hex");
    const encrypted = parts[3];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
}

export function isEncrypted(text) {
    return text && text.startsWith("enc:");
}
