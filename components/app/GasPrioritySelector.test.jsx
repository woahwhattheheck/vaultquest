import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GasPrioritySelector from "./GasPrioritySelector";

describe("GasPrioritySelector — Stellar fee isolation (#123)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it("fetches fee_stats from Stellar testnet Horizon and renders stroops, source ledger, and freshness", async () => {
    global.fetch = vi.fn().mockImplementation(async (url) => {
      if (String(url).includes("fee_stats")) {
        return new Response(
          JSON.stringify({
            last_ledger: 5432100,
            last_ledger_base_fee: 120,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const onChange = vi.fn();
    render(
      <GasPrioritySelector
        network="stellar"
        networkType="testnet"
        nativeBalance={25.0}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("120 stroops");
    });
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#5432100");
    expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
    expect(screen.queryByText(/\bwei\b/i)).toBeNull();
    expect(screen.queryByText(/avalanche c-chain/i)).toBeNull();
    expect(screen.getByTestId("metric-base-fee").textContent).toMatch(/stroops/i);
    expect(screen.getByTestId("metric-base-fee").textContent).not.toMatch(/wei/i);

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Stellar");
    expect(lastCall.payload.type).toBe("stellar");
    expect(lastCall.payload.feeStroops).toBe(120);
    expect(lastCall.payload.sourceLedger).toBe("5432100");
    expect(lastCall.isStale).toBe(false);
  });

  it("targets Stellar mainnet Horizon when networkType is mainnet", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 998877, last_ledger_base_fee: 100 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <GasPrioritySelector network="stellar" networkType="mainnet" nativeBalance={50.0} />,
    );

    await waitFor(() => {
      expect(requestedUrl).toContain("https://horizon.stellar.org/fee_stats");
    });
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#998877");
  });

  it("respects custom Horizon URL override", async () => {
    let requestedUrl = "";
    global.fetch = vi.fn().mockImplementation(async (url) => {
      requestedUrl = String(url);
      return new Response(
        JSON.stringify({ last_ledger: 112233, last_ledger_base_fee: 150 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    render(
      <GasPrioritySelector
        network="stellar"
        customHorizonUrl="https://my-custom-horizon.org"
      />,
    );

    await waitFor(() => {
      expect(requestedUrl).toBe("https://my-custom-horizon.org/fee_stats");
    });
    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("150 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("#112233");
  });

  it("handles stale fee data when Horizon is unreachable", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("Network connection dropped"));
    const onChange = vi.fn();

    render(
      <GasPrioritySelector network="stellar" nativeBalance={10.0} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
    });
    expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    expect(screen.getByTestId("metric-ledger")).toHaveTextContent("Fallback ledger");
    expect(screen.getByTestId("fee-warning-alert")).toHaveTextContent(/stale fee notice|network warning/i);

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.isStale).toBe(true);
    expect(lastCall.payload.sourceLedger).toBe("fallback");
  });

  it("renders unsupported network state and disables tiers", async () => {
    render(<GasPrioritySelector network="stellar" isUnsupported />);

    expect(screen.getByTestId("unsupported-network-alert")).toHaveTextContent(
      /unsupported network/i,
    );
    expect(screen.getByTestId("tier-btn-low")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-medium")).toBeDisabled();
    expect(screen.getByTestId("tier-btn-high")).toBeDisabled();
  });

  it("includes Soroban simulationResourceFee in total stroops", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 654321, last_ledger_base_fee: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(
      <GasPrioritySelector
        network="stellar"
        simulationResourceFee={4900}
        onChange={onChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("100 stroops");
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.payload.feeStroops).toBe(5000);
    expect(lastCall.payload.resourceFeeStroops).toBe(4900);
    expect(lastCall.payload.feeBid).toBe("0.000500 XLM");
  });

  it("applies priority tier multipliers to the Stellar fee bid", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ last_ledger: 1000, last_ledger_base_fee: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(<GasPrioritySelector network="stellar" onChange={onChange} />);

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent("200 stroops");
    });

    fireEvent.click(screen.getByTestId("tier-btn-high"));

    await waitFor(() => {
      const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
      expect(lastCall.tier.key).toBe("high");
      expect(lastCall.payload.feeStroops).toBe(250);
      expect(lastCall.payload.feeBid).toBe("0.000025 XLM");
    });
  });

  it("keeps Avalanche fee math available when network is explicitly avalanche", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: "0x5d21dba00" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const onChange = vi.fn();

    render(
      <GasPrioritySelector network="avalanche" nativeBalance={2.5} onChange={onChange} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("metric-base-fee")).toHaveTextContent(/wei/i);
    });

    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall.network).toBe("Avalanche");
    expect(lastCall.payload.type).toBe("evm");
    expect(lastCall.payload.chain).toBe("Avalanche C-Chain");
  });

  describe("Stellar fee expiry while mounted", () => {
    async function renderTimedSelector(props = {}) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
      let ledger = 5432100;
      global.fetch = vi.fn().mockImplementation(async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("fee_stats")
              ? { last_ledger: ledger++, last_ledger_base_fee: 120 }
              : { result: "0x5d21dba00" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const onChange = vi.fn();
      let view;
      await act(async () => {
        view = render(<GasPrioritySelector {...props} onChange={onChange} />);
      });
      return { ...view, onChange };
    }

    async function advanceTime(ms) {
      await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    }

    function latest(onChange) {
      return onChange.mock.calls[onChange.mock.calls.length - 1][0];
    }

    it.each(["testnet", "mainnet"])(
      "expires the idle %s sample at 60 seconds in both the UI and parent payload",
      async (networkType) => {
        const { onChange } = await renderTimedSelector({ networkType });
        await advanceTime(59_999);
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
        expect(latest(onChange)).toMatchObject({ isStale: false, payload: { isStale: false } });

        await advanceTime(1);
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
        expect(screen.getByTestId("fee-warning-alert")).toBeInTheDocument();
        expect(latest(onChange)).toMatchObject({
          isStale: true,
          payload: { isStale: true, ageMs: 60_000, sourceLedger: "5432100" },
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps a refreshed sample fresh through the old deadline and expires at its own deadline", async () => {
      const { onChange } = await renderTimedSelector();
      await advanceTime(30_000);
      await act(async () => { fireEvent.click(screen.getByTestId("refresh-fees-btn")); });
      const refreshedAt = latest(onChange).freshness;
      expect(latest(onChange).sourceLedger).toBe("5432101");

      await advanceTime(30_000);
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
      expect(latest(onChange).isStale).toBe(false);
      await advanceTime(29_999);
      expect(latest(onChange).payload.isStale).toBe(false);
      await advanceTime(1);
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Stale data");
      expect(latest(onChange)).toMatchObject({
        freshness: refreshedAt,
        isStale: true,
        payload: { isStale: true, ageMs: 60_000, sourceLedger: "5432101" },
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it("restores freshness after an expired sample is refreshed", async () => {
      const { onChange } = await renderTimedSelector();
      await advanceTime(60_000);
      expect(latest(onChange).payload.isStale).toBe(true);
      await act(async () => { fireEvent.click(screen.getByTestId("refresh-fees-btn")); });
      expect(screen.getByTestId("metric-freshness")).toHaveTextContent("Live rate");
      expect(latest(onChange)).toMatchObject({
        isStale: false,
        payload: { isStale: false, ageMs: 0, sourceLedger: "5432101" },
      });
      await advanceTime(59_999);
      expect(latest(onChange).payload.isStale).toBe(false);
      await advanceTime(1);
      expect(latest(onChange).payload.isStale).toBe(true);
    });

    it.each(["unsupported", "avalanche"])(
      "stops the Stellar deadline when the selector becomes %s",
      async (state) => {
        const { onChange, rerender } = await renderTimedSelector();
        await advanceTime(30_000);
        await act(async () => {
          rerender(
            <GasPrioritySelector
              network={state === "avalanche" ? "avalanche" : "stellar"}
              isUnsupported={state === "unsupported"}
              onChange={onChange}
            />,
          );
        });
        const calls = onChange.mock.calls.length;
        expect(screen.getByTestId("metric-freshness")).toHaveTextContent(
          state === "unsupported" ? "Unsupported" : "Live rate",
        );
        await advanceTime(60_000);
        expect(onChange).toHaveBeenCalledTimes(calls);
        expect(latest(onChange).network).toBe(state === "avalanche" ? "Avalanche" : "Stellar");
      },
    );

    it("clears a pending deadline when the selector is unmounted", async () => {
      const { unmount } = await renderTimedSelector();
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
