// ─── MailHub Collector v2.0 ──────────────────────────────────────
// Entry point: loads accounts, starts API server, begins watching

import { log } from "./logger.js";
import { startWatcher, stopAllWatchers } from "./imap-watcher.js";
import { createApiServer, broadcast } from "./api-server.js";
import { loadConfig, getConfig, updateConfig } from "./config-manager.js";
import { loadAccounts, getEnabledAccounts, getAccounts, updateAccount } from "./account-manager.js";

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
  const cfg = loadConfig();

  // Load accounts from JSON
  loadAccounts();

  // ─── One-time Migration for Legacy Webhooks ───
  try {
    const rawCfg = JSON.parse(await import('fs').then(fs => fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')));
    const legacyWebhookUrl = rawCfg.webhookUrl;

    if (legacyWebhookUrl && (!cfg.webhooks || cfg.webhooks.length === 0)) {
      log("info", "MAIN", "Migrating legacy webhookUrl to new webhooks system...");
      const newWhId = 'wh_default';
      const newWebhooks = [{ id: newWhId, name: 'Webhook Mặc định', url: legacyWebhookUrl, filters: {} }];
      updateConfig({ webhooks: newWebhooks });

      const allAccounts = getAccounts();
      for (const acc of allAccounts) {
        if (!acc.webhookIds || acc.webhookIds.length === 0) {
          updateAccount(acc.id, { webhookIds: [newWhId] });
        }
      }
      log("info", "MAIN", "Migration completed successfully.");
    }
  } catch (e) {
    // Migration source might not exist or fail, ignore if it's already clean
  }

  const enabled = getEnabledAccounts();
  log("info", "MAIN", `Found ${enabled.length} enabled account(s)`);

  // Start API server & WebSocket
  createApiServer();

  // Start watchers for enabled accounts with stagger
  const stagger = cfg.connectStaggerMs || 500;
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