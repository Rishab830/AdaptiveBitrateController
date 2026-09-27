import { Redis } from "@upstash/redis";
import type { SignalEnvelope, SignalPayload } from "../types";

const TTL_SECONDS = 2 * 60 * 60;
const STALE_VIEWER_MS = 20_000;
const memory = globalThis as typeof globalThis & { __abrRooms?: Map<string, StoredRoom> };
memory.__abrRooms ??= new Map();

interface Participant { token: string; joinedAt: number; lastSeen?: number }
interface StoredRoom {
  code: string;
  hostToken: string;
  createdAt: number;
  expiresAt: number;
  participants: Record<string, Participant>;
  signals: SignalEnvelope[];
  seq: number;
  endedAt?: number;
}

const redis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? Redis.fromEnv()
  : null;

const key = (code: string) => `abr:room:${code}`;
const signalKey = (code: string) => `abr:room:${code}:signals`;
const sequenceKey = (code: string) => `abr:room:${code}:sequence`;

async function getRoom(code: string): Promise<StoredRoom | null> {
  if (redis) return redis.get<StoredRoom>(key(code));
  const room = memory.__abrRooms!.get(code) ?? null;
  if (room && room.expiresAt < Date.now()) {
    memory.__abrRooms!.delete(code);
    return null;
  }
  return room;
}

async function putRoom(room: StoredRoom, ttl = TTL_SECONDS) {
  if (redis) await redis.set(key(room.code), room, { ex: ttl });
  else memory.__abrRooms!.set(room.code, room);
}

function parseSignal(value: unknown): SignalEnvelope {
  return typeof value === "string" ? JSON.parse(value) as SignalEnvelope : value as SignalEnvelope;
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
  if (room.endedAt) throw new StoreError("This stream has ended", 410);
  const participantId = `viewer-${randomToken().slice(0, 8)}`;
  const token = randomToken();
  if (redis) {
    const result = await redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return -2 end
       local room = cjson.decode(raw)
       if room.endedAt then return -3 end
       local count = 0
       local now = tonumber(ARGV[3])
       for id, participant in pairs(room.participants) do
         local seen = participant.lastSeen or participant.joinedAt
         if now - seen > tonumber(ARGV[5]) then room.participants[id] = nil else count = count + 1 end
       end
       if count >= 2 then return -1 end
       room.participants[ARGV[1]] = { token = ARGV[2], joinedAt = now, lastSeen = now }
       redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ARGV[4])
       return 1`,
      [key(code)], [participantId, token, String(Date.now()), String(TTL_SECONDS), String(STALE_VIEWER_MS)],
    );
    if (Number(result) === -2) throw new StoreError("Room not found or expired", 404);
    if (Number(result) === -1) throw new StoreError("This room already has two viewers", 409);
    if (Number(result) === -3) throw new StoreError("This stream has ended", 410);
    room.participants[participantId] = { token, joinedAt: Date.now(), lastSeen: Date.now() };
  } else {
    for (const [id, participant] of Object.entries(room.participants)) {
      if (Date.now() - (participant.lastSeen ?? participant.joinedAt) > STALE_VIEWER_MS) delete room.participants[id];
    }
    if (Object.keys(room.participants).length >= 2) throw new StoreError("This room already has two viewers", 409);
    room.participants[participantId] = { token, joinedAt: Date.now(), lastSeen: Date.now() };
  }
  await appendSignalToRoom(room, participantId, "host", { type: "join" });
  return { code, participantId, token, expiresAt: room.expiresAt };
}

function authorized(room: StoredRoom, participantId: string, token: string) {
  return participantId === "host" ? room.hostToken === token : room.participants[participantId]?.token === token;
}

async function appendSignalToRoom(room: StoredRoom, senderId: string, targetId: string, payload: SignalPayload) {
  const base = { seq: 0, senderId, targetId, payload, createdAt: Date.now() };
  if (redis) {
    const result = await redis.eval(
      `local seq = redis.call('INCR', KEYS[1])
       local signal = cjson.decode(ARGV[1])
       signal.seq = seq
       local encoded = cjson.encode(signal)
       redis.call('RPUSH', KEYS[2], encoded)
       redis.call('LTRIM', KEYS[2], -500, -1)
       redis.call('EXPIRE', KEYS[1], ARGV[2])
       redis.call('EXPIRE', KEYS[2], ARGV[2])
       return encoded`,
      [sequenceKey(room.code), signalKey(room.code)], [JSON.stringify(base), String(TTL_SECONDS)],
    );
    return parseSignal(result);
  }
  const signal: SignalEnvelope = { ...base, seq: ++room.seq };
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
  if (participantId !== "host") {
    if (redis) {
      await redis.eval(
        `local raw = redis.call('GET', KEYS[1])
         if not raw then return 0 end
         local room = cjson.decode(raw)
         if room.participants[ARGV[1]] then
           room.participants[ARGV[1]].lastSeen = tonumber(ARGV[2])
           redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ARGV[3])
         end
         return 1`,
        [key(code)], [participantId, String(Date.now()), String(TTL_SECONDS)],
      );
    } else if (room.participants[participantId]) room.participants[participantId].lastSeen = Date.now();
  }
  if (redis) {
    const values = await redis.lrange<SignalEnvelope | string>(signalKey(code), 0, -1);
    return values.map(parseSignal).filter((signal) => signal.seq > cursor && signal.targetId === participantId).sort((a, b) => a.seq - b.seq);
  }
  return room.signals.filter((signal) => signal.seq > cursor && signal.targetId === participantId);
}

export async function removeParticipant(code: string, participantId: string, token: string) {
  const room = await getRoom(code);
  if (!room) return;
  if (!authorized(room, participantId, token)) throw new StoreError("Invalid participant credentials", 401);
  if (participantId === "host") {
    for (const viewerId of Object.keys(room.participants)) await appendSignalToRoom(room, "host", viewerId, { type: "source-ended" });
    room.endedAt = Date.now();
    room.expiresAt = Date.now() + 5 * 60_000;
    await putRoom(room, 5 * 60);
    return;
  }
  if (redis) {
    await redis.eval(
      `local raw = redis.call('GET', KEYS[1])
       if not raw then return 0 end
       local room = cjson.decode(raw)
       room.participants[ARGV[1]] = nil
       redis.call('SET', KEYS[1], cjson.encode(room), 'EX', ARGV[2])
       return 1`,
      [key(code)], [participantId, String(TTL_SECONDS)],
    );
  } else delete room.participants[participantId];
  await appendSignalToRoom(room, participantId, "host", { type: "leave" });
}

export class StoreError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function isPersistentStore() { return Boolean(redis); }
