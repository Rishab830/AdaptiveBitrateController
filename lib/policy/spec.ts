import spec from "../../shared/obs-spec.json";
import { QUALITY_LEVELS } from "../levels";
import type { RewardMode } from "../types";

export type ObsSpec = typeof spec;
export const OBS_SPEC: ObsSpec = spec;

export interface ViewerRaw {
  headroom: number;      // availableCapacity / currentTargetBitrate, unclamped
  delivery: number;      // inboundBitrate / outboundBitrate, unclamped
  rttMs: number;
  loss: number;           // 0..1
  jitterSec: number;
  freeze: boolean;
  level: number;          // 0..4
  switchAgeSec: number;
  deliveryHist: number[]; // most-recent-last, length <= historyLen
  rttHist: number[];      // ms, most-recent-last
}

export interface ObsInput {
  viewers: ViewerRaw[];   // length 1 or 2
  aggregateHeadroom: number;
  mode: RewardMode;
}

const N = OBS_SPEC.normalization;
const neutral = OBS_SPEC.neutralSlot;

function clamp(x: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, x));
}

function padHist(hist: number[], fill: number, len: number) {
  const h = hist.slice(-len);
  while (h.length < len) h.unshift(fill);
  return h;
}

function slotOrNeutral(viewers: ViewerRaw[], index: number): ViewerRaw {
  return viewers[index] ?? {
    headroom: neutral.headroom, delivery: neutral.delivery, rttMs: neutral.rtt,
    loss: neutral.loss, jitterSec: neutral.jitter, freeze: false, level: neutral.level,
    switchAgeSec: neutral.switchAge, deliveryHist: [], rttHist: [],
  };
}

/** Builds the exact feature vector described by shared/obs-spec.json, in order. */
export function buildObs(input: ObsInput): number[] {
  const slots = [slotOrNeutral(input.viewers, 0), slotOrNeutral(input.viewers, 1)];
  const out: number[] = [];

  out.push(input.viewers.length / OBS_SPEC.maxViewers);
  for (const s of slots) out.push(clamp(s.headroom / N.headroomScale, 0, 2));
  for (const s of slots) out.push(clamp(s.delivery, 0, 2));
  for (const s of slots) out.push(clamp(s.rttMs / N.rttMsScale, 0, 2));
  for (const s of slots) out.push(clamp(s.loss, 0, 1));
  for (const s of slots) out.push(clamp(s.jitterSec / N.jitterSecScale, 0, 2));
  for (const s of slots) out.push(s.freeze ? 1 : 0);
  for (const s of slots) out.push(s.level / N.levelMax);
  for (const s of slots) out.push(clamp(s.switchAgeSec / N.switchAgeSecScale, 0, 1));
  out.push(clamp(input.aggregateHeadroom / N.aggregateHeadroomScale, 0, 2));
  for (const s of slots) {
    const hist = padHist(s.deliveryHist, neutral.delivery, OBS_SPEC.historyLen);
    for (const v of hist) out.push(clamp(v, 0, 2));
  }
  for (const s of slots) {
    const hist = padHist(s.rttHist, neutral.rtt, OBS_SPEC.historyLen);
    for (const v of hist) out.push(clamp(v / N.rttMsScale, 0, 2));
  }
  out.push(input.mode === "balanced" ? 1 : 0);
  out.push(input.mode === "quality" ? 1 : 0);
  out.push(input.mode === "stall-avoidant" ? 1 : 0);

  if (out.length !== OBS_SPEC.features.length) {
    throw new Error(`buildObs produced ${out.length} features, spec expects ${OBS_SPEC.features.length}`);
  }
  return out;
}

export function levelBitrate(level: number) {
  return QUALITY_LEVELS[level]?.videoBitrate ?? QUALITY_LEVELS[0].videoBitrate;
}
