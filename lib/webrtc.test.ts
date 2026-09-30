import { describe, expect, it, vi } from "vitest";
import { applyQuality } from "./webrtc";

describe("manual WebRTC quality", () => {
  it("applies the requested level without source masking or degradation", async () => {
    let applied: RTCRtpSendParameters | undefined;
    const sender = {
      track: { kind: "video", applyConstraints: vi.fn() },
      getParameters: () => ({ encodings: [{}] }),
      setParameters: vi.fn(async (parameters: RTCRtpSendParameters) => { applied = parameters; }),
    } as unknown as RTCRtpSender;
    const pc = { getSenders: () => [sender] } as unknown as RTCPeerConnection;

    await applyQuality(pc, 4, 480, true);

    expect(applied?.encodings[0].maxBitrate).toBe(4_500_000);
    expect(applied?.encodings[0].maxFramerate).toBe(60);
    expect(applied?.encodings[0].scaleResolutionDownBy).toBe(1);
    expect(applied?.degradationPreference).toBe("maintain-resolution");
  });
});
