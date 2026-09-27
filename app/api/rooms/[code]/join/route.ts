import { NextResponse } from "next/server";
import { apiError } from "@/lib/server/http";
import { joinRoom } from "@/lib/server/signaling-store";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request, context: { params: Promise<{ code: string }> }) {
  try {
    await enforceRateLimit(request, "join", 20);
    const { code } = await context.params;
    return NextResponse.json(await joinRoom(code.toUpperCase()), { status: 201 });
  } catch (error) { return apiError(error); }
}
