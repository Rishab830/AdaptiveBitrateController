import { NextResponse } from "next/server";
import { apiError, credentials } from "@/lib/server/http";
import { removeParticipant } from "@/lib/server/signaling-store";

export async function DELETE(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    const { code } = await context.params;
    const { participantId, token } = credentials(request);
    await removeParticipant(code.toUpperCase(), participantId, token);
    return NextResponse.json({ ok: true });
  } catch (error) { return apiError(error); }
}
