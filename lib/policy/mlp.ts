export interface MlpLayer { W: number[][]; b: number[]; }

/**
 * Plain feed-forward pass. Every layer but the last applies tanh (SB3's
 * default PPO activation for MlpExtractor); the last layer is the raw
 * action_net output (logits), left unactivated.
 */
export function forward(layers: MlpLayer[], x: number[]): number[] {
  let h = x;
  layers.forEach((layer, i) => {
    const next = layer.b.map((bias, j) => {
      const row = layer.W[j];
      let sum = bias;
      for (let k = 0; k < row.length; k++) sum += row[k] * h[k];
      return sum;
    });
    h = i < layers.length - 1 ? next.map(Math.tanh) : next;
  });
  return h;
}

/** Argmax over one branch of logits, respecting a boolean mask (true = allowed). */
export function maskedArgmax(logits: number[], mask?: boolean[]): number {
  let bestIndex = -1;
  let bestValue = -Infinity;
  logits.forEach((value, index) => {
    if (mask && !mask[index]) return;
    if (value > bestValue) { bestValue = value; bestIndex = index; }
  });
  if (bestIndex === -1) return logits.indexOf(Math.max(...logits)); // mask excluded everything; ignore it
  return bestIndex;
}
