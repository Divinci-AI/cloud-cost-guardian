import { Command } from "commander";
import { outputJson, formatTable, formatObject, handleError, success } from "../output.js";
import { confirm } from "../prompts.js";
import type { ClientFactory } from "../types.js";

export function registerOrgCommands(program: Command, createClient: ClientFactory) {
  const orgs = program.command("orgs").description("Manage organizations");

  orgs
    .command("list")
    .alias("ls")
    .description("List organizations you belong to")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.orgs.list();
        if (json) {
          outputJson(data);
        } else {
          console.log(`Active org: ${data.activeOrgId || "none"}\n`);
          formatTable(data.orgs, [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
            { key: "type", header: "Type" },
            { key: "tier", header: "Tier" },
            { key: "role", header: "Role" },
            { key: "slug", header: "Slug" },
          ]);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("create <name>")
    .description("Create a new organization (requires team/enterprise tier)")
    .action(async (name) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.orgs.create({ name });
        if (json) {
          outputJson(data);
        } else {
          console.log(`Organization created:`);
          console.log(`  ID:   ${data.id}`);
          console.log(`  Name: ${data.name}`);
          console.log(`  Slug: ${data.slug}`);
          console.log(`  Type: ${data.type}`);
          console.log(`\nSwitch to it with: ks orgs switch ${data.id}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("switch <orgId>")
    .description("Switch active organization")
    .action(async (orgId) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        await client.orgs.switch(orgId);
        if (json) {
          outputJson({ switched: true, activeOrgId: orgId });
        } else {
          console.log(`Switched to org: ${orgId}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("info [orgId]")
    .description("Get organization details")
    .action(async (orgId) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        if (orgId) {
          const data = await client.orgs.get(orgId);
          if (json) { outputJson(data); } else { formatObject(data); }
        } else {
          // Show current org info via /accounts/me
          const data = await client.account.me();
          if (json) { outputJson(data); } else {
            formatObject({
              name: data.name,
              tier: data.tier,
              type: data.type || "personal",
              slug: data.slug,
              role: data.teamRole,
              activeOrgId: data.activeOrgId,
              orgCount: data.orgs?.length || 1,
            });
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("members")
    .description("List team members in current organization")
    .action(async () => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.teams.members();
        if (json) {
          outputJson(data);
        } else {
          console.log("Team Members:");
          formatTable(data.members || [], [
            { key: "email", header: "Email" },
            { key: "role", header: "Role" },
            { key: "isOwner", header: "Owner" },
          ]);
          if (data.invitations?.length) {
            console.log("\nPending Invitations:");
            formatTable(data.invitations, [
              { key: "email", header: "Email" },
              { key: "role", header: "Role" },
              { key: "status", header: "Status" },
            ]);
          }
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("invite <email>")
    .description("Invite a member to the current organization")
    .option("--role <role>", "Role: admin, member, or viewer", "member")
    .action(async (email, opts) => {
      const json = program.opts().json;
      try {
        const client = createClient();
        const data = await client.teams.invite({ email, role: opts.role });
        if (json) {
          outputJson(data);
        } else {
          console.log(`Invitation sent to ${email} (role: ${opts.role})`);
          console.log(`Accept URL: ${data.acceptUrl}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  orgs
    .command("delete <orgId>")
    .description("Delete an organization (owner only, cannot delete personal workspace)")
    .action(async (orgId) => {
      const { json, yes } = program.opts();
      try {
        const ok = await confirm(`Delete organization ${orgId}? This cannot be undone.`, { yes, json });
        if (!ok) {
          console.log("Aborted.");
          return;
        }
        const client = createClient();
        await client.orgs.delete(orgId);
        if (json) {
          outputJson({ deleted: true, orgId });
        } else {
          success(`Organization ${orgId} deleted.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
