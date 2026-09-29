"""Regime-switching synthetic network-condition generator, reused for both
uplink (host) and downlink (per-viewer) traces in the live env."""
import numpy as np

REGIMES = {
    "excellent": (18.0, 3.0, 8, 20), "good": (8.0, 1.5, 6, 18),
    "fair": (3.5, 1.0, 5, 15), "poor": (1.2, 0.4, 4, 12), "very_poor": (0.4, 0.15, 3, 8),
}
REGIME_NAMES = list(REGIMES.keys())
TRANSITIONS = {
    "excellent": {"excellent": 0.55, "good": 0.35, "fair": 0.08, "poor": 0.01, "very_poor": 0.01},
    "good": {"excellent": 0.20, "good": 0.45, "fair": 0.25, "poor": 0.08, "very_poor": 0.02},
    "fair": {"excellent": 0.05, "good": 0.25, "fair": 0.40, "poor": 0.22, "very_poor": 0.08},
    "poor": {"excellent": 0.01, "good": 0.07, "fair": 0.27, "poor": 0.45, "very_poor": 0.20},
    "very_poor": {"excellent": 0.01, "good": 0.02, "fair": 0.12, "poor": 0.35, "very_poor": 0.50},
}

class NetworkTrace:
    def __init__(self, rng: np.random.Generator, spike_prob=0.03, drop_prob=0.02):
        self.rng = rng
        self.spike_prob, self.drop_prob = spike_prob, drop_prob
        self.regime = self.rng.choice(REGIME_NAMES, p=[0.25, 0.3, 0.25, 0.15, 0.05])
        self._set_duration()
        self.t_in_regime = 0.0

    def _set_duration(self):
        _, _, dmin, dmax = REGIMES[self.regime]
        self.regime_duration = self.rng.uniform(dmin, dmax)

    def _maybe_transition(self, dt):
        self.t_in_regime += dt
        if self.t_in_regime >= self.regime_duration:
            probs = TRANSITIONS[self.regime]
            self.regime = self.rng.choice(list(probs.keys()), p=list(probs.values()))
            self.t_in_regime = 0.0
            self._set_duration()

    def throughput_mbps(self, dt: float) -> float:
        self._maybe_transition(dt)
        mean, std, _, _ = REGIMES[self.regime]
        val = self.rng.normal(mean, std)
        r = self.rng.random()
        if r < self.drop_prob: val *= self.rng.uniform(0.05, 0.3)
        elif r < self.drop_prob + self.spike_prob: val *= self.rng.uniform(1.5, 2.2)
        return float(max(0.05, val))
