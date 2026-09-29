import type { DiscreteState, PolicyProfile } from "../types";

export interface SafetyDecision { levels: number[]; qValue: 0; fallback: true; }

export function safetyDecision(
  state: DiscreteState, viewers: 1 | 2, mode: PolicyProfile["rewardMode"] = "balanced",
): SafetyDecision {
  let safeLevel = state.currentA;
  const unhealthy = state.freeze === 1 || state.headroom === 0 || state.delivery === 0 || state.loss >= 3;
  if (unhealthy) {
    safeLevel -= mode === "stall-avoidant" ? 2 : 1;
  } else {
    const stableEnough = state.delivery >= 2 && state.loss <= 1;
    const shouldProbe = mode === "quality" ? state.switchAge >= 1
      : mode === "balanced" ? state.switchAge === 2
      : state.headroom >= 3 && state.switchAge === 2;
    if (stableEnough && shouldProbe) safeLevel += 1;
    if (state.headroom >= 3 && state.delivery >= 2) safeLevel += 1;
  }
  safeLevel = Math.max(0, Math.min(4, safeLevel));
  return { levels: Array(viewers).fill(safeLevel) as number[], qValue: 0, fallback: true };
}

/** Guard used after a PPO decision: never let a learned policy jump more than
 * two levels during an active freeze — fall back to the safety controller instead. */
export function isUnsafeJump(from: number[], to: number[], freeze: boolean) {
  if (!freeze) return false;
  return to.some((level, index) => Math.abs(level - (from[index] ?? level)) > 2);
}
