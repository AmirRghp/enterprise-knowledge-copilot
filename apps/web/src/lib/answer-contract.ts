/**
 * The answer contract, mirrored from the API's `AnswerResponse`.
 *
 * The API serves exactly five keys and nothing else. `answerContractFrom` is the
 * only way a value becomes an `AnswerContract`, so a body with a missing key, an
 * extra key, or a wrong type is refused at the boundary rather than reaching the
 * render as a half-populated object. Rendering `undefined` as empty text would
 * look like an abstention, and an abstention is a claim the system makes about
 * evidence — it must not be produced by a shape mismatch.
 *
 * `sources` carry no title. That is deliberate: the API does not put one there,
 * and this part does not fetch `/api/documents` to add it. Part 17 joins the
 * title. Inventing one here would mean shipping a citation that names no
 * document.
 */

export type Citation = {
  document_id: string;
  section_id: string;
  revision: string;
  document_title?: string;
  section_title?: string;
};

export type Claim = {
  text: string;
  quote: string;
  source: Citation;
};

export type AnswerContract = {
  answer: string;
  claims: Claim[];
  sources: Citation[];
  abstained: boolean;
  request_id: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function citationFrom(value: unknown, where: string): Citation {
  if (!isRecord(value)) throw new Error(`Invalid answer: ${where}.source`);
  const { document_id, section_id, revision } = value;
  if (
    typeof document_id !== "string" ||
    typeof section_id !== "string" ||
    typeof revision !== "string"
  ) {
    throw new Error(`Invalid answer: ${where}.source`);
  }
  // A bare string is not a usable citation handle; the API's own id patterns
  // require these shapes, so an empty one can only be a malformed body.
  if (!document_id || !section_id || !revision) throw new Error(`Invalid answer: ${where}.source`);
  const documentTitle = value.document_title;
  const sectionTitle = value.section_title;
  return {
    document_id,
    section_id,
    revision,
    ...(typeof documentTitle === "string" ? { document_title: documentTitle } : {}),
    ...(typeof sectionTitle === "string" ? { section_title: sectionTitle } : {}),
  };
}

function claimFrom(value: unknown, index: number): Claim {
  const where = `claims[${index}]`;
  if (!isRecord(value)) throw new Error(`Invalid answer: ${where}`);
  const { text, quote, source } = value;
  if (typeof text !== "string" || typeof quote !== "string")
    throw new Error(`Invalid answer: ${where}`);
  return { text, quote, source: citationFrom(source, where) };
}

/** The five keys, and nothing else. */
const KEYS = ["answer", "claims", "sources", "abstained", "request_id"] as const;

export function answerContractFrom(value: unknown): AnswerContract {
  if (!isRecord(value)) throw new Error("Invalid answer.");
  const keys = Object.keys(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => key in value)) {
    throw new Error("Invalid answer.");
  }
  const { answer, claims, sources, abstained, request_id: requestId } = value;
  if (
    typeof answer !== "string" ||
    typeof abstained !== "boolean" ||
    typeof requestId !== "string"
  ) {
    throw new Error("Invalid answer.");
  }
  if (!Array.isArray(claims) || !Array.isArray(sources)) throw new Error("Invalid answer.");
  if (!requestId) throw new Error("Invalid answer.");
  return {
    answer,
    abstained,
    request_id: requestId,
    claims: claims.map(claimFrom),
    sources: sources.map((item, index) => citationFrom(item, `sources[${index}]`)),
  };
}

/**
 * Whether the response is an abstention that still carries a body.
 *
 * Part 14 serves an abstention as a normal 200 with `abstained: true`, so this
 * is the one case where a non-empty `answer` is expected and is not a contract
 * violation.
 */
export function hasBody(contract: AnswerContract): boolean {
  return contract.claims.length > 0 || contract.sources.length > 0;
}
