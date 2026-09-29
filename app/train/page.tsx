"use client";

import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/header";
import { deletePolicy, listPolicies, savePolicy, setActivePolicy } from "@/lib/policy-storage";
import { isMlpPolicy } from "@/lib/types";
import type { MlpPolicyArtifact, PolicyArtifact, PolicyProfile, TrainingProgress } from "@/lib/types";

const defaults: PolicyProfile = {
  id: "stable-broadband", name: "Stable broadband", rewardMode: "balanced", episodes: 10_000, seed: 42,
  minBandwidth: 1_000_000, maxBandwidth: 10_000_000, volatility: 0.2, latency: 55, loss: 0.01, viewers: 2,
};

export default function TrainPage() {
  const [profile, setProfile] = useState(defaults);
  const [policies, setPolicies] = useState<PolicyArtifact[]>([]);
  const [progress, setProgress] = useState<TrainingProgress | null>(null);
  const [error, setError] = useState("");
  const [policyAction, setPolicyAction] = useState("");
  const worker = useRef<Worker | null>(null);
  const refresh = () => listPolicies().then(setPolicies).catch(() => setPolicies([]));
  useEffect(() => { void refresh(); return () => worker.current?.terminate(); }, []);

  function update<K extends keyof PolicyProfile>(key: K, value: PolicyProfile[K]) { setProfile((p) => ({ ...p, [key]: value })); }
  function startTraining() {
    setError("");
    worker.current?.terminate();
    const instance = new Worker(new URL("../../workers/training.worker.ts", import.meta.url));
    worker.current = instance;
    setProgress({ episode: 0, total: profile.episodes, reward: 0 });
    instance.onmessage = async (event) => {
      if (event.data.type === "progress") setProgress(event.data.progress);
      if (event.data.type === "complete") {
        await savePolicy(event.data.policy);
        setActivePolicy(event.data.policy.id);
        setProgress(null); instance.terminate(); void refresh();
      }
      if (event.data.type === "error") { setError(event.data.message); setProgress(null); }
    };
    instance.postMessage({ ...profile, id: crypto.randomUUID() });
  }

  async function importPolicy(file: File) {
    setPolicyAction("import");
    try {
      const policy = JSON.parse(await file.text()) as PolicyArtifact;
      const validQTable = policy.schemaVersion === 2 && "qTable" in policy && Boolean(policy.profile);
      const validMlp = policy.schemaVersion === 3 && (policy as MlpPolicyArtifact).kind === "mlp" && "layers" in policy;
      if (!validQTable && !validMlp) throw new Error("Unsupported or outdated policy file");
      await savePolicy(policy); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not import policy"); }
    finally { setPolicyAction(""); }
  }

  function activate(policy: PolicyArtifact) {
    setPolicyAction(`${policy.id}:activate`); setActivePolicy(policy.id);
    window.setTimeout(() => setPolicyAction(""), 350);
  }
  function exportPolicy(policy: PolicyArtifact) {
    setPolicyAction(`${policy.id}:export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(policy)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `${policy.profile.name}.qtable.json`; a.click(); URL.revokeObjectURL(url);
    window.setTimeout(() => setPolicyAction(""), 350);
  }
  async function removePolicy(id: string) {
    setPolicyAction(`${id}:delete`);
    try { await deletePolicy(id); await refresh(); } finally { setPolicyAction(""); }
  }

  return <main><Header /><div className="shell page-grid">
    <section>
      <div className="eyebrow"><i /> POLICY LAB</div><h1 className="page-title">Train the controller.</h1>
      <p className="muted">Training runs entirely in a Web Worker. Policies remain in this browser unless you export them.</p>
      <div className="panel form-grid">
        <label>Profile name<input value={profile.name} onChange={(e) => update("name", e.target.value)} /></label>
        <label>QoE objective<select value={profile.rewardMode} onChange={(e) => update("rewardMode", e.target.value as PolicyProfile["rewardMode"])}><option value="balanced">Balanced</option><option value="quality">Quality</option><option value="stall-avoidant">Stall avoidant</option></select></label>
        <label>Viewer count<select value={profile.viewers} onChange={(e) => update("viewers", Number(e.target.value) as 1 | 2)}><option value="1">One</option><option value="2">Two</option></select></label>
        <label>Episodes<input type="number" min="1000" max="100000" value={profile.episodes} onChange={(e) => update("episodes", Number(e.target.value))} /></label>
        <label>Minimum bandwidth (Mbps)<input type="number" step="0.1" value={profile.minBandwidth / 1e6} onChange={(e) => update("minBandwidth", Number(e.target.value) * 1e6)} /></label>
        <label>Maximum bandwidth (Mbps)<input type="number" step="0.1" value={profile.maxBandwidth / 1e6} onChange={(e) => update("maxBandwidth", Number(e.target.value) * 1e6)} /></label>
        <label>Volatility<input type="number" step="0.05" min="0" max="1" value={profile.volatility} onChange={(e) => update("volatility", Number(e.target.value))} /></label>
        <label>Latency (ms)<input type="number" value={profile.latency} onChange={(e) => update("latency", Number(e.target.value))} /></label>
        <label>Packet loss<input type="number" step="0.01" min="0" max="0.5" value={profile.loss} onChange={(e) => update("loss", Number(e.target.value))} /></label>
        <label>Seed<input type="number" value={profile.seed} onChange={(e) => update("seed", Number(e.target.value))} /></label>
        <div className="form-actions"><button className="button primary" onClick={startTraining} disabled={Boolean(progress)}>{progress ? "Training…" : "Train Q-table"}</button>
          {progress && <button className="button" onClick={() => { worker.current?.terminate(); setProgress(null); }}>Cancel training</button>}</div>
        {progress && <div className="progress"><span style={{ width: `${progress.episode / progress.total * 100}%` }} /><b>{Math.round(progress.episode / progress.total * 100)}%</b></div>}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
    <aside>
      <div className="section-heading"><h2>Saved policies</h2><label className={`button small ${policyAction ? "disabled" : ""}`}>{policyAction === "import" ? "Importing…" : "Import"}<input disabled={Boolean(policyAction)} hidden type="file" accept="application/json" onChange={(e) => e.target.files?.[0] && void importPolicy(e.target.files[0])} /></label></div>
      <p className="mode-help">Reward model v2 favors sustainable quality and tolerates minor frame drops. Retrain policies created before this update. PPO policies are trained offline in Python (see training/) — import an exported policy JSON above.</p>
      <div className="policy-list">{policies.length === 0 && <div className="empty">No policies yet. Train one to replace the safe runtime fallback.</div>}
        {policies.map((policy) => { const mlp = isMlpPolicy(policy); return <article className="policy" key={policy.id}><small>{mlp ? `PPO · ${policy.profile.rewardModes.join("/")} · ${policy.profile.viewers.join("/")} viewer(s)` : `${policy.profile.rewardMode} · ${policy.profile.viewers} viewer${policy.profile.viewers > 1 ? "s" : ""}`}</small><h3>{policy.profile.name}</h3>
          <div className="policy-stats"><span>Reward <b>{policy.evaluation.averageReward.toFixed(2)}</b></span><span>Freeze <b>{(policy.evaluation.freezeRate * 100).toFixed(1)}%</b></span><span>{mlp ? "Layers" : "States"} <b>{mlp ? policy.layers.length : Object.keys(policy.qTable).length}</b></span></div>
          <div className="row"><button disabled={Boolean(policyAction)} className="button small primary" onClick={() => activate(policy)}>{policyAction === `${policy.id}:activate` ? "Activating…" : "Activate"}</button><button disabled={Boolean(policyAction)} className="button small" onClick={() => exportPolicy(policy)}>{policyAction === `${policy.id}:export` ? "Exporting…" : "Export"}</button><button disabled={Boolean(policyAction)} className="button small danger" onClick={() => void removePolicy(policy.id)}>{policyAction === `${policy.id}:delete` ? "Deleting…" : "Delete"}</button></div>
        </article>; })}
      </div>
    </aside>
  </div></main>;
}
