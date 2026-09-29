"""
Live P2P adaptation environment. Unlike ABREnv (single VOD chunk request),
each step is one 2-second Flux adaptation cycle: the agent sets a target
level per viewer, a congestion-controller model decides how much of that
target actually gets delivered given uplink/downlink/contention, and the
reward is Flux's own QoE formula (ported verbatim from lib/qlearning.ts).
"""
import json
import os
import numpy as np
import gymnasium as gym
from gymnasium import spaces

from network_sim import NetworkTrace

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "shared", "obs-spec.json")
with open(SPEC_PATH) as f:
    OBS_SPEC = json.load(f)

BITRATES = [250_000, 600_000, 1_200_000, 2_500_000, 4_500_000]  # QUALITY_LEVELS videoBitrate, lib/levels.ts
N_LEVELS = len(BITRATES)
REWARD_WEIGHTS = {
    "balanced": {"quality": 1.45, "freeze": 3.5, "switching": 0.35, "underuse": 0.65},
    "quality": {"quality": 1.9, "freeze": 2.8, "switching": 0.2, "underuse": 0.85},
    "stall-avoidant": {"quality": 1.1, "freeze": 4.75, "switching": 0.4, "underuse": 0.35},
}
MODES = OBS_SPEC["rewardModes"]
N = OBS_SPEC["normalization"]
NEUTRAL = OBS_SPEC["neutralSlot"]
EPISODE_STEPS = 200
STEP_SEC = 2.0
GCC_RAMP_UP = 0.12    # congestion-controller estimate rises slowly...
GCC_BACK_OFF = 0.55   # ...and backs off fast, modeling real WebRTC GCC behavior

def reward_for(levels, previous, capacity, impairment, mode):
    w = REWARD_WEIGHTS[mode]
    targets = [BITRATES[l] for l in levels]
    requested = sum(targets)
    quality = sum(l / (N_LEVELS - 1) for l in levels) / len(levels)
    switches = sum(abs(l - p) / 4 for l, p in zip(levels, previous)) / len(levels)
    underuse = max(0.0, capacity - requested) / max(capacity, 1.0)
    overload_ratio = max(0.0, requested - capacity) / max(capacity, 1.0)
    overload_severity = min(1.0, max(0.0, overload_ratio - 0.05) / 0.45)
    measured = impairment if isinstance(impairment, float) else (1.0 if impairment else 0.0)
    penalty = w["freeze"] * max(measured, overload_severity)
    return w["quality"] * quality - penalty - w["switching"] * switches - w["underuse"] * underuse

def clamp(x, lo, hi):
    return min(hi, max(lo, x))

class LiveWebRTCEnv(gym.Env):
    """viewers is fixed per instance (train one model per room size, or wrap
    two instances with a shared policy — see train.py)."""

    def __init__(self, viewers: int = 2, seed=None, fixed_mode: str | None = None):
        super().__init__()
        assert viewers in (1, 2)
        self.viewers = viewers
        self.fixed_mode = fixed_mode
        self.action_space = spaces.MultiDiscrete([N_LEVELS] * viewers) if viewers == 2 else spaces.Discrete(N_LEVELS)
        self.observation_space = spaces.Box(low=-5.0, high=5.0, shape=(len(OBS_SPEC["features"]),), dtype=np.float32)
        self._rng = np.random.default_rng(seed)
        self.reset(seed=seed)

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        self.uplink = NetworkTrace(self._rng)
        self.downlinks = [NetworkTrace(self._rng) for _ in range(self.viewers)]
        self.mode = self.fixed_mode or self._rng.choice(MODES)
        self.step_idx = 0
        self.levels = [N_LEVELS // 2] * self.viewers
        self.last_switch = [0] * self.viewers
        self.gcc_estimate = [BITRATES[self.levels[0]] * self.viewers]  # single shared uplink estimate
        self.delivery_hist = [[NEUTRAL["delivery"]] * OBS_SPEC["historyLen"] for _ in range(self.viewers)]
        self.rtt_hist = [[NEUTRAL["rtt"]] * OBS_SPEC["historyLen"] for _ in range(self.viewers)]
        return self._obs(), {}

    def action_masks(self):
        # No source-capability masking in simulation; every level is legal.
        # (sb3-contrib MaskablePPO calls this each step — return all-True.)
        if self.viewers == 1:
            return np.ones(N_LEVELS, dtype=bool)
        return np.ones(N_LEVELS * 2, dtype=bool)

    def _obs(self):
        out = [self.viewers / OBS_SPEC["maxViewers"]]

        def slot(i, key, scale=1.0, cap=2.0):
            if i < self.viewers:
                return clamp(getattr(self, key)[i] / scale, 0, cap)
            return clamp(NEUTRAL[key.rstrip("s")] / scale, 0, cap) if key.rstrip("s") in NEUTRAL else 0.0

        headroom = [self._headroom(i) if i < self.viewers else NEUTRAL["headroom"] for i in range(2)]
        delivery = [self._delivery(i) if i < self.viewers else NEUTRAL["delivery"] for i in range(2)]
        rtt = [self._rtt(i) if i < self.viewers else NEUTRAL["rtt"] for i in range(2)]
        loss = [self._loss(i) if i < self.viewers else NEUTRAL["loss"] for i in range(2)]
        jitter = [self._jitter(i) if i < self.viewers else NEUTRAL["jitter"] for i in range(2)]
        freeze = [1.0 if (i < self.viewers and delivery[i] < 0.6) else 0.0 for i in range(2)]
        level = [self.levels[i] if i < self.viewers else NEUTRAL["level"] for i in range(2)]
        switch_age = [((self.step_idx - self.last_switch[i]) * STEP_SEC) if i < self.viewers else NEUTRAL["switchAge"] for i in range(2)]

        out += [clamp(h / N["headroomScale"], 0, 2) for h in headroom]
        out += [clamp(d, 0, 2) for d in delivery]
        out += [clamp(r / N["rttMsScale"], 0, 2) for r in rtt]
        out += [clamp(l, 0, 1) for l in loss]
        out += [clamp(j / N["jitterSecScale"], 0, 2) for j in jitter]
        out += freeze
        out += [l / N["levelMax"] for l in level]
        out += [clamp(s / N["switchAgeSecScale"], 0, 1) for s in switch_age]

        agg_target = sum(BITRATES[self.levels[i]] for i in range(self.viewers)) or 1
        out.append(clamp(self.gcc_estimate[0] / N["aggregateHeadroomScale"] / max(agg_target, 1), 0, 2))

        for i in range(2):
            hist = self.delivery_hist[i] if i < self.viewers else [NEUTRAL["delivery"]] * OBS_SPEC["historyLen"]
            out += [clamp(v, 0, 2) for v in hist]
        for i in range(2):
            hist = self.rtt_hist[i] if i < self.viewers else [NEUTRAL["rtt"]] * OBS_SPEC["historyLen"]
            out += [clamp(v / N["rttMsScale"], 0, 2) for v in hist]

        out += [1.0 if self.mode == m else 0.0 for m in MODES]
        return np.array(out, dtype=np.float32)

    def _headroom(self, i):
        return self.gcc_estimate[0] / self.viewers / max(BITRATES[self.levels[i]], 1)

    def _delivery(self, i):
        return getattr(self, "_last_delivery", [1.0] * self.viewers)[i]

    def _rtt(self, i):
        return getattr(self, "_last_rtt", [60.0] * self.viewers)[i]

    def _loss(self, i):
        return getattr(self, "_last_loss", [0.01] * self.viewers)[i]

    def _jitter(self, i):
        return getattr(self, "_last_jitter", [0.02] * self.viewers)[i]

    def step(self, action):
        levels = [int(action)] if self.viewers == 1 else [int(a) for a in action]
        previous = list(self.levels)

        downlink_mbps = [self.downlinks[i].throughput_mbps(STEP_SEC) for i in range(self.viewers)]
        uplink_mbps = self.uplink.throughput_mbps(STEP_SEC)

        # GCC-style estimate: ramps up slowly toward measured uplink, backs off fast on overload.
        requested_total = sum(BITRATES[l] for l in levels)
        target_estimate = uplink_mbps * 1e6
        alpha = GCC_RAMP_UP if target_estimate > self.gcc_estimate[0] else GCC_BACK_OFF
        self.gcc_estimate[0] += alpha * (target_estimate - self.gcc_estimate[0])

        share = self.gcc_estimate[0] / max(self.viewers, 1)
        delivered, rtt, loss, jitter = [], [], [], []
        for i, level in enumerate(levels):
            target = BITRATES[level]
            capacity = min(share, downlink_mbps[i] * 1e6)
            ratio = min(1.2, capacity / max(target, 1))
            delivered.append(ratio)
            queue_pressure = max(0.0, 1.0 - ratio)
            rtt.append(40 + 260 * queue_pressure + self._rng.normal(0, 8))
            loss.append(max(0.0, 0.015 * queue_pressure + self._rng.normal(0, 0.004)))
            jitter.append(max(0.0, 0.01 + 0.08 * queue_pressure + self._rng.normal(0, 0.005)))
            self.delivery_hist[i] = (self.delivery_hist[i] + [ratio])[-OBS_SPEC["historyLen"]:]
            self.rtt_hist[i] = (self.rtt_hist[i] + [rtt[-1]])[-OBS_SPEC["historyLen"]:]
            if level != previous[i]:
                self.last_switch[i] = self.step_idx

        self._last_delivery, self._last_rtt, self._last_loss, self._last_jitter = delivered, rtt, loss, jitter
        impairment = max(0.0, min(1.0, max(0.0, 0.85 - min(delivered)) / 0.5 + max(loss) * 2))

        reward = reward_for(levels, previous, self.gcc_estimate[0], impairment, self.mode)
        self.levels = levels
        self.step_idx += 1
        terminated = self.step_idx >= EPISODE_STEPS
        info = {"reward": reward, "impairment": impairment, "levels": levels}
        return self._obs(), reward, terminated, False, info
