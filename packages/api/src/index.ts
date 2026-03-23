/**
 * Kill Switch API — Server Entry Point
 *
 * Uses the app factory from app.ts and adds cron scheduler + database init.
 */

import cron from "node-cron";
import { createApp } from "./app.js";
import { runCheckCycle } from "./services/monitoring-engine.js";
import { connectMongoDB, initPostgresTables } from "./globals/index.js";

const app = createApp();
const PORT = parseInt(process.env.PORT || "8090");
const CHECK_CRON = process.env.CHECK_CRON || "*/5 * * * *";

// Cron scheduler
cron.schedule(CHECK_CRON, async () => {
  console.error(`[guardian] Cron check at ${new Date().toISOString()}`);
  try { await runCheckCycle(); } catch (e) { console.error("[guardian] Cron failed:", e); }
});

// Initialize databases, then start
(async () => {
  try { await connectMongoDB(); } catch (e: any) { console.warn("[guardian] MongoDB:", e.message); }
  try { await initPostgresTables(); } catch (e: any) { console.warn("[guardian] Postgres:", e.message); }

  app.listen(PORT, () => {
    console.error(`[guardian] Kill Switch API listening on port ${PORT}`);
    console.error(`[guardian] Check schedule: ${CHECK_CRON}`);
    console.error(`[guardian] Docs: http://localhost:${PORT}/docs`);
  });
})();
