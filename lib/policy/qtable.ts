// lib/policy/qtable.ts
import { discretizeState, selectAction, stateKey } from "../qlearning";
import type { DiscreteState, PeerTelemetry, QTableArtifact, RewardMode } from "../types";

export interface Decision {
  levels: number[];
  qValue?: number;
  source: "qtable" | "ppo" | "safety" | "manual";
  state: DiscreteState;
}

export function decideQTable(
  policy: QTableArtifact | undefined, telemetry: PeerTelemetry[], current: number[],
  switchAgeSec: number, viewers: 1 | 2, mode: RewardMode,
): Decision {
  const state = discretizeState(telemetry, current, switchAgeSec);
  const result = selectAction(policy, state, viewers, mode);
  return { levels: result.levels, qValue: result.qValue, source: result.fallback ? "safety" : "qtable", state };
}

export { stateKey };
