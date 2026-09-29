"""Compares PPO against the safety controller and a conservative rate-based
heuristic on identical held-out traces (seeds disjoint from training)."""
import os
import sys
import numpy as np
from sb3_contrib import MaskablePPO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "envs"))
from live_webrtc_env import LiveWebRTCEnv, BITRATES, N_LEVELS  # noqa: E402

SAFETY_MARGIN = 0.8
N_EVAL = 200
EVAL_SEED_BASE = 90_000  # disjoint from training seeds (0..n_envs)

def rate_based(env, obs):
    share = env.gcc_estimate[0] / max(env.viewers, 1)
    best = 0
    for i, br in enumerate(BITRATES):
        if br <= share * SAFETY_MARGIN:
            best = i
    return [best] * env.viewers if env.viewers > 1 else best

def safety_controller(env, obs, previous_action=None):
    # Mirrors lib/policy/safety.ts at a coarse level: hold under impairment, probe up when stable.
    levels = list(env.levels)
    delivered = getattr(env, "_last_delivery", [1.0] * env.viewers)
    out = []
    for i, level in enumerate(levels):
        if delivered[i] < 0.75:
            out.append(max(0, level - 1))
        elif delivered[i] > 1.1 and (env.step_idx - env.last_switch[i]) * 2 > 6:
            out.append(min(N_LEVELS - 1, level + 1))
        else:
            out.append(level)
    return out if env.viewers > 1 else out[0]

def run_episode(viewers, seed, policy_fn, model=None):
    env = LiveWebRTCEnv(viewers=viewers, seed=seed, fixed_mode="balanced")
    obs, _ = env.reset(seed=seed)
    total_reward, freezes, switches = 0.0, 0, 0
    done = False
    prev_levels = list(env.levels)
    while not done:
        if model is not None:
            action, _ = model.predict(obs, deterministic=True, action_masks=env.action_masks())
        else:
            action = policy_fn(env, obs)
        obs, r, term, trunc, info = env.step(action)
        total_reward += r
        freezes += 1 if info["impairment"] >= 0.5 else 0
        switches += 1 if info["levels"] != prev_levels else 0
        prev_levels = info["levels"]
        done = term or trunc
    return {"reward": total_reward, "freeze_rate": freezes / env.step_idx, "switch_rate": switches / env.step_idx}

def summarize(name, results):
    r = np.mean([x["reward"] for x in results])
    fr = np.mean([x["freeze_rate"] for x in results])
    sw = np.mean([x["switch_rate"] for x in results])
    print(f"{name:>28s} | reward={r:7.2f} | freeze_rate={fr*100:5.1f}% | switch_rate={sw*100:5.1f}%")

def main():
    for viewers in (1, 2):
        print(f"\n=== viewers={viewers} ===")
        model_path = os.path.join(os.path.dirname(__file__), f"model_v{viewers}.zip")
        model = MaskablePPO.load(model_path) if os.path.exists(model_path) else None
        seeds = range(EVAL_SEED_BASE, EVAL_SEED_BASE + N_EVAL)

        if model:
            summarize("PPO", [run_episode(viewers, s, None, model=model) for s in seeds])
        summarize("Safety controller", [run_episode(viewers, s, safety_controller) for s in seeds])
        summarize("Rate-based heuristic", [run_episode(viewers, s, rate_based) for s in seeds])

if __name__ == "__main__":
    main()
