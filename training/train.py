"""Trains one MaskablePPO model per room size (1 and 2 viewers). Reward mode
is randomized per episode (see LiveWebRTCEnv.reset), and the mode one-hot in
the observation is how the single model learns to serve all three objectives."""
import os
from sb3_contrib import MaskablePPO
from sb3_contrib.common.wrappers import ActionMasker
from stable_baselines3.common.vec_env import DummyVecEnv, SubprocVecEnv

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "envs"))
from live_webrtc_env import LiveWebRTCEnv  # noqa: E402

def mask_fn(env):
    return env.action_masks()

def make_env(viewers, seed):
    def _init():
        env = LiveWebRTCEnv(viewers=viewers, seed=seed)
        return ActionMasker(env, mask_fn)
    return _init

def train_for_viewers(viewers: int, total_timesteps: int = 1_500_000, n_envs: int = 8):
    VecCls = SubprocVecEnv if n_envs > 1 else DummyVecEnv
    env = VecCls([make_env(viewers, seed=s) for s in range(n_envs)])
    model = MaskablePPO(
        "MlpPolicy", env, learning_rate=3e-4, n_steps=256, batch_size=256, n_epochs=10,
        gamma=0.99, gae_lambda=0.95, ent_coef=0.01, policy_kwargs=dict(net_arch=[128, 128]), verbose=1,
    )
    print(f"Training PPO for viewers={viewers}, {total_timesteps} timesteps, {n_envs} envs...")
    model.learn(total_timesteps=total_timesteps)
    out = os.path.join(os.path.dirname(__file__), f"model_v{viewers}.zip")
    model.save(out)
    print(f"Saved {out}")
    return model

if __name__ == "__main__":
    train_for_viewers(1)
    train_for_viewers(2)
