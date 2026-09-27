import { NextResponse } from "next/server";
import { StoreError } from "./signaling-store";

export function apiError(error: unknown) {
  if (error instanceof StoreError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(error);
  return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
}

export function credentials(request: Request) {
  const participantId = request.headers.get("x-participant-id") ?? "";
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!participantId || !token) throw new StoreError("Missing participant credentials", 401);
  return { participantId, token };
}
