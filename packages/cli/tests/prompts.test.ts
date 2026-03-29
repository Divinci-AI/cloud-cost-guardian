import { describe, it, expect } from "vitest";
import { confirm } from "../src/prompts.js";

describe("confirm", () => {
  it("returns true when yes option is set", async () => {
    const result = await confirm("Delete?", { yes: true });
    expect(result).toBe(true);
  });

  it("returns true when json option is set", async () => {
    const result = await confirm("Delete?", { json: true });
    expect(result).toBe(true);
  });

  it("returns true when both yes and json are set", async () => {
    const result = await confirm("Delete?", { yes: true, json: true });
    expect(result).toBe(true);
  });
});
