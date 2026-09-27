"use client";

import { useEffect, useRef } from "react";
import { pollSignals } from "@/lib/signaling-client";
import type { RoomSession, SignalEnvelope } from "@/lib/types";

export function useSignalPoll(session: RoomSession | null, onSignal: (signal: SignalEnvelope) => void | Promise<void>) {
  const handler = useRef(onSignal);
  useEffect(() => { handler.current = onSignal; }, [onSignal]);
  useEffect(() => {
    if (!session) return;
    let cursor = 0;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled) {
        try {
          const response = await pollSignals(session, cursor);
          // SDP and ICE messages are order-dependent. Await each handler so a
          // candidate can never overtake the offer/answer that makes it valid.
          for (const signal of response.signals) {
            await handler.current(signal);
            cursor = signal.seq;
          }
        } catch (error) {
          if (!cancelled) console.warn("Signal polling failed", error);
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [session]);
}
