import { QUALITY_LEVELS, REWARD_WEIGHTS } from "./levels";
import type { DiscreteState, EvaluationSummary, PeerTelemetry, PolicyProfile, QTableArtifact } from "./types";

const bins = (value: number, edges: number[]) => edges.findIndex((edge) => value < edge) === -1
  ? edges.length
  : edges.findIndex((edge) => value < edge);

export function discretizeState(
  peers: PeerTelemetry[],
  current: number[],
  secondsSinceSwitch: number,
): DiscreteState {
  const target = QUALITY_LEVELS[current[0] ?? 0].videoBitrate;
  const capacityFor = (peer: PeerTelemetry, index: number) => {
    const observed = peer.outboundBitrate || QUALITY_LEVELS[current[index] ?? 0].videoBitrate;
    const estimates = [peer.availableOutgoingBitrate, peer.networkDownlink ? peer.networkDownlink * 1_000_000 : undefined]
      .filter((value): value is number => Boolean(value && value > 0));
    return estimates.length ? Math.min(...estimates) : observed;
  };
  const headrooms = peers.map((peer, index) => {
    const peerTarget = QUALITY_LEVELS[current[index] ?? current[0] ?? 0].videoBitrate;
    return capacityFor(peer, index) / peerTarget;
  });
  const deliveries = peers.map((peer, index) => {
    const peerTarget = QUALITY_LEVELS[current[index] ?? current[0] ?? 0].videoBitrate;
    return (peer.inboundBitrate || peer.outboundBitrate || 0) / peerTarget;
  });
  const totalAvailable = peers.reduce((sum, peer, index) => sum + capacityFor(peer, index), 0);
  const totalTarget = current.reduce((sum, level) => sum + QUALITY_LEVELS[level].videoBitrate, 0) || target;
  return {
    headroom: bins(headrooms.length ? Math.min(...headrooms) : 1, [0.75, 1, 1.5, 2.5]),
    delivery: bins(deliveries.length ? Math.min(...deliveries) : 0, [0.6, 0.85, 1, 1.25]),
    rtt: bins(Math.max(...peers.map((peer) => peer.rtt), 0), [75, 150, 300]),
    loss: bins(Math.max(...peers.map((peer) => peer.packetLoss), 0), [0.01, 0.03, 0.08]),
    jitter: bins(Math.max(...peers.map((peer) => peer.jitter), 0), [0.03, 0.075]),
    freeze: peers.some((peer) => peer.freezeCount > 0 || peer.framesDropped > 5) ? 1 : 0,
    currentA: current[0] ?? 0,
    currentB: current[1] ?? 0,
    switchAge: bins(secondsSinceSwitch, [4, 10]),
    aggregateHeadroom: bins(totalAvailable / totalTarget, [0.75, 1, 1.5, 2.5]),
  };
}

export function stateKey(state: DiscreteState) {
  return [state.headroom, state.delivery, state.rtt, state.loss, state.jitter, state.freeze,
    state.currentA, state.currentB, state.switchAge, state.aggregateHeadroom].join("|");
}

export function encodeAction(a: number, b: number, viewers: 1 | 2) {
  return viewers === 1 ? a : a * QUALITY_LEVELS.length + b;
}

export function decodeAction(action: number, viewers: 1 | 2): number[] {
  return viewers === 1 ? [action] : [Math.floor(action / QUALITY_LEVELS.length), action % QUALITY_LEVELS.length];
}

export function rewardFor(
  levels: number[], previous: number[], capacity: number, froze: boolean, mode: PolicyProfile["rewardMode"],
) {
  const w = REWARD_WEIGHTS[mode];
  const targets = levels.map((level) => QUALITY_LEVELS[level].videoBitrate);
  const requested = targets.reduce((a, b) => a + b, 0);
  const quality = levels.reduce((sum, level) => sum + level / (QUALITY_LEVELS.length - 1), 0) / levels.length;
  const switches = levels.reduce((sum, level, index) => sum + Math.abs(level - (previous[index] ?? 0)) / 4, 0) / levels.length;
  const sustainable = Math.min(1, capacity / Math.max(requested, 1));
  const underuse = Math.max(0, capacity - requested) / Math.max(capacity, 1);
  const overload = Math.max(0, requested - capacity) / Math.max(capacity, 1);
  return w.quality * quality - w.freeze * (froze ? 1 : overload) - w.switching * switches - w.underuse * underuse * sustainable;
}

function mulberry32(seed: number) {
  return () => {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function maxIndex(values: number[], random: () => number) {
  const max = Math.max(...values);
  const candidates = values.flatMap((value, index) => value === max ? [index] : []);
  return candidates[Math.floor(random() * candidates.length)];
}

export function trainPolicy(profile: PolicyProfile, onProgress?: (episode: number, reward: number) => void): QTableArtifact {
  const random = mulberry32(profile.seed);
  const qTable: Record<string, number[]> = {};
  const actionCount = profile.viewers === 1 ? 5 : 25;
  let bandwidth = (profile.minBandwidth + profile.maxBandwidth) / 2;
  let current = Array(profile.viewers).fill(0) as number[];

  for (let episode = 0; episode < profile.episodes; episode++) {
    const noise = (random() * 2 - 1) * profile.volatility * (profile.maxBandwidth - profile.minBandwidth);
    bandwidth = Math.min(profile.maxBandwidth, Math.max(profile.minBandwidth, bandwidth * 0.75 + ((profile.minBandwidth + profile.maxBandwidth) / 2 + noise) * 0.25));
    const deliveryRatio = Math.min(1.3, bandwidth / Math.max(QUALITY_LEVELS[current[0]].videoBitrate * profile.viewers, 1));
    const synthetic: PeerTelemetry = {
      timestamp: episode,
      outboundBitrate: QUALITY_LEVELS[current[0]].videoBitrate * deliveryRatio,
      inboundBitrate: QUALITY_LEVELS[current[0]].videoBitrate * deliveryRatio,
      availableOutgoingBitrate: bandwidth / profile.viewers,
      rtt: profile.latency * (0.7 + random() * 0.6),
      packetLoss: Math.max(0, profile.loss + (random() - 0.5) * 0.02),
      jitter: profile.latency / 3000 * (0.5 + random()),
      framesDropped: deliveryRatio < 0.8 ? 8 : 0,
      framesDecoded: 60,
      freezeCount: deliveryRatio < 0.65 ? 1 : 0,
      jitterBufferDelay: profile.latency / 1000,
    };
    const state = discretizeState(Array(profile.viewers).fill(synthetic), current, random() * 14);
    const key = stateKey(state);
    qTable[key] ??= Array(actionCount).fill(0);
    const epsilon = Math.max(0.05, 1 - episode / (profile.episodes * 0.8));
    const action = random() < epsilon ? Math.floor(random() * actionCount) : maxIndex(qTable[key], random);
    const next = decodeAction(action, profile.viewers);
    const requested = next.reduce((sum, level) => sum + QUALITY_LEVELS[level].videoBitrate, 0);
    const froze = requested > bandwidth * (0.95 - profile.loss);
    const reward = rewardFor(next, current, bandwidth, froze, profile.rewardMode);
    const nextSynthetic = { ...synthetic, freezeCount: froze ? 1 : 0, availableOutgoingBitrate: bandwidth / profile.viewers };
    const nextKey = stateKey(discretizeState(Array(profile.viewers).fill(nextSynthetic), next, 2));
    qTable[nextKey] ??= Array(actionCount).fill(0);
    qTable[key][action] += 0.1 * (reward + 0.95 * Math.max(...qTable[nextKey]) - qTable[key][action]);

    current = next;
    if (episode % Math.max(1, Math.floor(profile.episodes / 100)) === 0) onProgress?.(episode, reward);
  }

  const evaluation = evaluatePolicy(profile, qTable);
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    profile,
    levels: QUALITY_LEVELS,
    qTable,
    evaluation,
  };
}

export function evaluatePolicy(profile: PolicyProfile, qTable: Record<string, number[]>, steps = 1000): EvaluationSummary {
  const random = mulberry32(profile.seed + 7_919);
  let bandwidth = (profile.minBandwidth + profile.maxBandwidth) / 2;
  let current = Array(profile.viewers).fill(0) as number[];
  let rewardTotal = 0, switches = 0, freezes = 0, levelTotal = 0, underuseTotal = 0;
  for (let step = 0; step < steps; step++) {
    const shock = random() < 0.08 ? (random() * 2 - 1) * 0.7 : 0;
    const noise = ((random() * 2 - 1) * profile.volatility + shock) * (profile.maxBandwidth - profile.minBandwidth);
    bandwidth = Math.min(profile.maxBandwidth, Math.max(profile.minBandwidth, bandwidth * 0.8 + ((profile.minBandwidth + profile.maxBandwidth) / 2 + noise) * 0.2));
    const currentTarget = current.reduce((sum, level) => sum + QUALITY_LEVELS[level].videoBitrate, 0);
    const ratio = Math.min(1.3, bandwidth / Math.max(currentTarget, 1));
    const synthetic: PeerTelemetry = {
      timestamp: step, outboundBitrate: currentTarget / profile.viewers * ratio, inboundBitrate: currentTarget / profile.viewers * ratio,
      availableOutgoingBitrate: bandwidth / profile.viewers, rtt: profile.latency * (0.8 + random() * 0.8), packetLoss: Math.max(0, profile.loss + (random() - 0.5) * 0.03),
      jitter: profile.latency / 2500 * (0.5 + random()), framesDropped: ratio < 0.8 ? 8 : 0, framesDecoded: 60,
      freezeCount: ratio < 0.65 ? 1 : 0, jitterBufferDelay: profile.latency / 1000,
    };
    const state = discretizeState(Array(profile.viewers).fill(synthetic), current, step % 8);
    const values = qTable[stateKey(state)];
    const action = values ? values.indexOf(Math.max(...values)) : encodeAction(Math.max(0, Math.min(4, state.headroom + state.currentA - 2)), Math.max(0, Math.min(4, state.headroom + state.currentB - 2)), profile.viewers);
    const next = decodeAction(action, profile.viewers);
    const requested = next.reduce((sum, level) => sum + QUALITY_LEVELS[level].videoBitrate, 0);
    const froze = requested > bandwidth * (0.95 - profile.loss);
    rewardTotal += rewardFor(next, current, bandwidth, froze, profile.rewardMode);
    switches += next.some((level, index) => level !== current[index]) ? 1 : 0;
    freezes += froze ? 1 : 0;
    levelTotal += next.reduce((a, b) => a + b, 0) / next.length;
    underuseTotal += Math.max(0, bandwidth - requested) / Math.max(bandwidth, 1);
    current = next;
  }
  return { averageReward: rewardTotal / steps, averageLevel: levelTotal / steps, freezeRate: freezes / steps, switchRate: switches / steps, underutilization: underuseTotal / steps };
}

export function selectAction(policy: QTableArtifact | undefined, state: DiscreteState, viewers: 1 | 2) {
  const values = policy?.qTable[stateKey(state)];
  if (values?.length) {
    const action = values.indexOf(Math.max(...values));
    return { levels: decodeAction(action, viewers), qValue: values[action], fallback: false };
  }
  const safeLevel = Math.max(0, Math.min(4, state.headroom + state.currentA - 2));
  return { levels: Array(viewers).fill(safeLevel) as number[], qValue: 0, fallback: true };
}
