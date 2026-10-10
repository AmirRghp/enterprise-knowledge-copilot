import { type NextRequest } from "next/server";
import { DOCUMENT_ID_PATTERN, REVISION_PATTERN, SECTION_ID_PATTERN } from "@/lib/document-contract";
import { forwardRead, proxyFailure } from "@/app/api/read-proxy";

/**
 * Read one cited section.
 *
 * The three identifier shapes are checked here, before anything is forwarded, so a
 * malformed handle costs this proxy one regex rather than a round trip and a log line. The
 * API enforces the same patterns; repeating them is what the manager proxy already does,
 * and it is worth the duplication because each copy has to be right independently.
 *
 * A rejected handle answers 404, not 422. The API's own three refusals - absent, forbidden,
 * stale - are one byte-identical body, and adding a fourth distinguishable answer for a
 * malformed id would make this path the one place where the shape of a request, rather
 * than the authorization, decides what a caller learns.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // This route lives at `api/sources/[...path]`, so Next hands it everything *after*
  // `api/sources`: three segments, `{document_id}/sections/{section_id}`. The `sources`
  // segment is part of the route's own directory and is not in the param - reading it out
  // of `path[0]` matched nothing, and every well-formed citation was refused.
  const [documentId, sections, sectionId] = path;
  if (sections !== "sections" || !documentId || !sectionId) {
    return proxyFailure(404);
  }
  if (!DOCUMENT_ID_PATTERN.test(documentId) || !SECTION_ID_PATTERN.test(sectionId)) {
    return proxyFailure(404);
  }

  const revision = request.nextUrl.searchParams.get("revision");
  // Exactly one parameter, and it must be the revision. An extra parameter is refused
  // rather than dropped, because a caller that sent one expects it to mean something.
  if (!revision || !REVISION_PATTERN.test(revision)) return proxyFailure(404);
  if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "revision")) {
    return proxyFailure(404);
  }

  const search = `?revision=${encodeURIComponent(revision)}`;
  return forwardRead(
    request,
    `/api/sources/${encodeURIComponent(documentId)}/sections/${encodeURIComponent(sectionId)}`,
    search,
  );
}
