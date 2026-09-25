import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AccountPage from "./page";

const mockWagmi = vi.hoisted(() => ({
  useAccount: vi.fn(),
  useChainId: vi.fn(),
}));

vi.mock("wagmi", () => mockWagmi);
vi.mock("@rainbow-me/rainbowkit", () => ({
  useConnectModal: () => ({ openConnectModal: vi.fn() }),
}));
vi.mock("@/lib/wagmi", () => ({
  SUPPORTED_CHAINS: [
    { id: 43114, name: "Avalanche" },
    { id: 43113, name: "Avalanche Fuji" },
  ],
}));
vi.mock("@/components/hooks/useYieldCounter", () => ({
  useYieldCounter: () => 12.34,
}));
vi.mock("@/components/app/VaultOnboardingTour", () => ({
  __esModule: true,
  default: () => null,
  useRestartTour: () => vi.fn(),
}));

vi.mock("@/components/app/AccountPositionSummary", () => ({
  default: () => <div>position-summary</div>,
}));
vi.mock("@/components/app/UserDepositsList", () => ({
  default: () => <div>deposits</div>,
}));
vi.mock("@/components/app/ProfileEditor", () => ({
  default: () => <div>profile</div>,
}));
vi.mock("@/components/app/LevelOnboarding", () => ({
  default: () => <div>level</div>,
}));
vi.mock("@/components/app/BadgesGallery", () => ({
  default: () => <div>badges</div>,
}));
vi.mock("@/components/app/PrizeChart", () => ({
  default: () => <div>chart</div>,
}));
vi.mock("@/components/app/VaultNotificationSettings", () => ({
  default: () => <div>notifications</div>,
}));
vi.mock("@/components/app/WalletReconnectGuidance", () => ({
  default: ({ isNetworkMismatch, isDisconnected }) => (
    <div>
      {isNetworkMismatch ? "mismatch-guidance" : null}
      {isDisconnected ? "disconnect-guidance" : null}
    </div>
  ),
}));
vi.mock("@/components/app/SecurityTipsPanel", () => ({
  default: () => <div>security</div>,
}));

describe("AccountPage", () => {
  beforeEach(() => {
    delete window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__;
    window.history.replaceState({}, "", "/app/account");
    mockWagmi.useAccount.mockReturnValue({ isConnected: false });
    mockWagmi.useChainId.mockReturnValue(43113);
  });

  it("renders the disconnected empty state from wallet providers", async () => {
    render(<AccountPage />);
    expect(await screen.findByText(/Wallet not connected/i)).toBeInTheDocument();
  });

  it("renders the connected dashboard from wagmi without URL fixtures", async () => {
    mockWagmi.useAccount.mockReturnValue({ isConnected: true });
    render(<AccountPage />);
    expect(await screen.findByText("position-summary")).toBeInTheDocument();
    expect(screen.queryByText(/Wallet not connected/i)).not.toBeInTheDocument();
  });

  it("derives network mismatch from the live chain id", async () => {
    mockWagmi.useAccount.mockReturnValue({ isConnected: true });
    mockWagmi.useChainId.mockReturnValue(1);
    render(<AccountPage />);
    expect(await screen.findByText("mismatch-guidance")).toBeInTheDocument();
  });

  it("applies mockConnected when the E2E runtime flag is present", async () => {
    window.__VQ_ALLOW_ACCOUNT_TEST_FIXTURES__ = true;
    window.history.replaceState({}, "", "/app/account?mockConnected=true");
    render(<AccountPage />);
    await waitFor(() => {
      expect(screen.getByText("position-summary")).toBeInTheDocument();
    });
  });
});
