/**
 * Kill Switch API — Server Entry Point
 *
 * Uses the app factory from app.ts and adds cron scheduler + database init.
 */

import cron from "node-cron";
import { createApp } from "./app.js";
import { runCheckCycle } from "./services/monitoring-engine.js";
import { sendDailyReports } from "./services/daily-report.js";
import { connectMongoDB, initPostgresTables } from "./globals/index.js";

const app = createApp();
const PORT = parseInt(process.env.PORT || "8090");
const CHECK_CRON = process.env.CHECK_CRON || "*/5 * * * *";
// Daily report at 08:00 UTC (configurable via DAILY_REPORT_CRON)
const DAILY_REPORT_CRON = process.env.DAILY_REPORT_CRON || "0 8 * * *";

// Monitoring check cron
cron.schedule(CHECK_CRON, async () => {
  console.error(`[guardian] Cron check at ${new Date().toISOString()}`);
  try { await runCheckCycle(); } catch (e) { console.error("[guardian] Cron failed:", e); }
});

// Daily report cron
cron.schedule(DAILY_REPORT_CRON, async () => {
  console.error(`[guardian] Daily report cron at ${new Date().toISOString()}`);
  try { await sendDailyReports(); } catch (e) { console.error("[guardian] Daily report cron failed:", e); }
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
