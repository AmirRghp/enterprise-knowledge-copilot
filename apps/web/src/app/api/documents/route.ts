import { type NextRequest } from "next/server";
import { forwardRead } from "../read-proxy";

export async function GET(request: NextRequest) {
  // No query is accepted here. An unknown parameter on a list is either a client that will
  // be surprised by the ignored value or a caller probing for a filter the allowlist does
  // not have; either way it deserves a refusal rather than a silent full list.
  if (request.nextUrl.search) return Response.json({ detail: "not found" }, { status: 404 });
  return forwardRead(request, "/api/documents", "");
}
