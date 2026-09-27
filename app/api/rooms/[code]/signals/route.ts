import { NextResponse } from "next/server";
import { apiError, credentials } from "@/lib/server/http";
import { appendSignal, readSignals } from "@/lib/server/signaling-store";
import type { SignalPayload } from "@/lib/types";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const { participantId, token } = credentials(request);
    const cursor = Number(new URL(request.url).searchParams.get("cursor") ?? 0);
    const signals = await readSignals(code.toUpperCase(), participantId, token, cursor);
    return NextResponse.json({ signals, cursor: signals.at(-1)?.seq ?? cursor });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    await enforceRateLimit(request, "signal", 600);
    const { code } = await context.params;
    const { participantId, token } = credentials(request);
    const body = await request.json() as { targetId?: string; payload?: SignalPayload };
    if (!body.targetId || !body.payload?.type) return NextResponse.json({ error: "targetId and payload are required" }, { status: 400 });
    return NextResponse.json(await appendSignal(code.toUpperCase(), participantId, token, body.targetId, body.payload), { status: 201 });
  } catch (error) { return apiError(error); }
}
