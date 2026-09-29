"""Extracts the trained actor network into the JSON shape lib/policy/mlp.ts
expects: alternating {W, b} layers, tanh between hidden layers, linear last
layer (SB3's MlpExtractor + action_net — no VecNormalize, since build_obs
already normalizes everything, so there's no running mean/std to export)."""
import json
import os
import sys
from datetime import datetime, timezone
import torch.nn as nn
from sb3_contrib import MaskablePPO

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "envs"))

SPEC_PATH = os.path.join(os.path.dirname(__file__), "..", "shared", "obs-spec.json")

def extract_layers(model: MaskablePPO):
    layers = []
    for module in model.policy.mlp_extractor.policy_net:
        if isinstance(module, nn.Linear):
            layers.append({"W": module.weight.detach().cpu().numpy().tolist(),
                            "b": module.bias.detach().cpu().numpy().tolist()})
    action_layer = model.policy.action_net
    layers.append({"W": action_layer.weight.detach().cpu().numpy().tolist(),
                    "b": action_layer.bias.detach().cpu().numpy().tolist()})
    return layers

def main(viewers: int):
    model_path = os.path.join(os.path.dirname(__file__), f"model_v{viewers}.zip")
    model = MaskablePPO.load(model_path)
    with open(SPEC_PATH) as f:
        obs_spec = json.load(f)

    artifact = {
        "schemaVersion": 3,
        "kind": "mlp",
        "id": f"ppo-v{viewers}-{int(datetime.now(timezone.utc).timestamp())}",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "profile": {"name": f"PPO ({viewers} viewer{'s' if viewers > 1 else ''})",
                    "rewardModes": obs_spec["rewardModes"], "viewers": [viewers]},
        "obsSpec": obs_spec,
        "layers": extract_layers(model),
        "evaluation": {"averageReward": 0.0, "averageLevel": 0.0, "freezeRate": 0.0, "switchRate": 0.0, "underutilization": 0.0},
    }
    out_path = os.path.join(os.path.dirname(__file__), f"policy_v{viewers}.json")
    with open(out_path, "w") as f:
        json.dump(artifact, f)
    print(f"Wrote {out_path} — run evaluate.py first and paste real numbers into 'evaluation' if you want them shown in /train.")

if __name__ == "__main__":
    for v in (1, 2):
        main(v)
