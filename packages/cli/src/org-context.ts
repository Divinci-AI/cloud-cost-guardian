import type { KillSwitchClient } from "@kill-switch/sdk";
import { colors as c } from "./output.js";
import { BIN } from "./program-name.js";

/**
 * Active-org context for the authenticated user.
 *
 * Accounts/rules/alerts are all scoped server-side to the user's active org
 * (UserProfile.activeOrgId, changed via `ks orgs switch`). The dogfood team lost
 * time chasing a "missing" account that was simply in another of their orgs, so
 * the list/status surfaces echo which org they're looking at.
 */
export interface OrgContext {
  activeOrgId: string | null;
  activeOrgName: string | null;
  activeRole: string | null;
  orgCount: number;
}

export async function fetchOrgContext(client: KillSwitchClient): Promise<OrgContext | null> {
  try {
    const { orgs, activeOrgId } = await client.orgs.list();
    const active = orgs.find((o) => o.id === activeOrgId) ?? null;
    return {
      activeOrgId: activeOrgId ?? null,
      activeOrgName: active?.name ?? null,
      activeRole: active?.role ?? null,
      orgCount: orgs.length,
    };
  } catch {
    return null; // never let an org lookup break the underlying command
  }
}

/** One-line org banner for human output. Empty string when context is unavailable. */
export function orgBanner(ctx: OrgContext | null): string {
  if (!ctx) return "";
  const name = ctx.activeOrgName ?? ctx.activeOrgId ?? "personal";
  const role = ctx.activeRole ? c.dim(` (${ctx.activeRole})`) : "";
  const multi =
    ctx.orgCount > 1
      ? c.dim(` · ${ctx.orgCount} orgs — accounts are scoped per org · switch: ${BIN} orgs switch <id>`)
      : "";
  return `${c.bold("Org:")} ${name}${role}${multi}`;
}
