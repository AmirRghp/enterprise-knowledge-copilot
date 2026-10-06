// A bounded check for common accidental disclosures, not a general DLP scanner.
// Inspect strings only: never execute page scripts or rewrite publication inputs.
import {
  createInlineDataScanner,
  createJsonMetadataScanner,
  createLiteralScanner,
  decodeBase64Chunks,
  decodePercentChunks,
  MAX_ACTIVE_TOKEN,
  MAX_DEPTH,
  TEXT_WINDOW,
  textChunks,
  validBase64,
} from "./publication-scan-streams.mjs";

const credentialField =
  /^(?:authorization|proxyauthorization|authcode|oauthcode|codeverifier|apikey|accesstoken|refreshtoken|idtoken|clientsecret|password|passwd|privatekey|secretaccesskey|awssecretaccesskey|credentials?|cookie|setcookie|connectionstring)$/u;
const metadataCredentialField = /^(?:secret|token|authtoken)$/u;
const credentialParameter =
  /^(?:key|secret|token|authorization|authcode|oauthcode|codeverifier|apikey|accesstoken|refreshtoken|idtoken|clientsecret|password|passwd|signature|sig|xamzsignature|xamzcredential|xgoogsignature|xgoogcredential)$/u;
const credentialPath =
  /(?:^|\/)(?:bearer|tokens?|access[_-]?tokens?|api[_-]?keys?|password|passwd|secrets?|credentials?|signatures?|sig|signed(?:url)?)(?:\/|[=:_-])[^/?#]+/iu;
// Plotly's fixed public help link names a documentation heading, not a token.
// Match the entire URL; do not exempt its host, bundle, or other fragments.
const publicTokenDocumentationUrl =
  "https://www.mapbox.com/api-documentation/#access-tokens-and-token-scopes";
const oauthCallbackPath = /(?:^|\/)(?:oauth2?(?:[-_]?callback)?|oidc|auth|callback|signin-oidc)(?:\/|\.|$)/iu;
const absoluteUrlStart = /\b(?:https?|postgres(?:ql)?|mysql|rediss?|mongodb(?:\+srv)?):\/\/(?=.)/iu;
const rootUrlStart = /(?<![\w/:])\/(?=.)/iu;
const dataUrlHeader =
  /\bdata:(text\/(?:javascript|ecmascript|plain|html|css)|application\/(?:javascript|ecmascript|json)|image\/svg\+xml)(?:;charset=[\w-]+)?(?:(;base64),|,)/giu;
const normalize = (key) => key.toLowerCase().replace(/[^a-z\d]/gu, "");
const nonemptyString = (value) => typeof value === "string" && value.trim() !== "";
const decodeUrlPart = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const disclosureMessage =
  "Publication contains a possible credential. Remove credentials from the artifact before publishing.";
const budgetMessage = "Publication exceeds the supported credential scan limits.";

const relativeUrlState = () => ({ offset: 0, start: -1, segment: false, slash: false, encoded: "", previous: "" });

// Track the relative-path grammar once, including across discarded text windows.
// Only a query/fragment boundary confirms a relative URL. Percent boundaries use
// %(25)*(3f|23), retaining partial pairs without buffering an encoded run.
function relativeUrlStart(text, state = relativeUrlState()) {
  let { offset, start, segment, slash, encoded, previous } = state;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if ((encoded === "%2" && character === "3") ||
        (encoded === "%3" && (character === "f" || character === "F"))) return start;
    encoded = encoded === "%" && (character === "2" || character === "3") ? `%${character}`
      : encoded === "%2" && character === "5" ? "%" : "";
    const segmentCharacter = /[a-z\d._~%-]/iu.test(character);
    if (start === -1 && segmentCharacter && (offset + index === 0 || !/[\w/:]/iu.test(previous))) {
      start = offset + index; segment = false; slash = false;
    }
    if (start !== -1) {
      if (slash && segment && (character === "?" || character === "#")) return start;
      if (character === "%" && slash && segment) encoded = "%";
      if (segmentCharacter) segment = true;
      else if (character === "/" && segment) { slash = true; segment = false; }
      else { start = -1; segment = false; slash = false; encoded = ""; }
    }
    previous = character;
  }
  Object.assign(state, { offset: offset + text.length, start, segment, slash, encoded, previous });
  return Infinity;
}

// The caller supplies one delimiter-free token. A matched URL consumes its rest.
function urlStart(text) {
  return Math.min(absoluteUrlStart.exec(text)?.index ?? Infinity, rootUrlStart.exec(text)?.index ?? Infinity,
    relativeUrlStart(text));
}

export function assertNoPublicationSecrets({ html, snapshotText, snapshotBytes, snapshotChunks: sourceChunks, seedSnapshot, initialPresentation }, { onProgress, signal } = {}) {
  const snapshotSources = [snapshotText, snapshotBytes, sourceChunks].filter(value => value !== undefined).length;
  const hasSnapshotSource = snapshotSources > 0;
  if (snapshotSources > 1) throw new Error("Supply one separate snapshot scan input.");
  if (snapshotText !== undefined && typeof snapshotText !== "string") throw new Error("The separate snapshot scan input must be text.");
  if (snapshotBytes !== undefined && !(snapshotBytes instanceof Uint8Array)) throw new Error("The separate snapshot scan input must be bytes.");
  if (sourceChunks !== undefined && !Array.isArray(sourceChunks)) throw new Error("The snapshot scan input must contain text chunks.");
  const started = performance.now();
  const stats = {
    complete: false,
    inspectedTextUnits: 0,
    decodedUnits: 0,
    fieldsVisited: 0,
    valuesVisited: 0,
    primitiveValuesSkipped: 0,
    maximumActiveDepth: 0,
    maximumTextWindowUnits: 0,
    urlCandidates: 0,
    inlineAssets: 0,
    elapsedMs: 0,
  };
  let nextProgress = 0;
  function progress(force = false) {
    if (signal?.aborted) throw new Error("Publication credential scan did not complete.");
    const work = stats.inspectedTextUnits + stats.decodedUnits + stats.fieldsVisited;
    if (force || work >= nextProgress) {
      stats.elapsedMs = performance.now() - started;
      onProgress?.({ ...stats });
      nextProgress = work + TEXT_WINDOW;
    }
  }
  const reject = () => { throw new Error(disclosureMessage); };
  const limit = () => { throw new Error(budgetMessage); };
  const depthChanged = (depth) => { stats.maximumActiveDepth = Math.max(stats.maximumActiveDepth, depth); };
  const seen = Object.fromEntries(
    ["snapshot", "queries", "query", "rows", "metadata"].map((scope) => [scope, new WeakSet()]),
  );
  // Only the current nested URL chain is retained, not every distinct cell.
  const activeText = [];

  function decodeUrlStructure(value) {
    // Stop at the URL's own parameter boundary. Decoding an outer query as a
    // whole can incorrectly attach its code filter to a nested callback URL.
    for (let depth = 0; !/[?#]/u.test(value) && /%[a-f\d]{2}/iu.test(value); depth += 1) {
      if (depth >= 8) limit();
      stats.decodedUnits += value.length;
      try {
        value = decodeURIComponent(value);
      } catch {
        break;
      }
    }
    return value;
  }

  function inspectUrls(text, depth) {
    const start = urlStart(text);
    if (start === Infinity) return false;
    const raw = text.slice(start);
    if (depth >= 8) limit();
    stats.urlCandidates += 1;
    const candidate = decodeUrlStructure(raw.replace(/&(?:amp|#38|#x26);/giu, "&"));
    let url;
    try {
      url = new URL(candidate, "https://publication.invalid");
    } catch {
      return true;
    }
    if (url.username || url.password) reject();
    const pathname = decodeUrlStructure(url.pathname);
    const fragment = decodeUrlPart(url.hash.slice(1));
    if (credentialPath.test(pathname) ||
        (candidate !== publicTokenDocumentationUrl && credentialPath.test(fragment.split("?")[0]))) {
      reject();
    }
    const fragmentPath = fragment.split("?")[0];
    const callback = oauthCallbackPath.test(pathname) || (!fragmentPath.includes("=") && oauthCallbackPath.test(fragmentPath));
    const parameterSets = [url.searchParams, new URLSearchParams(url.hash.slice(1))];
    if (fragment !== url.hash.slice(1)) parameterSets.push(new URLSearchParams(fragment));
    const fragmentQuery = fragment.indexOf("?");
    if (fragmentQuery !== -1) parameterSets.push(new URLSearchParams(fragment.slice(fragmentQuery + 1)));
    for (const parameters of parameterSets) {
      for (const [key, value] of parameters) {
        if ((credentialParameter.test(normalize(key)) || (callback && key.toLowerCase() === "code")) && nonemptyString(value)) {
          reject();
        }
        // Inspect one parameter at a time; do not queue all URL values.
        if (value) inspectText(decodeUrlStructure(value), depth + 1);
      }
    }
    if (pathname !== url.pathname) inspectText(pathname, depth);
    if (fragment !== url.hash.slice(1)) inspectText(fragment, depth);
    return true;
  }

  function createTextScanner(depth = 0) {
    depthChanged(depth);
    const literals = createLiteralScanner(reject);
    let token = "";
    let longToken = false;
    let longUrl = false;
    let relativePath = null;
    let tail = "";
    function flush() {
      if (!longToken) inspectUrls(token, depth);
      token = ""; longToken = false; longUrl = false; relativePath = null; tail = "";
    }
    function add(piece) {
      if (!piece) return;
      if (!longToken && token.length + piece.length <= MAX_ACTIVE_TOKEN) {
        token += piece;
        stats.maximumTextWindowUnits = Math.max(stats.maximumTextWindowUnits, token.length);
        return;
      }
      // Long opaque runs (notably base64) need no complete URL allocation.
      // Once a run has URL syntax, encoded/query/fragment continuations require
      // a bounded complete candidate. Fail closed instead of dropping its head.
      if (!longToken) {
        longUrl = inspectUrls(token, depth);
        if (longUrl && /[%?#]/u.test(token)) limit();
        relativePath = relativeUrlState();
        relativeUrlStart(token, relativePath);
        tail = token.slice(-256);
        token = "";
        longToken = true;
      }
      // The slash establishing a relative path may be far outside the tail.
      // Once a later boundary confirms it, the complete URL exceeds our budget.
      if (relativeUrlStart(piece, relativePath) !== Infinity) limit();
      const window = tail + piece;
      stats.maximumTextWindowUnits = Math.max(stats.maximumTextWindowUnits, window.length);
      const found = inspectUrls(window, depth);
      if ((longUrl || found) && /[%?#@:]/u.test(piece)) limit();
      longUrl ||= found;
      // A path credential's name and first value character have bounded width,
      // even if the complete opaque path is arbitrarily long.
      if (longUrl && credentialPath.test(window)) reject();
      tail = window.slice(-256);
    }
    return {
      write(text) {
        stats.inspectedTextUnits += text.length;
        literals.write(text);
        const delimiters = /[\s<>"'`\\]/gu;
        let offset = 0;
        for (const match of text.matchAll(delimiters)) {
          add(text.slice(offset, match.index));
          flush();
          offset = match.index + match[0].length;
        }
        add(text.slice(offset));
        progress();
      },
      finish() { literals.finish(); flush(); },
    };
  }

  function inspectText(value, depth = 0) {
    if (activeText.includes(value)) return;
    activeText.push(value);
    try {
      const scanner = createTextScanner(depth);
      for (const chunk of textChunks(value)) scanner.write(chunk);
      scanner.finish();
    } finally { activeText.pop(); }
  }

  function* entries(value) {
    if (Array.isArray(value)) {
      // JSON serializes array indices, not custom non-index properties. Avoid
      // for-in/Object.keys here: V8 may first materialize every index string.
      for (let index = 0; index < value.length; index += 1) {
        if (Object.hasOwn(value, index)) yield [String(index), value[index]];
      }
      return;
    }
    for (const key in value) if (Object.hasOwn(value, key)) yield [key, value[key]];
  }
  function inspectValue(value, scope) {
    stats.valuesVisited += 1;
    if (typeof value === "string") {
      if (!hasSnapshotSource) inspectText(value);
      else inspectDocumentText(value);
      return null;
    }
    if (value && typeof value === "object" && !seen[scope].has(value)) {
      seen[scope].add(value);
      return { iterator: entries(value), scope };
    }
    if (!value || typeof value !== "object") stats.primitiveValuesSkipped += 1;
    return null;
  }
  function inspectStructured(value, scope) {
    const first = inspectValue(value, scope);
    const active = first ? [first] : [];
    while (active.length) {
      depthChanged(active.length);
      const current = active.at(-1);
      const next = current.iterator.next();
      if (next.done) { active.pop(); continue; }
      const [key, entry] = next.value;
      stats.fieldsVisited += 1;
      if (hasSnapshotSource) inspectDocumentText(key);
      const scope = current.scope;
      if (typeof entry === "string") {
        const normalizedKey = normalize(key);
        if (
          (credentialField.test(normalizedKey) || (scope !== "rows" && metadataCredentialField.test(normalizedKey))) &&
          entry.trim() !== ""
        ) {
          reject();
        }
      }
      // Generic names such as token are allowed only in actual analytical rows.
      const nextScope = scope === "rows" ? "rows"
        : scope === "snapshot" && key === "queries" && !Array.isArray(entry) ? "queries"
        : scope === "queries" ? "query"
        : scope === "query" && key === "rows" && Array.isArray(entry) ? "rows"
        : "metadata";
      const child = inspectValue(entry, nextScope);
      if (child) {
        if (active.length >= MAX_DEPTH) limit();
        active.push(child);
      }
      progress();
    }
  }

  function inspectDocumentText(source) {
    inspectText(source);
    // Keep raw inspection plus one inline decode layer, as before. Decoders hold
    // at most one window, including base64 quanta and UTF-8 continuation state.
    const headers = new RegExp(dataUrlHeader);
    for (let match; (match = headers.exec(source));) {
      const [, mime, base64] = match;
      const start = headers.lastIndex;
      const terminator = base64 ? /[\s<>"'`#)]/gu : /[\s<>"'`]/gu;
      terminator.lastIndex = start;
      const end = terminator.exec(source)?.index ?? source.length;
      headers.lastIndex = end;
      if (end === start) continue;
      if (base64 && !validBase64(source, start, end)) continue;
      if (!base64) {
        const validation = decodePercentChunks(source, start, end);
        let valid = true;
        for (;;) {
          let next;
          try { next = validation.next(); }
          catch (error) {
            if (!(error instanceof URIError || error instanceof TypeError)) throw error;
            valid = false;
            break;
          }
          if (next.done) break;
          stats.decodedUnits += next.value.length;
          progress();
        }
        if (!valid) continue;
      }
      stats.inlineAssets += 1;
      const scanner = createTextScanner();
      const metadata = mime.toLowerCase() === "application/json" ? createJsonMetadataScanner({
        createTextScanner,
        credentialKey: (key) => credentialField.test(key) || metadataCredentialField.test(key),
        reject,
        limit,
        depthChanged,
      }) : null;
      const decoded = base64 ? decodeBase64Chunks(source, start, end) : decodePercentChunks(source, start, end);
      for (const chunk of decoded) {
        stats.decodedUnits += chunk.length;
        scanner.write(chunk);
        metadata?.write(chunk);
      }
      scanner.finish();
      metadata?.finish();
    }
  }
  progress(true);
  inspectDocumentText(html);
  // A separate snapshot is no longer physically inside the HTML. Scan its raw
  // text and inline assets as well as its parsed fields, including literal
  // credential patterns in keys and values overwritten by duplicate JSON keys.
  if (hasSnapshotSource) {
    const createSnapshotTextScanner = () => createInlineDataScanner({
      createTextScanner,
      createJsonScanner: () => createJsonMetadataScanner({
        createTextScanner,
        credentialKey: key => credentialField.test(key) || metadataCredentialField.test(key),
        reject, limit, depthChanged,
      }),
      decoded: units => { stats.decodedUnits += units; progress(); },
      inlineAsset: () => { stats.inlineAssets += 1; },
    });
    const document = createSnapshotTextScanner();
    // JSON escape spelling and overwritten members still exist in the raw
    // immutable asset. Inspect every decoded key/string in snapshot scope,
    // without creating another object graph or serializing the full dataset.
    const rawSnapshot = createJsonMetadataScanner({
      rootScope: "snapshot", scanKeys: true,
      createTextScanner: createSnapshotTextScanner,
      credentialKey: (key, scope) => credentialField.test(key) || (scope !== "rows" && metadataCredentialField.test(key)),
      reject, limit, depthChanged,
    });
    function* snapshotChunks() {
      if (snapshotText !== undefined) { yield* textChunks(snapshotText); return; }
      if (sourceChunks !== undefined) {
        for (const chunk of sourceChunks) {
          if (typeof chunk !== "string") throw new Error("The snapshot scan input must contain text chunks.");
          yield* textChunks(chunk);
        }
        return;
      }
      const decoder = new TextDecoder("utf-8", { fatal: true });
      try {
        for (let offset = 0; offset < snapshotBytes.length; offset += TEXT_WINDOW) {
          yield decoder.decode(snapshotBytes.subarray(offset, offset + TEXT_WINDOW), { stream: true });
        }
        yield decoder.decode();
      } catch {
        throw new Error("The separate Data snapshot must contain valid UTF-8 JSON.");
      }
    }
    for (const chunk of snapshotChunks()) { document.write(chunk); rawSnapshot.write(chunk); progress(); }
    document.finish();
    rawSnapshot.finish();
  }
  inspectStructured(initialPresentation, "metadata");
  inspectStructured(seedSnapshot, "snapshot");
  stats.complete = true;
  progress(true);
  return { ...stats };
}
