/**
 * CloudAccountsList — the dashboard surface for per-account safety config
 * (productionProtected badge/toggle + auto-kill categories + thresholds).
 * First web-app component tests; guards the UI that PRs #33/#34 added.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";

const listCloudAccounts = vi.fn();
const updateCloudAccount = vi.fn().mockResolvedValue({});
vi.mock("../../api/client", () => ({
  api: {
    listCloudAccounts: () => listCloudAccounts(),
    updateCloudAccount: (id: string, data: any) => updateCloudAccount(id, data),
    updateCloudAccountCredentials: vi.fn().mockResolvedValue({}),
    deleteCloudAccount: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("../../context/OrgContext", () => ({ useOrg: () => ({ orgVersion: 0 }) }));
vi.mock("../../hooks/useCan", () => ({ useCan: () => () => true }));
vi.mock("../../components/ViolationChart", () => ({ ViolationChart: () => null }));
vi.mock("../../components/ErrorState", () => ({ ErrorState: ({ message }: any) => <div>{message}</div> }));

import { CloudAccountsList } from "./CloudAccountsList";

const NEON = {
  id: "a-neon", provider: "neon", name: "Prod Neon", providerAccountId: "icy-night",
  lastCheckStatus: "ok", productionProtected: true, autoKillCategories: ["cost"],
  thresholds: { neonDailyCostUSD: 5, neonStorageMB: 400 },
};
const CF = {
  id: "a-cf", provider: "cloudflare", name: "Prod CF", providerAccountId: "acct-1",
  lastCheckStatus: "ok", productionProtected: true, autoKillCategories: ["cost"], thresholds: {},
};

const renderList = () => render(<MemoryRouter><CloudAccountsList /></MemoryRouter>);
const rowOf = (name: string) => screen.getByText(name).closest("div[style]")!.parentElement!.parentElement!;

beforeEach(() => {
  vi.clearAllMocks();
  listCloudAccounts.mockResolvedValue({ accounts: [NEON, CF] });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

describe("CloudAccountsList — productionProtected + settings", () => {
  it("shows the prod-protected badge ONLY on managed-DB accounts", async () => {
    renderList();
    await screen.findByText("Prod Neon");

    const badges = screen.getAllByText(/prod-protected/i);
    expect(badges).toHaveLength(1); // neon only, not cloudflare
    // The badge lives in the neon row, not the CF row.
    expect(within(rowOf("Prod Neon")).getByText(/prod-protected/i)).toBeInTheDocument();
    expect(within(rowOf("Prod CF")).queryByText(/prod-protected/i)).toBeNull();
  });

  it("Disable protection confirms, then PUTs productionProtected:false", async () => {
    renderList();
    await screen.findByText("Prod Neon");

    await userEvent.click(screen.getByText("Disable protection"));
    expect(window.confirm).toHaveBeenCalled();
    expect(updateCloudAccount).toHaveBeenCalledWith("a-neon", { productionProtected: false });
  });

  it("Settings form saves auto-kill categories + edited thresholds", async () => {
    renderList();
    await screen.findByText("Prod Neon");

    // Open the neon account's Settings (first Settings button = first account).
    await userEvent.click(within(rowOf("Prod Neon")).getByText("Settings"));
    await screen.findByText(/Monitoring settings for Prod Neon/i);

    // Add the "Storage" category (cost is on by default).
    await userEvent.click(screen.getByRole("button", { name: /Storage/i }));
    // Edit a threshold (neonDailyCostUSD: 5 -> 12).
    const costInput = screen.getByDisplayValue("5");
    fireEvent.change(costInput, { target: { value: "12" } });

    await userEvent.click(screen.getByText("Save settings"));

    expect(updateCloudAccount).toHaveBeenCalledTimes(1);
    const [id, payload] = updateCloudAccount.mock.calls[0];
    expect(id).toBe("a-neon");
    expect(payload.autoKillCategories).toEqual(expect.arrayContaining(["cost", "storage"]));
    expect(payload.thresholds).toEqual({ neonDailyCostUSD: 12, neonStorageMB: 400 });
  });

  it("renders an empty state when there are no accounts", async () => {
    listCloudAccounts.mockResolvedValue({ accounts: [] });
    renderList();
    expect(await screen.findByText(/No cloud accounts connected yet/i)).toBeInTheDocument();
  });
});
