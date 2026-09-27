import { beforeAll, describe, expect, it } from "vitest";
import { decodeAction, discretizeState, encodeAction, rewardFor, selectAction, stateKey, trainPolicy } from "./qlearning";
import type { PeerTelemetry, PolicyProfile, QTableArtifact } from "./types";

beforeAll(() => {
  if (!globalThis.crypto.randomUUID) Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => "test-id" });
});

const telemetry: PeerTelemetry = {
  timestamp: 1, outboundBitrate: 900_000, inboundBitrate: 850_000, availableOutgoingBitrate: 2_000_000,
  rtt: 100, packetLoss: 0.02, jitter: 0.04, framesDropped: 0, framesDecoded: 60, freezeCount: 0, jitterBufferDelay: 0.1,
};

const profile: PolicyProfile = {
  id: "test", name: "Test", rewardMode: "balanced", episodes: 1200, seed: 7, minBandwidth: 300_000,
  maxBandwidth: 5_000_000, volatility: 0.3, latency: 80, loss: 0.02, viewers: 2,
};

describe("state and action representation", () => {
  it("discretizes measured path statistics deterministically", () => {
    const state = discretizeState([telemetry], [2], 6);
    expect(state).toMatchObject({ headroom: 3, delivery: 1, rtt: 1, loss: 1, jitter: 1, freeze: 0, currentA: 2, switchAge: 1 });
    expect(stateKey(state).split("|")).toHaveLength(10);
  });

  it("round-trips every two-viewer joint action", () => {
    for (let a = 0; a < 5; a++) for (let b = 0; b < 5; b++) expect(decodeAction(encodeAction(a, b, 2), 2)).toEqual([a, b]);
  });
});

describe("QoE and learning", () => {
  it("penalizes an overloaded action more than a sustainable action", () => {
    expect(rewardFor([4], [2], 500_000, true, "balanced")).toBeLessThan(rewardFor([1], [1], 1_000_000, false, "balanced"));
  });

  it("produces reproducible tables and metrics for a fixed seed", () => {
    const first = trainPolicy(profile);
    const second = trainPolicy(profile);
    expect(first.qTable).toEqual(second.qTable);
    expect(first.evaluation).toEqual(second.evaluation);
    expect(Object.keys(first.qTable).length).toBeGreaterThan(100);
  });

  it("uses table values for known states and flags unseen-state fallback", () => {
    const state = discretizeState([telemetry], [2], 6);
    const values = Array(25).fill(0); values[19] = 4.2;
    const policy = { qTable: { [stateKey(state)]: values } } as QTableArtifact;
    expect(selectAction(policy, state, 2)).toEqual({ levels: [3, 4], qValue: 4.2, fallback: false });
    expect(selectAction(undefined, state, 2).fallback).toBe(true);
  });

  it("probes above Economy after a stable interval without a trained table", () => {
    const state = { ...discretizeState([telemetry], [0], 12), headroom: 2, delivery: 3, loss: 0, freeze: 0, switchAge: 2 };
    expect(selectAction(undefined, state, 1, "balanced").levels).toEqual([1]);
  });
});
