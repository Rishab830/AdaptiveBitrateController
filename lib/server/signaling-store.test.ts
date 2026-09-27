import { describe, expect, it } from "vitest";
import { appendSignal, createRoom, joinRoom, readSignals, removeParticipant } from "./signaling-store";

describe("ephemeral signaling rooms", () => {
  it("creates a room and delivers targeted signals", async () => {
    const host = await createRoom();
    const viewer = await joinRoom(host.code);
    const hostInbox = await readSignals(host.code, "host", host.token, 0);
    expect(hostInbox[0]).toMatchObject({ senderId: viewer.participantId, payload: { type: "join" } });
    await appendSignal(host.code, "host", host.token, viewer.participantId, { type: "source-ended" });
    const viewerInbox = await readSignals(host.code, viewer.participantId, viewer.token, 0);
    expect(viewerInbox.at(-1)?.payload.type).toBe("source-ended");
  });

  it("limits a room to two viewers and validates tokens", async () => {
    const host = await createRoom();
    const first = await joinRoom(host.code); await joinRoom(host.code);
    await expect(joinRoom(host.code)).rejects.toMatchObject({ status: 409 });
    await expect(readSignals(host.code, first.participantId, "wrong", 0)).rejects.toMatchObject({ status: 401 });
    await removeParticipant(host.code, first.participantId, first.token);
    await expect(joinRoom(host.code)).resolves.toBeTruthy();
  });

  it("keeps concurrent trickle ICE signals ordered and complete", async () => {
    const host = await createRoom();
    const viewer = await joinRoom(host.code);
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendSignal(
      host.code, "host", host.token, viewer.participantId,
      { type: "ice", candidate: { candidate: `candidate-${index}` } },
    )));
    const messages = await readSignals(host.code, viewer.participantId, viewer.token, 0);
    expect(messages).toHaveLength(12);
    expect(new Set(messages.map((message) => message.seq)).size).toBe(12);
    expect(messages.map((message) => message.seq)).toEqual([...messages.map((message) => message.seq)].sort((a, b) => a - b));
  });
});
