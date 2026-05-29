import { Command } from "commander";
import { loadConfig, saveConfig, CONFIG_FILE, DEFAULT_API_URL } from "../config.js";
import { outputJson, outputError } from "../output.js";

/** Mask a secret so it never lands in logs / CI output in full. */
function maskKey(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 12 ? `${s.slice(0, 12)}…${s.slice(-2)}` : "****";
}

/** Return a copy of the config with secret values masked unless `reveal`. */
function redactConfig(cfg: Record<string, unknown>, reveal: boolean): Record<string, unknown> {
  if (reveal || !cfg.apiKey) return cfg;
  return { ...cfg, apiKey: maskKey(cfg.apiKey) };
}

export function registerConfigCommands(program: Command) {
  const config = program.command("config").description("Manage CLI configuration");

  config
    .command("init")
    .description("Create config file with defaults")
    .action(() => {
      const json = program.opts().json;
      const existing = loadConfig();
      saveConfig({ apiUrl: DEFAULT_API_URL, ...existing });
      if (json) {
        outputJson({ configFile: CONFIG_FILE, created: true });
      } else {
        console.log(`Config saved to ${CONFIG_FILE}`);
      }
    });

  config
    .command("get <key>")
    .description("Get a config value")
    .option("--reveal", "Show secret values (e.g. apiKey) in full")
    .action((key, opts) => {
      const json = program.opts().json;
      const cfg = loadConfig();
      let value = (cfg as any)[key];
      if (key === "apiKey" && value && !opts.reveal) value = maskKey(value);
      if (json) {
        outputJson({ [key]: value ?? null });
      } else {
        console.log(value ?? "(not set)");
      }
    });

  config
    .command("set <key> <value>")
    .description("Set a config value")
    .action((key, value) => {
      const json = program.opts().json;
      const cfg = loadConfig();
      (cfg as any)[key] = value;
      saveConfig(cfg);
      if (json) {
        outputJson({ [key]: value });
      } else {
        console.log(`${key} = ${value}`);
      }
    });

  config
    .command("list")
    .alias("ls")
    .description("Show all config values")
    .option("--reveal", "Show secret values (e.g. apiKey) in full")
    .action((opts) => {
      const json = program.opts().json;
      const cfg = loadConfig();
      if (json) {
        outputJson(redactConfig(cfg as Record<string, unknown>, !!opts?.reveal));
      } else {
        const entries = Object.entries(cfg);
        if (entries.length === 0) {
          console.log("No config set. Run: kill-switch config init");
        } else {
          for (const [k, v] of entries) {
            const display = k === "apiKey" && !opts?.reveal ? maskKey(v) : String(v);
            console.log(`${k.padEnd(12)} ${display}`);
          }
        }
        console.log(`\nConfig file: ${CONFIG_FILE}`);
      }
    });
}
