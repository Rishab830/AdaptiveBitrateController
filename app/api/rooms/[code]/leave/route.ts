import { NextResponse } from "next/server";
import { apiError } from "@/lib/server/http";
import { removeParticipant } from "@/lib/server/signaling-store";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const body = await request.json() as { participantId?: string; token?: string };
    if (!body.participantId || !body.token) return NextResponse.json({ error: "Missing participant credentials" }, { status: 401 });
    await removeParticipant(code.toUpperCase(), body.participantId, body.token);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
