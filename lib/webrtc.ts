import { QUALITY_LEVELS } from "./levels";
import type { PeerTelemetry } from "./types";

type ByteSample = {
  at: number; bytes: number; packetsLost?: number; packetsTotal?: number; framesDropped?: number;
  framesDecoded?: number; freezeCount?: number; freezeDuration?: number; jitterBufferDelay?: number; jitterBufferEmitted?: number;
};

const delta = (value: number, previous?: number) => previous === undefined ? 0 : Math.max(0, value - previous);

export function computeImpairmentSeverity(framesDropped: number, framesDecoded: number, freezeDuration: number, freezeCount: number, jitterBufferDelay: number) {
  const dropRate = framesDropped / Math.max(framesDropped + framesDecoded, 1);
  const dropSeverity = framesDropped < 3 || dropRate <= 0.05 ? 0 : Math.min(1, (dropRate - 0.05) / 0.25);
  const freezeSeverity = freezeDuration > 0 ? Math.min(1, freezeDuration / 2) : freezeCount > 0 ? 0.35 : 0;
  const jitterSeverity = jitterBufferDelay <= 0.2 ? 0 : Math.min(0.5, (jitterBufferDelay - 0.2) / 0.8);
  return Math.max(dropSeverity, freezeSeverity, jitterSeverity);
}

export function networkHints() {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number } };
  return {
    networkType: nav.connection?.effectiveType,
    networkDownlink: nav.connection?.downlink,
    networkRtt: nav.connection?.rtt,
  };
}

export async function collectTelemetry(pc: RTCPeerConnection, direction: "inbound" | "outbound", previous?: ByteSample) {
  const stats = await pc.getStats();
  const now = performance.now();
  let bytes = 0;
  let packetsLost = 0, packetsTotal = 0, framesDropped = 0, framesDecoded = 0, freezeCount = 0;
  let freezeDuration = 0, jitterBufferDelay = 0, jitterBufferEmitted = 0;
  const telemetry: PeerTelemetry = {
    timestamp: Date.now(), outboundBitrate: 0, inboundBitrate: 0, rtt: 0, packetLoss: 0,
    jitter: 0, framesDropped: 0, framesDecoded: 0, freezeCount: 0, jitterBufferDelay: 0,
    ...networkHints(),
  };
  stats.forEach((report) => {
    if (report.type === `${direction}-rtp` && !report.isRemote && report.kind === "video") {
      bytes += direction === "inbound" ? (report.bytesReceived ?? 0) : (report.bytesSent ?? 0);
      telemetry.jitter = (report.jitter ?? 0);
      framesDropped = report.framesDropped ?? 0;
      framesDecoded = report.framesDecoded ?? 0;
      freezeCount = report.freezeCount ?? 0;
      freezeDuration = report.totalFreezesDuration ?? 0;
      jitterBufferDelay = report.jitterBufferDelay ?? 0;
      jitterBufferEmitted = report.jitterBufferEmittedCount ?? 0;
      telemetry.qualityLimitationReason = report.qualityLimitationReason;
      const lost = report.packetsLost ?? 0;
      const received = report.packetsReceived ?? report.packetsSent ?? 0;
      packetsLost = lost; packetsTotal = lost + received;
    }
    if (report.type === "remote-inbound-rtp" && report.kind === "video") {
      telemetry.rtt = (report.roundTripTime ?? 0) * 1000;
      const lost = report.packetsLost ?? 0;
      if (lost >= packetsLost) { packetsLost = lost; packetsTotal = (report.packetsReceived ?? 0) + lost; }
    }
    if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
      telemetry.availableOutgoingBitrate = report.availableOutgoingBitrate;
      telemetry.rtt ||= (report.currentRoundTripTime ?? 0) * 1000;
    }
  });
  const bitrate = previous && now > previous.at ? ((bytes - previous.bytes) * 8 * 1000) / (now - previous.at) : 0;
  const droppedDelta = delta(framesDropped, previous?.framesDropped);
  const decodedDelta = delta(framesDecoded, previous?.framesDecoded);
  const freezeDelta = delta(freezeCount, previous?.freezeCount);
  const freezeDurationDelta = delta(freezeDuration, previous?.freezeDuration);
  const packetLostDelta = delta(packetsLost, previous?.packetsLost);
  const packetTotalDelta = delta(packetsTotal, previous?.packetsTotal);
  const jitterDelayDelta = delta(jitterBufferDelay, previous?.jitterBufferDelay);
  const jitterEmittedDelta = delta(jitterBufferEmitted, previous?.jitterBufferEmitted);
  telemetry.framesDropped = droppedDelta;
  telemetry.framesDecoded = decodedDelta;
  telemetry.frameDropRate = droppedDelta / Math.max(droppedDelta + decodedDelta, 1);
  telemetry.freezeCount = freezeDelta;
  telemetry.freezeDuration = freezeDurationDelta;
  telemetry.jitterBufferDelay = jitterDelayDelta / Math.max(jitterEmittedDelta, 1);
  telemetry.packetLoss = packetLostDelta / Math.max(packetTotalDelta, 1);
  telemetry.impairmentSeverity = computeImpairmentSeverity(droppedDelta, decodedDelta, freezeDurationDelta, freezeDelta, telemetry.jitterBufferDelay);
  if (direction === "inbound") telemetry.inboundBitrate = Math.max(0, bitrate);
  else telemetry.outboundBitrate = Math.max(0, bitrate);
  return { telemetry, sample: { at: now, bytes, packetsLost, packetsTotal, framesDropped, framesDecoded, freezeCount, freezeDuration, jitterBufferDelay, jitterBufferEmitted } };
}

export async function applyQuality(pc: RTCPeerConnection, levelId: number, sourceHeight = 1080) {
  const level = QUALITY_LEVELS[Math.max(0, Math.min(QUALITY_LEVELS.length - 1, levelId))];
  const results: string[] = [];
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const parameters = sender.getParameters();
    parameters.encodings ??= [{}];
    if (sender.track.kind === "video") {
      parameters.encodings[0].maxBitrate = level.videoBitrate;
      parameters.encodings[0].maxFramerate = level.frameRate;
      parameters.encodings[0].scaleResolutionDownBy = Math.max(1, sourceHeight / level.height);
      parameters.degradationPreference = "maintain-framerate";
    } else if (sender.track.kind === "audio") {
      parameters.encodings[0].maxBitrate = level.audioBitrate;
    }
    try {
      await sender.setParameters(parameters);
      results.push(`${sender.track.kind}: applied`);
    } catch {
      if (sender.track.kind === "video") {
        await sender.track.applyConstraints({ height: { max: level.height }, frameRate: { max: level.frameRate } }).catch(() => undefined);
        results.push("video: constraints fallback");
      } else results.push("audio: browser controlled");
    }
  }
  return results;
}

export function supportedLevelIds(stream: MediaStream) {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const height = settings?.height ?? 1080;
  const frameRate = settings?.frameRate ?? 30;
  const supported = QUALITY_LEVELS.filter((level) => level.height <= height && level.frameRate <= Math.max(frameRate, 30)).map((level) => level.id);
  return supported.length ? supported : [0];
}
