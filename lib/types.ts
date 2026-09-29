export type Role = "host" | "viewer";
export type RewardMode = "balanced" | "quality" | "stall-avoidant";

export interface QualityLevel {
  id: number;
  name: string;
  videoBitrate: number;
  audioBitrate: number;
  height: number;
  frameRate: number;
}

export interface PeerTelemetry {
  timestamp: number;
  outboundBitrate: number;
  inboundBitrate: number;
  availableOutgoingBitrate?: number;
  rtt: number;
  packetLoss: number;
  jitter: number;
  framesDropped: number;
  framesDecoded: number;
  frameDropRate?: number;
  freezeCount: number;
  freezeDuration?: number;
  impairmentSeverity?: number;
  jitterBufferDelay: number;
  networkType?: string;
  networkDownlink?: number;
  networkRtt?: number;
  qualityLimitationReason?: string;
}

export interface DiscreteState {
  headroom: number;
  delivery: number;
  rtt: number;
  loss: number;
  jitter: number;
  freeze: number;
  currentA: number;
  currentB: number;
  switchAge: number;
  aggregateHeadroom: number;
}

export interface PolicyProfile {
  id: string;
  name: string;
  rewardMode: RewardMode;
  episodes: number;
  seed: number;
  minBandwidth: number;
  maxBandwidth: number;
  volatility: number;
  latency: number;
  loss: number;
  viewers: 1 | 2;
}

export interface EvaluationSummary {
  averageReward: number;
  averageLevel: number;
  freezeRate: number;
  switchRate: number;
  underutilization: number;
}

export interface QTableArtifact {
  schemaVersion: 2;
  id: string;
  createdAt: string;
  profile: PolicyProfile;
  levels: QualityLevel[];
  qTable: Record<string, number[]>;
  evaluation: EvaluationSummary;
}

export type SignalPayload =
  | { type: "join" }
  | { type: "offer"; sdp: RTCSessionDescriptionInit }
  | { type: "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "ice"; candidate: RTCIceCandidateInit }
  | { type: "leave" }
  | { type: "source-ended" };

export interface SignalEnvelope {
  seq: number;
  senderId: string;
  targetId: string;
  payload: SignalPayload;
  createdAt: number;
}

export interface RoomSession {
  code: string;
  participantId: string;
  token: string;
  expiresAt: number;
}

export interface TrainingProgress {
  episode: number;
  total: number;
  reward: number;
}

export interface ObsSpecNormalization {
  headroomScale: number; rttMsScale: number; jitterSecScale: number;
  levelMax: number; switchAgeSecScale: number; aggregateHeadroomScale: number;
}

export interface ObsSpec {
  version: number; maxViewers: number; historyLen: number; actionLevels: number;
  rewardModes: RewardMode[]; features: string[]; normalization: ObsSpecNormalization;
  neutralSlot: Record<string, number>;
}

export interface MlpLayer { W: number[][]; b: number[]; }

export interface MlpPolicyProfile {
  name: string;
  rewardModes: RewardMode[];    // modes this single model was trained to serve
  viewers: (1 | 2)[];
  sourceSeed?: number;
}

export interface MlpPolicyArtifact {
  schemaVersion: 3;
  kind: "mlp";
  id: string;
  createdAt: string;
  profile: MlpPolicyProfile;
  obsSpec: ObsSpec;
  layers: MlpLayer[];
  evaluation: EvaluationSummary;
}

// QTableArtifact keeps schemaVersion: 2 unchanged for backward compatibility;
// `kind` is optional there and defaults to "qtable" when absent.
export type PolicyArtifact = (QTableArtifact & { kind?: "qtable" }) | MlpPolicyArtifact;

export function isMlpPolicy(p: PolicyArtifact): p is MlpPolicyArtifact {
  return p.schemaVersion === 3 && (p as MlpPolicyArtifact).kind === "mlp";
}
export function isQTablePolicy(p: PolicyArtifact): p is QTableArtifact {
  return p.schemaVersion === 2;
}
