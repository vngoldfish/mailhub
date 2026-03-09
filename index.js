// ─── MailHub Collector v2.0 ──────────────────────────────────────
// Entry point: loads accounts, starts API server, begins watching

import { log } from "./logger.js";
import { loadAccounts, getEnabledAccounts } from "./account-manager.js";
import { startWatcher, stopAllWatchers } from "./imap-watcher.js";
import { createApiServer, broadcast } from "./api-server.js";
import { loadConfig, getConfig } from "./config-manager.js";

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log(`
╔══════════════════════════════════════╗
║       📧 MailHub Collector v2.0      ║
║     Real-time Email → Webhook        ║
╚══════════════════════════════════════╝
  `);

  // Load config (file + env overrides)
  const config = loadConfig();

  if (!config.webhookUrl) {
    log("warn", "MAIN", "No webhookUrl configured. Set via dashboard Settings or N8N_WEBHOOK_URL env var.");
  }

  // Load accounts from JSON
  loadAccounts();
  const enabled = getEnabledAccounts();
  log("info", "MAIN", `Found ${enabled.length} enabled account(s)`);

  // Start API server & WebSocket
  createApiServer();

  // Start watchers for enabled accounts with stagger
  const stagger = config.connectStaggerMs || 500;
  for (const acc of enabled) {
    startWatcher(acc, broadcast);
    await sleep(stagger);
  }

  log("info", "MAIN", "All watchers started");
}

// Graceful shutdown
async function shutdown(signal) {
  log("info", "MAIN", `Received ${signal}, shutting down...`);
  await stopAllWatchers();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch(e => {
  log("error", "MAIN", `Fatal error: ${e.message}`);
  console.error(e);
  process.exit(1);
});