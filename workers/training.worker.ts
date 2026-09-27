/// <reference lib="webworker" />
import { trainPolicy } from "@/lib/qlearning";
import type { PolicyProfile } from "@/lib/types";

self.onmessage = (event: MessageEvent<PolicyProfile>) => {
  try {
    const policy = trainPolicy(event.data, (episode, reward) => {
      self.postMessage({ type: "progress", progress: { episode, total: event.data.episodes, reward } });
    });
    self.postMessage({ type: "complete", policy });
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Training failed" });
  }
};

export {};
