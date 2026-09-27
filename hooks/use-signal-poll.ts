"use client";

import { useEffect, useRef } from "react";
import { pollSignals } from "@/lib/signaling-client";
import type { RoomSession, SignalEnvelope } from "@/lib/types";

export function useSignalPoll(session: RoomSession | null, onSignal: (signal: SignalEnvelope) => void) {
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
          cursor = response.cursor;
          response.signals.forEach((signal) => handler.current(signal));
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
