import type { QualityLevel, RewardMode } from "./types";

export const QUALITY_LEVELS: QualityLevel[] = [
  { id: 0, name: "Economy", videoBitrate: 250_000, audioBitrate: 32_000, height: 360, frameRate: 15 },
  { id: 1, name: "Low", videoBitrate: 600_000, audioBitrate: 48_000, height: 480, frameRate: 24 },
  { id: 2, name: "Medium", videoBitrate: 1_200_000, audioBitrate: 64_000, height: 720, frameRate: 30 },
  { id: 3, name: "High", videoBitrate: 2_500_000, audioBitrate: 96_000, height: 1080, frameRate: 30 },
  { id: 4, name: "Ultra", videoBitrate: 4_500_000, audioBitrate: 128_000, height: 1080, frameRate: 60 },
];

export const REWARD_WEIGHTS: Record<RewardMode, { quality: number; freeze: number; switching: number; underuse: number }> = {
  balanced: { quality: 1, freeze: 4, switching: 0.5, underuse: 0.5 },
  quality: { quality: 1.4, freeze: 2.5, switching: 0.25, underuse: 0.8 },
  "stall-avoidant": { quality: 0.8, freeze: 6, switching: 0.5, underuse: 0.25 },
};

export function formatBitrate(value: number) {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} Mbps` : `${Math.round(value / 1000)} Kbps`;
}
