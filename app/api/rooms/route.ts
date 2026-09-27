import { NextResponse } from "next/server";
import { apiError } from "@/lib/server/http";
import { createRoom, isPersistentStore } from "@/lib/server/signaling-store";
import { enforceRateLimit } from "@/lib/server/rate-limit";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await enforceRateLimit(request, "create", 10);
    return NextResponse.json({ ...(await createRoom()), persistentSignaling: isPersistentStore() }, { status: 201 });
  } catch (error) { return apiError(error); }
}
