import type { RoomSession, SignalEnvelope, SignalPayload } from "./types";

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export async function createRoom(): Promise<RoomSession & { persistentSignaling: boolean }> {
  return parse(await fetch("/api/rooms", { method: "POST" }));
}

export async function joinRoom(code: string): Promise<RoomSession> {
  return parse(await fetch(`/api/rooms/${code}/join`, { method: "POST" }));
}

const headers = (session: RoomSession) => ({
  "Content-Type": "application/json",
  "x-participant-id": session.participantId,
  Authorization: `Bearer ${session.token}`,
});

export async function sendSignal(session: RoomSession, targetId: string, payload: SignalPayload) {
  return parse<SignalEnvelope>(await fetch(`/api/rooms/${session.code}/signals`, {
    method: "POST", headers: headers(session), body: JSON.stringify({ targetId, payload }),
  }));
}

export async function pollSignals(session: RoomSession, cursor: number) {
  return parse<{ signals: SignalEnvelope[]; cursor: number }>(await fetch(`/api/rooms/${session.code}/signals?cursor=${cursor}`, {
    headers: headers(session), cache: "no-store",
  }));
}

export async function leaveRoom(session: RoomSession) {
  await fetch(`/api/rooms/${session.code}`, { method: "DELETE", headers: headers(session), keepalive: true });
}

export function beaconLeaveRoom(session: RoomSession) {
  const body = new Blob([JSON.stringify({ participantId: session.participantId, token: session.token })], { type: "application/json" });
  return navigator.sendBeacon(`/api/rooms/${session.code}/leave`, body);
}

export async function getIceServers(): Promise<RTCIceServer[]> {
  return (await parse<{ iceServers: RTCIceServer[] }>(await fetch("/api/ice-config", { cache: "no-store" }))).iceServers;
}
