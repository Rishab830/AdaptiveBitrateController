// lib/policy/ppo.ts
import { forward, maskedArgmax } from "./mlp";
import { buildObs, OBS_SPEC, type ObsInput } from "./spec";
import { isUnsafeJump, safetyDecision } from "./safety";
import { discretizeState } from "../qlearning";
import type { MlpPolicyArtifact, PeerTelemetry, RewardMode } from "../types";
import type { Decision } from "./qtable";

/**
 * Runs the exported PPO policy for one decision cycle. The model's action_net
 * outputs concatenated per-viewer logit blocks (5 per viewer, in slot order) —
 * that's how sb3-contrib's MaskablePPO lays out a MultiDiscrete([5, 5]) head,
 * so no extra reshaping is needed beyond slicing.
 */
export function decidePpo(
  artifact: MlpPolicyArtifact, input: ObsInput, telemetry: PeerTelemetry[],
  current: number[], switchAgeSec: number, viewers: 1 | 2,
  allowedLevels: number[][], // per-viewer list of source-capability-masked level ids
): Decision {
  const obs = buildObs(input);
  const logits = forward(artifact.layers, obs);
  const levels: number[] = [];
  for (let v = 0; v < viewers; v++) {
    const branch = logits.slice(v * OBS_SPEC.actionLevels, (v + 1) * OBS_SPEC.actionLevels);
    const mask = Array.from({ length: OBS_SPEC.actionLevels }, (_, id) => allowedLevels[v]?.includes(id) ?? true);
    levels.push(maskedArgmax(branch, mask));
  }

  const state = discretizeState(telemetry, current, switchAgeSec);
  if (isUnsafeJump(current, levels, state.freeze === 1)) {
    const safe = safetyDecision(state, viewers, input.mode as RewardMode);
    return { levels: safe.levels, qValue: undefined, source: "safety", state };
  }
  return { levels, qValue: Math.max(...logits), source: "ppo", state };
}
