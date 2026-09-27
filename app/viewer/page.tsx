"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Metric } from "@/components/metric";
import { useSignalPoll } from "@/hooks/use-signal-poll";
import { formatBitrate, QUALITY_LEVELS } from "@/lib/levels";
import { beaconLeaveRoom, getIceServers, joinRoom, leaveRoom, sendSignal } from "@/lib/signaling-client";
import type { PeerTelemetry, RoomSession, SignalEnvelope } from "@/lib/types";
import { collectTelemetry } from "@/lib/webrtc";

const initial: PeerTelemetry = { timestamp: 0, outboundBitrate: 0, inboundBitrate: 0, rtt: 0, packetLoss: 0, jitter: 0, framesDropped: 0, framesDecoded: 0, freezeCount: 0, jitterBufferDelay: 0 };

export default function ViewerPage() {
  const router = useRouter();
  const video = useRef<HTMLVideoElement>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const sample = useRef<{ at: number; bytes: number } | undefined>(undefined);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const iceServers = useRef<RTCIceServer[]>([]);
  const [code, setCode] = useState("");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [status, setStatus] = useState("Enter a room code");
  const [quality, setQuality] = useState(0);
  const [fallback, setFallback] = useState(false);
  const [mode, setMode] = useState("balanced");
  const [metrics, setMetrics] = useState(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [streamEnded, setStreamEnded] = useState(false);

  async function perform(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    try { await action(); } finally { setBusy(""); }
  }

  const makePeer = useCallback(async () => {
    pc.current?.close();
    const connection = new RTCPeerConnection({ iceServers: iceServers.current }); pc.current = connection; pendingIce.current = [];
    connection.ontrack = (event) => { if (video.current) { video.current.srcObject = event.streams[0]; void video.current.play().catch(() => undefined); } };
    connection.ondatachannel = (event) => {
      channel.current = event.channel;
      event.channel.onmessage = (message) => { try { const data = JSON.parse(message.data); if (data.type === "quality") { setQuality(data.level); setFallback(data.fallback); setMode(data.mode ?? "balanced"); } } catch { /* ignore */ } };
    };
    connection.onconnectionstatechange = () => setStatus(connection.connectionState === "connected" ? "Live" : connection.connectionState);
    connection.oniceconnectionstatechange = () => {
      if (connection.iceConnectionState === "failed") setError("No peer-to-peer path could be established. The host should configure a TURN relay for this network.");
      else if (connection.iceConnectionState !== "new") setStatus(connection.iceConnectionState === "connected" || connection.iceConnectionState === "completed" ? "Live" : `ICE ${connection.iceConnectionState}`);
    };
    if (session) connection.onicecandidate = (event) => { if (event.candidate) void sendSignal(session, "host", { type: "ice", candidate: event.candidate.toJSON() }); };
    return connection;
  }, [session]);

  async function join() {
    setError("");
    if (!/^[A-Z2-9]{6}$/.test(code.toUpperCase())) { setError("Enter the six-character room code."); return; }
    try { iceServers.current = await getIceServers(); const room = await joinRoom(code.toUpperCase()); setSession(room); setStatus("Connecting"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not join room"); }
  }

  const onSignal = useCallback(async (signal: SignalEnvelope) => {
    if (!session) return;
    try {
      if (signal.payload.type === "offer") {
        const connection = await makePeer();
        connection.onicecandidate = (event) => {
          if (event.candidate) void sendSignal(session, "host", { type: "ice", candidate: event.candidate.toJSON() })
            .catch(() => setError("Could not deliver an ICE candidate. Check the signaling service."));
        };
        await connection.setRemoteDescription(signal.payload.sdp);
        for (const candidate of pendingIce.current.splice(0)) await connection.addIceCandidate(candidate);
        const answer = await connection.createAnswer(); await connection.setLocalDescription(answer);
        await sendSignal(session, "host", { type: "answer", sdp: answer });
      }
      if (signal.payload.type === "ice") {
        if (pc.current?.remoteDescription) await pc.current.addIceCandidate(signal.payload.candidate); else pendingIce.current.push(signal.payload.candidate);
      }
      if (signal.payload.type === "source-ended" || signal.payload.type === "leave") { setStatus("Stream ended"); setStreamEnded(true); pc.current?.close(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "WebRTC negotiation failed"); }
  }, [makePeer, session]);
  useSignalPoll(session, onSignal);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(async () => {
      if (!pc.current || pc.current.connectionState !== "connected") return;
      const result = await collectTelemetry(pc.current, "inbound", sample.current); sample.current = result.sample; setMetrics(result.telemetry);
      if (channel.current?.readyState === "open") channel.current.send(JSON.stringify({ type: "telemetry", value: result.telemetry }));
    }, 2000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const notify = () => { beaconLeaveRoom(session); };
    window.addEventListener("pagehide", notify);
    return () => { window.removeEventListener("pagehide", notify); };
  }, [session]);

  async function leave() { if (session) await leaveRoom(session).catch(() => undefined); pc.current?.close(); setSession(null); setStatus("Left room"); if (video.current) video.current.srcObject = null; }
  function backToClient() {
    setBusy("Returning"); pc.current?.close(); setSession(null); setStreamEnded(false); setCode(""); setStatus("Enter a room code");
    router.replace("/viewer");
    window.setTimeout(() => setBusy(""), 300);
  }
  useEffect(() => () => { pc.current?.close(); }, []);

  return <main><Header /><div className="shell viewer-shell"><div className="eyebrow"><i /> CLIENT MODE</div><h1 className="page-title">Join the broadcast.</h1>
    {!session && <section className="join-card"><label>Room code<div className="join-row"><input disabled={Boolean(busy)} maxLength={6} autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""))} placeholder="ABC234" /><button disabled={Boolean(busy)} className="button primary" onClick={() => void perform("Joining stream", join)}>{busy === "Joining stream" ? "Joining stream…" : "Join stream"}</button></div></label><p>Media travels over an encrypted WebRTC connection and is not stored by this website.</p>{error && <p className="error">{error}</p>}</section>}
    {session && <><div className="viewer-video"><video ref={video} autoPlay playsInline controls /><div className="live-badge"><i /> {status}</div><div className="quality-badge">{QUALITY_LEVELS[quality].name} · {mode === "manual" ? "manual" : fallback ? `${mode} safe` : `${mode} RL`}</div></div>
      <div className="viewer-metrics"><Metric label="Inbound" value={formatBitrate(metrics.inboundBitrate)} /><Metric label="RTT" value={`${Math.round(metrics.rtt)} ms`} /><Metric label="Packet loss" value={`${(metrics.packetLoss * 100).toFixed(1)}%`} /><Metric label="Jitter" value={`${Math.round(metrics.jitter * 1000)} ms`} /><Metric label="Dropped frames" value={metrics.framesDropped} /><Metric label="Network" value={metrics.networkType ?? "measured path"} /></div>
      {error && <p className="error">{error}</p>}<button disabled={Boolean(busy)} className="button danger" onClick={() => void perform("Leaving room", leave)}>{busy === "Leaving room" ? "Leaving room…" : "Leave room"}</button></>}
    {streamEnded && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="stream-ended-title"><div className="modal"><div className="modal-icon">■</div><h2 id="stream-ended-title">The server ended the stream</h2><p>You can safely close this window, or return to the client page to join another room.</p><button disabled={busy === "Returning"} className="button primary" onClick={backToClient}>{busy === "Returning" ? "Returning…" : "Back to client page"}</button></div></div>}
  </div></main>;
}
