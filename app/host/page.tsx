"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Header } from "@/components/header";
import { Metric } from "@/components/metric";
import { useSignalPoll } from "@/hooks/use-signal-poll";
import { QUALITY_LEVELS, formatBitrate } from "@/lib/levels";
import { getPolicyForMode } from "@/lib/policy-storage";
import { discretizeState, selectAction, stateKey } from "@/lib/qlearning";
import { createRoom, getIceServers, leaveRoom, sendSignal } from "@/lib/signaling-client";
import type { PeerTelemetry, RewardMode, RoomSession, SignalEnvelope } from "@/lib/types";
import { applyQuality, collectTelemetry, supportedLevelIds } from "@/lib/webrtc";

interface PeerRuntime {
  id: string; pc: RTCPeerConnection; channel?: RTCDataChannel; level: number; lastSwitch: number;
  local?: PeerTelemetry; remote?: PeerTelemetry; sample?: { at: number; bytes: number }; pendingIce: RTCIceCandidateInit[];
}

const emptyMetric: PeerTelemetry = { timestamp: 0, outboundBitrate: 0, inboundBitrate: 0, rtt: 0, packetLoss: 0, jitter: 0, framesDropped: 0, framesDecoded: 0, freezeCount: 0, jitterBufferDelay: 0 };

export default function HostPage() {
  const preview = useRef<HTMLVideoElement>(null);
  const source = useRef<MediaStream | null>(null);
  const peers = useRef(new Map<string, PeerRuntime>());
  const [session, setSession] = useState<RoomSession | null>(null);
  const [peerRows, setPeerRows] = useState<PeerRuntime[]>([]);
  const [sourceName, setSourceName] = useState("No source selected");
  const [status, setStatus] = useState("Choose a source to begin");
  const [error, setError] = useState("");
  const [decision, setDecision] = useState("Waiting for viewers");
  const [persistent, setPersistent] = useState(true);
  const [adaptationMode, setAdaptationMode] = useState<RewardMode | "manual">("balanced");
  const [manualLevel, setManualLevel] = useState(2);
  const [busy, setBusy] = useState("");
  const [capabilities, setCapabilities] = useState({ file: false, camera: false, screen: false });
  const iceServers = useRef<RTCIceServer[]>([]);

  useEffect(() => {
    const mediaPrototype = globalThis.HTMLMediaElement?.prototype as (HTMLMediaElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }) | undefined;
    const timer = window.setTimeout(() => setCapabilities({
      file: Boolean(mediaPrototype?.captureStream || mediaPrototype?.mozCaptureStream), camera: Boolean(navigator.mediaDevices?.getUserMedia), screen: Boolean(navigator.mediaDevices?.getDisplayMedia),
    }), 0);
    return () => clearTimeout(timer);
  }, []);

  const syncPeers = () => setPeerRows([...peers.current.values()]);
  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    try { await action(); } finally { setBusy(""); }
  }

  async function installStream(stream: MediaStream, name: string) {
    source.current?.getTracks().forEach((track) => track.stop());
    source.current = stream; setSourceName(name); setError("");
    if (preview.current) { preview.current.srcObject = stream; preview.current.muted = true; await preview.current.play().catch(() => undefined); }
    setStatus("Source ready");
    if (session) for (const id of peers.current.keys()) await restartPeer(id);
  }

  async function chooseCamera() {
    try { await installStream(await navigator.mediaDevices.getUserMedia({ video: true, audio: true }), "Camera + microphone"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Camera permission was denied"); }
  }
  async function chooseScreen() {
    try { await installStream(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }), "Screen share"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Screen capture was cancelled"); }
  }
  async function chooseFile(file: File) {
    const video = preview.current;
    if (!video) return;
    const old = video.dataset.url; if (old) URL.revokeObjectURL(old);
    const url = URL.createObjectURL(file); video.dataset.url = url; video.srcObject = null; video.src = url; video.muted = false; video.controls = true;
    try {
      await video.play();
      const capture = (video as HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }).captureStream
        ?? (video as HTMLVideoElement & { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
      if (!capture) throw new Error("This browser cannot capture local video playback. Try camera/screen or a desktop Chromium browser.");
      source.current?.getTracks().forEach((track) => track.stop());
      source.current = capture.call(video); setSourceName(file.name); setStatus("Source ready"); setError("");
      if (session) for (const id of peers.current.keys()) await restartPeer(id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this file"); }
  }

  async function beginRoom() {
    if (!source.current) { setError("Select a source before creating a room."); return; }
    try {
      iceServers.current = await getIceServers();
      const room = await createRoom(); setSession(room); setPersistent(room.persistentSignaling); setStatus("Room is live");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create room"); }
  }

  const createPeer = useCallback(async (viewerId: string) => {
    if (!session || !source.current) return;
    peers.current.get(viewerId)?.pc.close();
    const pc = new RTCPeerConnection({ iceServers: iceServers.current });
    const runtime: PeerRuntime = { id: viewerId, pc, level: 0, lastSwitch: Date.now(), pendingIce: [] };
    peers.current.set(viewerId, runtime);
    source.current.getTracks().forEach((track) => pc.addTrack(track, source.current!));
    const channel = pc.createDataChannel("telemetry", { ordered: true }); runtime.channel = channel;
    channel.onmessage = (event) => {
      try { const message = JSON.parse(event.data); if (message.type === "telemetry") runtime.remote = message.value; } catch { /* ignore malformed peer data */ }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) void sendSignal(session, viewerId, { type: "ice", candidate: event.candidate.toJSON() })
        .catch(() => setError("Could not deliver an ICE candidate. Check the signaling service."));
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") setError("A network path could not be established for a viewer. Configure TURN for restrictive networks.");
      syncPeers();
    };
    pc.onconnectionstatechange = () => {
      setStatus(`Viewer ${viewerId.slice(-4)}: ${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") peers.current.delete(viewerId);
      if (pc.connectionState === "disconnected") window.setTimeout(() => {
        if (pc.connectionState === "disconnected") { pc.close(); peers.current.delete(viewerId); syncPeers(); }
      }, 8_000);
      syncPeers();
    };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await sendSignal(session, viewerId, { type: "offer", sdp: offer }); syncPeers();
  }, [session]);

  async function restartPeer(viewerId: string) { await createPeer(viewerId); }

  const onSignal = useCallback(async (signal: SignalEnvelope) => {
    if (!session) return;
    try {
      if (signal.payload.type === "join") await createPeer(signal.senderId);
      const peer = peers.current.get(signal.senderId);
      if (!peer) return;
      if (signal.payload.type === "answer") {
        await peer.pc.setRemoteDescription(signal.payload.sdp);
        for (const candidate of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(candidate);
      }
      if (signal.payload.type === "ice") {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.payload.candidate); else peer.pendingIce.push(signal.payload.candidate);
      }
      if (signal.payload.type === "leave") { peer.pc.close(); peers.current.delete(signal.senderId); syncPeers(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "WebRTC negotiation failed"); }
  }, [createPeer, session]);
  useSignalPoll(session, onSignal);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(async () => {
      const active = [...peers.current.values()].filter((peer) => peer.pc.connectionState === "connected").slice(0, 2);
      if (!active.length) return;
      for (const peer of active) {
        const sample = await collectTelemetry(peer.pc, "outbound", peer.sample); peer.sample = sample.sample; peer.local = sample.telemetry;
      }
      const telemetry = active.map((peer) => ({
        ...emptyMetric, ...peer.local, ...peer.remote,
        outboundBitrate: peer.local?.outboundBitrate ?? 0,
        inboundBitrate: peer.remote?.inboundBitrate ?? 0,
        availableOutgoingBitrate: peer.local?.availableOutgoingBitrate,
        rtt: Math.max(peer.local?.rtt ?? 0, peer.remote?.rtt ?? 0, peer.local?.networkRtt ?? 0, peer.remote?.networkRtt ?? 0),
        packetLoss: Math.max(peer.local?.packetLoss ?? 0, peer.remote?.packetLoss ?? 0),
        jitter: peer.remote?.jitter ?? peer.local?.jitter ?? 0,
      }));
      const current = active.map((peer) => peer.level);
      const age = Math.min(...active.map((peer) => (Date.now() - peer.lastSwitch) / 1000));
      const state = discretizeState(telemetry, current, age);
      const viewerCount = active.length as 1 | 2;
      const policy = adaptationMode === "manual" ? undefined : await getPolicyForMode(viewerCount, adaptationMode);
      const selected = adaptationMode === "manual"
        ? { levels: Array(viewerCount).fill(manualLevel) as number[], qValue: 0, fallback: false }
        : selectAction(policy, state, viewerCount, adaptationMode);
      const allowed = supportedLevelIds(source.current!);
      await Promise.all(active.map(async (peer, index) => {
        const desired = Math.max(...allowed.filter((level) => level <= (selected.levels[index] ?? 0)), allowed[0]);
        if (desired !== peer.level) peer.lastSwitch = Date.now();
        peer.level = desired;
        await applyQuality(peer.pc, desired, source.current!.getVideoTracks()[0]?.getSettings().height);
        if (peer.channel?.readyState === "open") peer.channel.send(JSON.stringify({ type: "quality", level: desired, fallback: selected.fallback, mode: adaptationMode }));
      }));
      const controller = adaptationMode === "manual" ? "Manual override" : selected.fallback ? `${adaptationMode} safety controller` : policy?.profile.name;
      setDecision(`${controller}: ${active.map((peer) => QUALITY_LEVELS[peer.level].name).join(" / ")} · state ${stateKey(state)}`);
      syncPeers();
    }, 2000);
    return () => clearInterval(timer);
  }, [adaptationMode, manualLevel, session]);

  async function endRoom() {
    if (session) await leaveRoom(session).catch(() => undefined);
    peers.current.forEach((peer) => peer.pc.close()); peers.current.clear(); setSession(null); syncPeers(); setStatus("Room ended");
  }
  useEffect(() => () => { source.current?.getTracks().forEach((track) => track.stop()); peers.current.forEach((peer) => peer.pc.close()); }, []);

  return <main><Header /><div className="shell host-layout">
    <section><div className="eyebrow"><i /> SERVER MODE</div><h1 className="page-title">Broadcast from this device.</h1>
      <div className="video-stage"><video ref={preview} playsInline /><div className="video-badge">{sourceName}</div></div>
      <div className="source-bar">{capabilities.file && <label className={`button ${busy ? "disabled" : ""}`}>{busy === "Opening file" ? "Opening file…" : "Local file"}<input disabled={Boolean(busy)} hidden type="file" accept="video/*" onChange={(e) => e.target.files?.[0] && void perform("Opening file", () => chooseFile(e.target.files![0]))} /></label>}
        {capabilities.camera && <button disabled={Boolean(busy)} className="button" onClick={() => void perform("Starting camera", chooseCamera)}>{busy === "Starting camera" ? "Starting camera…" : "Camera"}</button>}{capabilities.screen && <button disabled={Boolean(busy)} className="button" onClick={() => void perform("Starting share", chooseScreen)}>{busy === "Starting share" ? "Starting share…" : "Share screen"}</button>}
        {!session ? <button disabled={Boolean(busy)} className="button primary grow" onClick={() => void perform("Creating room", beginRoom)}>{busy === "Creating room" ? "Creating room…" : "Create room"}</button> : <button disabled={Boolean(busy)} className="button danger grow" onClick={() => void perform("Ending stream", endRoom)}>{busy === "Ending stream" ? "Ending stream…" : "End room"}</button>}</div>
      {!capabilities.file && !capabilities.camera && !capabilities.screen && <p className="warning">This browser does not expose a supported media-capture source. Try a current browser over HTTPS.</p>}
      {error && <p className="error">{error}</p>}
    </section>
    <aside className="dashboard">
      <div className="room-card"><small>ROOM CODE</small><strong>{session?.code ?? "— — — — — —"}</strong><p>{status}</p>{session && !persistent && <p className="warning">Local signaling mode: viewers must use this same running server. Add Upstash Redis before deploying.</p>}</div>
      <div className="panel"><div className="section-heading"><h2>Connected clients</h2><span>{peerRows.length}/2</span></div>
        {peerRows.length === 0 && <div className="empty">Share the room code. Client metrics will appear here.</div>}
        {peerRows.map((peer) => <article className="client-card" key={peer.id}><div className="row spread"><b>Client {peer.id.slice(-4).toUpperCase()}</b><span className={`status-dot ${peer.pc.connectionState}`} /> </div>
          <div className="metric-grid"><Metric label="Quality" value={QUALITY_LEVELS[peer.level].name} /><Metric label="ICE state" value={peer.pc.iceConnectionState} /><Metric label="Outbound" value={formatBitrate(peer.local?.outboundBitrate ?? 0)} /><Metric label="RTT" value={`${Math.round(peer.local?.rtt ?? 0)} ms`} /><Metric label="Loss" value={`${((peer.remote?.packetLoss ?? peer.local?.packetLoss ?? 0) * 100).toFixed(1)}%`} /></div>
        </article>)}
      </div>
      <div className="panel form-grid compact"><label>Adaptation mode<select value={adaptationMode} onChange={(event) => setAdaptationMode(event.target.value as RewardMode | "manual")}><option value="balanced">Balanced RL</option><option value="quality">Quality RL</option><option value="stall-avoidant">Stall Avoidant RL</option><option value="manual">Manual quality</option></select></label>
        {adaptationMode === "manual" && <label>Quality level<select value={manualLevel} onChange={(event) => setManualLevel(Number(event.target.value))}>{QUALITY_LEVELS.map((level) => <option key={level.id} value={level.id}>{level.name} — {formatBitrate(level.videoBitrate)}</option>)}</select></label>}
        {adaptationMode !== "manual" && <p className="mode-help">A matching trained Q-table is used when available. Otherwise the safety controller probes upward after a stable interval instead of remaining at Economy.</p>}
      </div>
      <div className="decision panel"><small>RL DECISION</small><p>{decision}</p></div>
      <a className="text-link" href="/train">Train or activate another policy →</a>
    </aside>
  </div></main>;
}
