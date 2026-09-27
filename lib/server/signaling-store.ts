import { Redis } from "@upstash/redis";
import type { SignalEnvelope, SignalPayload } from "../types";

const TTL_SECONDS = 2 * 60 * 60;
const memory = globalThis as typeof globalThis & { __abrRooms?: Map<string, StoredRoom> };
memory.__abrRooms ??= new Map();

interface Participant { token: string; joinedAt: number }
interface StoredRoom {
  code: string;
  hostToken: string;
  createdAt: number;
  expiresAt: number;
  participants: Record<string, Participant>;
  signals: SignalEnvelope[];
  seq: number;
}

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;

const key = (code: string) => `abr:room:${code}`;

async function getRoom(code: string): Promise<StoredRoom | null> {
  if (redis) return redis.get<StoredRoom>(key(code));
  const room = memory.__abrRooms!.get(code) ?? null;
  if (room && room.expiresAt < Date.now()) {
    memory.__abrRooms!.delete(code);
    return null;
  }
  return room;
}

async function putRoom(room: StoredRoom) {
  if (redis) await redis.set(key(room.code), room, { ex: TTL_SECONDS });
  else memory.__abrRooms!.set(room.code, room);
}

function randomToken() { return crypto.randomUUID().replaceAll("-", ""); }
function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

export async function createRoom() {
  let code = randomCode();
  while (await getRoom(code)) code = randomCode();
  const hostToken = randomToken();
  const room: StoredRoom = {
    code, hostToken, createdAt: Date.now(), expiresAt: Date.now() + TTL_SECONDS * 1000,
    participants: {}, signals: [], seq: 0,
  };
  await putRoom(room);
  return { code, participantId: "host", token: hostToken, expiresAt: room.expiresAt };
}

export async function joinRoom(code: string) {
  const room = await getRoom(code);
  if (!room) throw new StoreError("Room not found or expired", 404);
  if (Object.keys(room.participants).length >= 2) throw new StoreError("This room already has two viewers", 409);
  const participantId = `viewer-${randomToken().slice(0, 8)}`;
  const token = randomToken();
  room.participants[participantId] = { token, joinedAt: Date.now() };
  await appendSignalToRoom(room, participantId, "host", { type: "join" });
  return { code, participantId, token, expiresAt: room.expiresAt };
}

function authorized(room: StoredRoom, participantId: string, token: string) {
  return participantId === "host" ? room.hostToken === token : room.participants[participantId]?.token === token;
}

async function appendSignalToRoom(room: StoredRoom, senderId: string, targetId: string, payload: SignalPayload) {
  const signal: SignalEnvelope = { seq: ++room.seq, senderId, targetId, payload, createdAt: Date.now() };
  room.signals.push(signal);
  room.signals = room.signals.slice(-500);
  await putRoom(room);
  return signal;
}

export async function appendSignal(code: string, participantId: string, token: string, targetId: string, payload: SignalPayload) {
  const room = await getRoom(code);
  if (!room) throw new StoreError("Room not found or expired", 404);
  if (!authorized(room, participantId, token)) throw new StoreError("Invalid participant credentials", 401);
  if (targetId !== "host" && !room.participants[targetId]) throw new StoreError("Signal target is not in this room", 400);
  return appendSignalToRoom(room, participantId, targetId, payload);
}

export async function readSignals(code: string, participantId: string, token: string, cursor: number) {
  const room = await getRoom(code);
  if (!room) throw new StoreError("Room not found or expired", 404);
  if (!authorized(room, participantId, token)) throw new StoreError("Invalid participant credentials", 401);
  return room.signals.filter((signal) => signal.seq > cursor && signal.targetId === participantId);
}

export async function removeParticipant(code: string, participantId: string, token: string) {
  const room = await getRoom(code);
  if (!room) return;
  if (!authorized(room, participantId, token)) throw new StoreError("Invalid participant credentials", 401);
  if (participantId === "host") {
    if (redis) await redis.del(key(code)); else memory.__abrRooms!.delete(code);
    return;
  }
  delete room.participants[participantId];
  await appendSignalToRoom(room, participantId, "host", { type: "leave" });
}

export class StoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function isPersistentStore() { return Boolean(redis); }
