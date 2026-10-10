/**
 * The document and source contracts, mirrored from the API's Part 15 responses.
 *
 * `documentContractFrom` and `sourceContractFrom` are the only ways a value becomes one of
 * these types, so a body with a missing key or a wrong type is refused at the boundary
 * rather than reaching the render half-populated.
 *
 * Source text is untrusted input - a manager uploads it - and is therefore rendered as a
 * text node, never as markup. Nothing here interprets it.
 */

export type DocumentSummary = {
  document_id: string;
  title: string;
  access_role: string;
  revision: string;
};

export type DocumentListContract = {
  documents: DocumentSummary[];
};

export type SourceSection = {
  document_id: string;
  section_id: string;
  revision: string;
  title: string;
  heading_path: string[];
  text: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string): string {
  if (typeof value !== "string") throw new Error(`Invalid contract: ${where}`);
  return value;
}

export function documentContractFrom(value: unknown): DocumentListContract {
  if (!isRecord(value)) throw new Error("Invalid contract: documents");
  const { documents } = value;
  if (!Array.isArray(documents)) throw new Error("Invalid contract: documents");
  return {
    documents: documents.map((item, index) => {
      if (!isRecord(item)) throw new Error(`Invalid contract: documents[${index}]`);
      const documentId = text(item.document_id, `documents[${index}].document_id`);
      const title = text(item.title, `documents[${index}].title`);
      const accessRole = text(item.access_role, `documents[${index}].access_role`);
      const revision = text(item.revision, `documents[${index}].revision`);
      // An empty handle cannot be rendered as a link, and the API's own patterns would
      // have refused it, so a blank here means the body is not what it claims to be.
      if (!documentId || !title || !revision) {
        throw new Error(`Invalid contract: documents[${index}]`);
      }
      return { document_id: documentId, title, access_role: accessRole, revision };
    }),
  };
}

export function sourceContractFrom(value: unknown): SourceSection {
  if (!isRecord(value)) throw new Error("Invalid contract: source");
  const { heading_path: headingPath } = value;
  if (!Array.isArray(headingPath)) throw new Error("Invalid contract: source.heading_path");
  const source: SourceSection = {
    document_id: text(value.document_id, "source.document_id"),
    section_id: text(value.section_id, "source.section_id"),
    revision: text(value.revision, "source.revision"),
    title: text(value.title, "source.title"),
    heading_path: headingPath.map((item, index) => text(item, `source.heading_path[${index}]`)),
    // The document text, exactly as stored. Rendered as a text node.
    text: text(value.text, "source.text"),
  };
  if (!source.document_id || !source.section_id || !source.revision || !source.title) {
    throw new Error("Invalid contract: source");
  }
  return source;
}

/**
 * The identifier shapes the API accepts, repeated here.
 *
 * The API owns these patterns; this copy exists so a malformed handle is refused before a
 * request leaves the browser. It is deliberately not an import - the patterns belong to the
 * API's route definitions, and the proxy repeats them for the same reason.
 */
export const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const SECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const REVISION_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Whether a citation's three identifiers are present and well shaped.
 *
 * Takes `unknown` on purpose: the values come from a query string, where anything can
 * arrive, so the guard has to narrow rather than the caller being trusted to have done it.
 * Returns the narrowed handle so the caller never re-reads the raw parameters.
 */
export function sourceHandleFrom(value: {
  document_id: unknown;
  section_id: unknown;
  revision: unknown;
}): { document_id: string; section_id: string; revision: string } | null {
  const { document_id: documentId, section_id: sectionId, revision } = value;
  if (
    typeof documentId !== "string" ||
    !DOCUMENT_ID_PATTERN.test(documentId) ||
    typeof sectionId !== "string" ||
    !SECTION_ID_PATTERN.test(sectionId) ||
    typeof revision !== "string" ||
    !REVISION_PATTERN.test(revision)
  ) {
    return null;
  }
  return { document_id: documentId, section_id: sectionId, revision };
}

/**
 * The path to a section's page, carrying the revision that was actually cited.
 *
 * The revision travels in the URL rather than being looked up, because a citation is a
 * claim about a specific revision. Opening it without one would show whatever happens to be
 * current, which is exactly the drift a citation exists to prevent.
 */
export function sourcePath(source: {
  document_id: string;
  section_id: string;
  revision: string;
}): string {
  const query = new URLSearchParams({
    document: source.document_id,
    section: source.section_id,
    revision: source.revision,
  });
  return `/sources?${query.toString()}`;
}

/**
 * The proxy path that actually returns the section's text.
 *
 * A second function rather than a variant of `sourcePath` on purpose. The two are not the
 * same address in two forms: one is a page a person opens, the other is a JSON read behind
 * a session. Reusing the page address for the request made the inspector fetch itself - a
 * 200 carrying HTML, which the contract reader rejects, so a readable citation was reported
 * as a failed read rather than shown.
 */
export function sourceApiPath(source: {
  document_id: string;
  section_id: string;
  revision: string;
}): string {
  const documentId = encodeURIComponent(source.document_id);
  const sectionId = encodeURIComponent(source.section_id);
  const revision = encodeURIComponent(source.revision);
  return `/api/sources/${documentId}/sections/${sectionId}?revision=${revision}`;
}
