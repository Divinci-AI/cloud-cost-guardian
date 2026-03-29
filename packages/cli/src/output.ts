/**
 * Output formatting — tables for humans, JSON for machines
 *
 * Colors via chalk, spinners via ora.
 * Respects NO_COLOR env var and --json flag.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";
import { ApiError, AuthenticationError, ForbiddenError, NotFoundError, RateLimitError, NetworkError, TimeoutError } from "@kill-switch/sdk";

const noColor = !!process.env.NO_COLOR;

// Color helpers — no-op when NO_COLOR is set
const c = {
  bold: noColor ? (s: string) => s : chalk.bold,
  dim: noColor ? (s: string) => s : chalk.dim,
  green: noColor ? (s: string) => s : chalk.green,
  red: noColor ? (s: string) => s : chalk.red,
  yellow: noColor ? (s: string) => s : chalk.yellow,
  cyan: noColor ? (s: string) => s : chalk.cyan,
};

export { c as colors };

export interface Column {
  key: string;
  header: string;
  width?: number;
}

export function formatTable(rows: any[], columns: Column[]): void {
  if (rows.length === 0) {
    console.log(c.dim("No results."));
    return;
  }

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxData = rows.reduce((max, row) => {
      const val = String(row[col.key] ?? "");
      return Math.max(max, val.length);
    }, 0);
    return col.width || Math.min(Math.max(headerLen, maxData) + 2, 40);
  });

  // Header
  const headerLine = columns
    .map((col, i) => c.bold(col.header.padEnd(widths[i])))
    .join("  ");
  console.log(headerLine);
  console.log(c.dim(widths.map((w) => "─".repeat(w)).join("  ")));

  // Rows
  for (const row of rows) {
    const line = columns
      .map((col, i) => {
        const val = String(row[col.key] ?? "");
        const display = val.padEnd(widths[i]).slice(0, widths[i]);
        // Color status-like values
        if (col.key === "status" || col.key === "enabled") {
          if (val === "active" || val === "true") return c.green(display);
          if (val === "paused" || val === "false" || val === "disabled") return c.yellow(display);
          if (val === "disconnected" || val === "error") return c.red(display);
        }
        if (col.key === "severity") {
          if (val === "critical") return c.red(display);
          if (val === "warning") return c.yellow(display);
        }
        return display;
      })
      .join("  ");
    console.log(line);
  }
}

export function formatObject(obj: any, fields?: string[]): void {
  const keys = fields || Object.keys(obj);
  const maxKeyLen = keys.reduce((max, k) => Math.max(max, k.length), 0);
  for (const key of keys) {
    const val = obj[key];
    const display = typeof val === "object" ? JSON.stringify(val) : String(val ?? "");
    console.log(`${c.bold(key.padEnd(maxKeyLen + 2))}${display}`);
  }
}

export function outputJson(data: any): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputError(message: string, json: boolean): void {
  if (json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`${c.red("Error:")} ${message}`);
  }
}

/**
 * Map SDK errors to contextual CLI messages.
 */
export function formatSdkError(err: unknown): { message: string; exitCode: number } {
  if (err instanceof AuthenticationError) {
    return {
      message: "Authentication failed. Run `ks auth login` or set KILL_SWITCH_API_KEY.",
      exitCode: 2,
    };
  }
  if (err instanceof ForbiddenError) {
    const tier = (err as ForbiddenError).tierInfo;
    if (tier) {
      return {
        message: `Requires ${tier.currentTier ? `upgrade from ${tier.currentTier}` : "a higher"} plan.${tier.upgradeUrl ? ` Upgrade: https://app.kill-switch.net${tier.upgradeUrl}` : ""}`,
        exitCode: 1,
      };
    }
    return { message: err.message, exitCode: 2 };
  }
  if (err instanceof NotFoundError) {
    return { message: `${err.message} Run \`ks accounts list\` or \`ks rules list\` to see available resources.`, exitCode: 1 };
  }
  if (err instanceof RateLimitError) {
    return { message: `Rate limited. Try again in ${err.retryAfter}s.`, exitCode: 1 };
  }
  if (err instanceof NetworkError) {
    return { message: err.message, exitCode: 1 };
  }
  if (err instanceof TimeoutError) {
    return { message: err.message, exitCode: 1 };
  }
  if (err instanceof ApiError) {
    return { message: err.message, exitCode: 1 };
  }
  if (err instanceof Error) {
    return { message: err.message, exitCode: 1 };
  }
  return { message: String(err), exitCode: 1 };
}

/**
 * Wrap a command handler with error handling, spinner, and JSON support.
 */
export function handleError(err: unknown, json: boolean): never {
  const { message, exitCode } = formatSdkError(err);
  outputError(message, json);
  process.exit(exitCode);
}

// ─── Spinner helpers ─────────────────────────────────────────────────────────

export function spinner(text: string): Ora {
  return ora({ text, isSilent: !!process.env.NO_COLOR });
}

// ─── Status indicators ──────────────────────────────────────────────────────

export function success(msg: string): void {
  console.log(`${c.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${c.yellow("⚠")} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`${c.red("✗")} ${msg}`);
}
