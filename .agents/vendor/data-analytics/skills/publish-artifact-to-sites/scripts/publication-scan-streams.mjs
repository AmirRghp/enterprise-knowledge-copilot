// Streaming helpers for publication inspection. They consume text, never execute it.
export const TEXT_WINDOW = 64 * 1024;
export const MAX_ACTIVE_TOKEN = 1024 * 1024;
export const MAX_DEPTH = 128;

export function* textChunks(text, start = 0, end = text.length) {
  for (let offset = start; offset < end; offset += TEXT_WINDOW) {
    yield text.slice(offset, Math.min(offset + TEXT_WINDOW, end));
  }
}

// A small NFA retains only match states across chunks. In particular, private-key
// labels, bearer whitespace and JWT segments have no finite overlap length.
// A fixed suffix window would silently miss those patterns at chunk boundaries.
const word = (character) => /[a-z\d_]/iu.test(character);
const insensitive = (expected) => {
  const exact = new RegExp(`^${expected.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&")}$`, "iu");
  return (character) => exact.test(character);
};
const pattern = (source) => (character) => source.test(character);
const literal = (text) => [...text.toLowerCase()].map((character) => ({ accepts: insensitive(character) }));
const chars = (source) => [{ accepts: pattern(source) }];
const sequence = (...parts) => parts.flat();
const either = (...parts) => [{ alternatives: parts }];
const repeat = (part, min = 0, max = Infinity) => [{ repeat: part, min, max }];
const boundary = [{ boundary: true }];
const keyBody = chars(/[a-z\d_-]/iu);
const jwtBody = chars(/[a-z\d_-]/iu);
const secretPattern = either(
  sequence(literal("-----BEGIN "), either([], sequence(repeat(chars(/[a-z ]/iu), 1), literal(" "))), literal("PRIVATE KEY-----")),
  sequence(boundary, literal("bearer"), repeat(chars(/\s/u), 1), repeat(chars(/[a-z\d._~+/-]/iu), 16), repeat(literal("="), 0, 2)),
  sequence(boundary, literal("eyj"), repeat(jwtBody, 5), literal(".eyj"), repeat(jwtBody, 5), literal("."), repeat(jwtBody, 16), boundary),
  sequence(boundary, either(
    sequence(literal("sk-"), either([], literal("proj-"), literal("svcacct-"), literal("live_"), literal("test_")), repeat(keyBody, 20)),
    sequence(either(sequence(literal("gh"), chars(/[pousr]/iu), literal("_")), literal("github_pat_")), repeat(chars(/[a-z\d_]/iu), 20)),
    sequence(literal("xox"), chars(/[baprs]/iu), literal("-"), repeat(chars(/[a-z\d-]/iu), 20)),
    sequence(literal("akia"), repeat(chars(/[a-z\d]/iu), 16, 16)),
    sequence(literal("aiza"), repeat(chars(/[a-z\d_-]/iu), 35, 35)),
  ), boundary),
);

function compile(parts, next) {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.alternatives) next = { branches: part.alternatives.map((branch) => compile(branch, next)) };
    else if (part.repeat) {
      if (part.max === Infinity) {
        const loop = { branches: [] };
        loop.branches = [next, compile(part.repeat, loop)];
        next = loop;
      } else {
        for (let count = part.min; count < part.max; count += 1) next = { branches: [next, compile(part.repeat, next)] };
      }
      for (let count = 0; count < part.min; count += 1) next = compile(part.repeat, next);
    } else next = { ...part, next };
  }
  return next;
}
const secretStart = compile(secretPattern, { matched: true });

export function createLiteralScanner(reject) {
  let active = new Set();
  let previous = "";
  const candidates = /[-bsegxa]/giu;
  function advance(character, addStart) {
    const visited = new Set();
    const pending = [...active];
    if (addStart) pending.push(secretStart);
    const next = new Set();
    while (pending.length) {
      const state = pending.pop();
      if (visited.has(state)) continue;
      visited.add(state);
      if (state.matched) reject();
      else if (state.branches) pending.push(...state.branches);
      else if (state.boundary) {
        if (word(previous) !== word(character)) pending.push(state.next);
      } else if (character && state.accepts(character)) next.add(state.next);
    }
    active = next;
    previous = character;
  }
  return {
    write(text) {
      for (let index = 0; index < text.length; index += 1) {
        if (!active.size) {
          candidates.lastIndex = index;
          const candidate = candidates.exec(text);
          if (!candidate) {
            previous = text.at(-1) ?? previous;
            break;
          }
          if (candidate.index > index) previous = text[candidate.index - 1];
          index = candidate.index;
        }
        const character = text[index];
        advance(character, character === "-" || !word(previous));
      }
    },
    finish() { advance("", false); },
  };
}

export function* decodeBase64Chunks(text, start, end) {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  for (const chunk of textChunks(text, start, end)) {
    // TEXT_WINDOW is divisible by four; only the final chunk may be partial.
    yield decoder.decode(Buffer.from(chunk, "base64"), { stream: true });
  }
  yield decoder.decode();
}

export function validBase64(text, start, end) {
  let padding = false;
  let paddingCount = 0;
  for (const chunk of textChunks(text, start, end)) {
    const firstPadding = chunk.indexOf("=");
    if (padding && /[^=]/u.test(chunk)) return false;
    if (firstPadding === -1) {
      if (!/^[a-z\d+/]*$/iu.test(chunk)) return false;
    } else {
      if (!/^[a-z\d+/]*$/iu.test(chunk.slice(0, firstPadding)) || /[^=]/u.test(chunk.slice(firstPadding))) return false;
      padding = true;
      paddingCount += chunk.length - firstPadding;
    }
    if (paddingCount > 2) return false;
  }
  return true;
}

// decodeURIComponent semantics without constructing a complete decoded asset.
// Callers validate a pass before inspecting so a malformed escape late in a
// data URL cannot turn its partially decoded prefix into a new interpretation.
export function* decodePercentChunks(text, start, end) {
  let offset = start;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  while (offset < end) {
    if (text[offset] !== "%") {
      const percent = text.indexOf("%", offset);
      const stop = percent < 0 ? end : Math.min(percent, end);
      yield* textChunks(text, offset, stop);
      offset = stop;
      continue;
    }
    const bytes = new Uint8Array(TEXT_WINDOW);
    let count = 0;
    while (offset < end && text[offset] === "%") {
      const hex = text.slice(offset + 1, offset + 3);
      if (offset + 3 > end || !/^[a-f\d]{2}$/iu.test(hex)) throw new URIError("Invalid percent encoding");
      bytes[count++] = Number.parseInt(hex, 16);
      offset += 3;
      if (count === bytes.length) {
        yield decoder.decode(bytes, { stream: true });
        count = 0;
      }
    }
    yield decoder.decode(bytes.subarray(0, count));
  }
}

const inlineMimes = [
  "text/javascript", "text/ecmascript", "text/plain", "text/html", "text/css",
  "application/javascript", "application/ecmascript", "application/json", "image/svg+xml",
];
const inlinePrefixes = inlineMimes.map((mime) => `data:${mime}`);
const foldHeader = (character) => character.toLowerCase().replace(/ſ/gu, "s");

// JSON decoding can reveal a data-URL header that was escaped in the raw file,
// including a duplicate property discarded by JSON.parse. Inspect that decoded
// string incrementally. Payload errors are deferred until the entire URI is
// valid, matching the existing validate-before-decode interpretation. No whole
// string, payload, or decoded object graph is retained and decoding is one layer.
export function createInlineDataScanner({ createTextScanner, createJsonScanner = () => null, decoded = () => {}, inlineAsset = () => {} }) {
  const raw = createTextScanner();
  let previous = "";
  let header = "";
  let phase = "seek";
  let mime = "";
  let suffixOffset = 0;
  let charsetLength = 0;
  let payload;

  function startPayload(base64) {
    const scanner = createTextScanner();
    const metadata = mime === "application/json" ? createJsonScanner() : null;
    let error;
    let invalid = false;
    let length = 0;
    let padding = false;
    let paddingCount = 0;
    let carry = "";
    const decoder = new TextDecoder("utf-8", { fatal: !base64, ignoreBOM: true });
    const bytes = base64 ? null : new Uint8Array(TEXT_WINDOW);
    let byteCount = 0;
    let percentRun = false;
    function inspect(text) {
      if (error || !text) return;
      try { decoded(text.length); scanner.write(text); metadata?.write(text); }
      catch (caught) { error = caught; }
    }
    function percentBytes(final) {
      try { inspect(decoder.decode(bytes.subarray(0, byteCount), { stream: !final })); }
      catch (caught) {
        if (!(caught instanceof TypeError)) throw caught;
        invalid = true;
      }
      byteCount = 0;
      if (final) percentRun = false;
    }
    payload = {
      base64,
      write(text) {
        length += text.length;
        if (invalid) return;
        if (base64) {
          const firstPadding = text.indexOf("=");
          if ((padding && /[^=]/u.test(text)) ||
            (firstPadding === -1 ? !/^[a-z\d+/]*$/iu.test(text)
              : !/^[a-z\d+/]*$/iu.test(text.slice(0, firstPadding)) || /[^=]/u.test(text.slice(firstPadding)))) {
            invalid = true; return;
          }
          if (firstPadding !== -1) { padding = true; paddingCount += text.length - firstPadding; }
          if (paddingCount > 2) { invalid = true; return; }
          const available = carry + text;
          const stop = available.length - available.length % 4;
          inspect(decoder.decode(Buffer.from(available.slice(0, stop), "base64"), { stream: true }));
          carry = available.slice(stop);
          return;
        }
        let offset = 0;
        while (offset < text.length && !invalid) {
          if (carry || text[offset] === "%") {
            if (!carry) { carry = "%"; offset += 1; }
            while (carry.length < 3 && offset < text.length) carry += text[offset++];
            if (carry.length < 3) break;
            if (!/^%[a-f\d]{2}$/iu.test(carry)) { invalid = true; break; }
            bytes[byteCount++] = Number.parseInt(carry.slice(1), 16);
            carry = ""; percentRun = true;
            if (byteCount === bytes.length) percentBytes(false);
          } else {
            if (percentRun) percentBytes(true);
            if (invalid) break;
            const next = text.indexOf("%", offset);
            const end = next === -1 ? text.length : next;
            inspect(text.slice(offset, end)); offset = end;
          }
        }
      },
      finish() {
        if (invalid || !length) return;
        if (base64) {
          inspect(decoder.decode(Buffer.from(carry, "base64"), { stream: true }));
          inspect(decoder.decode());
        } else {
          if (carry) return;
          if (percentRun) percentBytes(true);
          if (invalid) return;
        }
        inlineAsset();
        if (error) throw error;
        scanner.finish(); metadata?.finish();
      },
    };
    phase = "payload";
  }
  function headerCharacter(character) {
    const folded = foldHeader(character);
    if (phase === "seek") {
      if (folded === "d" && !word(previous)) { header = "d"; phase = "prefix"; }
    } else if (phase === "prefix") {
      header += folded;
      if (inlinePrefixes.includes(header)) { mime = header.slice(5); phase = "suffix"; }
      else if (!inlinePrefixes.some((prefix) => prefix.startsWith(header))) { phase = "seek"; header = ""; headerCharacter(character); }
    } else if (phase === "suffix") {
      if (character === ",") startPayload(false);
      else if (character === ";") { phase = "parameter"; header = ""; }
      else { phase = "seek"; headerCharacter(character); }
    } else if (phase === "parameter") {
      header += folded;
      if (header === "charset=") { phase = "charset"; charsetLength = 0; }
      else if (header === "base64,") startPayload(true);
      else if (!"charset=".startsWith(header) && !"base64,".startsWith(header)) { phase = "seek"; header = ""; headerCharacter(character); }
    } else if (phase === "charset") {
      if (/[\w-]/iu.test(character)) charsetLength = 1;
      else if (charsetLength && character === ",") startPayload(false);
      else if (charsetLength && character === ";") { phase = "base64"; suffixOffset = 0; }
      else { phase = "seek"; headerCharacter(character); }
    } else if (phase === "base64") {
      if (folded !== "base64,"[suffixOffset++]) { phase = "seek"; headerCharacter(character); }
      else if (suffixOffset === 7) startPayload(true);
    }
    previous = character;
  }
  return {
    write(text) {
      raw.write(text);
      let offset = 0;
      while (offset < text.length) {
        if (phase === "payload") {
          const terminator = payload.base64 ? /[\s<>"'`#)]/gu : /[\s<>"'`]/gu;
          terminator.lastIndex = offset;
          const stop = terminator.exec(text)?.index ?? text.length;
          payload.write(text.slice(offset, stop));
          if (stop === text.length) return;
          payload.finish(); payload = null; phase = "seek";
          previous = stop > offset ? text[stop - 1] : previous;
          offset = stop;
        } else headerCharacter(text[offset++]);
      }
    },
    finish() { raw.finish(); if (phase === "payload") payload.finish(); },
  };
}

// Inspect JSON string values and credential field names without building a
// second object graph. Invalid JSON keeps the pre-existing raw-text checks but
// does not gain the semantics of a parsed metadata object.
export function createJsonMetadataScanner({ createTextScanner, credentialKey, reject, limit, depthChanged, rootScope = "metadata", scanKeys = false }) {
  const stack = [];
  let root = "value";
  let invalid = false;
  let deferredError;
  let mode = "normal";
  let key = "";
  let keyTooLong = false;
  let exactKey = "";
  let stringIsKey = false;
  let sensitive = false;
  let stringScanner;
  let stringBuffer = "";
  let escape = "";
  let unicode = "";
  let scalar = "";
  let literalOffset = 0;
  const frame = () => stack.at(-1);
  const state = () => frame()?.state ?? root;
  const setState = (value) => { if (frame()) frame().state = value; else root = value; };
  function report(callback) {
    if (deferredError) return;
    try { callback(); } catch (error) { deferredError = error; }
  }
  function addString(value) {
    if (stringIsKey) {
      if (!keyTooLong) {
        key += value.toLowerCase().replace(/[^a-z\d]/gu, "");
        // Every supported normalized credential field is shorter than this.
        if (key.length > 64) { key = ""; keyTooLong = true; }
      }
      // Only these short, exact decoded names grant analytical-row scope.
      // Normalized credential names must never turn `r-o-w-s` into `rows`.
      if (exactKey !== null) exactKey = exactKey.length + value.length <= 7 ? exactKey + value : null;
    } else if (sensitive && value.trim()) report(reject);
    if ((!stringIsKey || scanKeys) && !deferredError) {
      stringBuffer += value;
      if (stringBuffer.length >= TEXT_WINDOW) {
        report(() => stringScanner.write(stringBuffer));
        stringBuffer = "";
      }
    }
  }
  function childScope(type) {
    const parent = frame();
    if (!parent) return rootScope;
    if (parent.scope === "rows") return "rows";
    if (parent.type !== "object") return "metadata";
    if (parent.scope === "snapshot" && parent.key === "queries" && type === "object") return "queries";
    if (parent.scope === "queries") return "query";
    if (parent.scope === "query" && parent.key === "rows" && type === "array") return "rows";
    return "metadata";
  }
  function completeValue() { setState("commaOrEnd"); }
  function finishScalar() {
    if (mode === "literal" && literalOffset !== scalar.length) invalid = true;
    if (mode === "number" && !["zero", "integer", "fraction", "exponent"].includes(scalar)) invalid = true;
    mode = "normal";
    completeValue();
  }
  function normal(character) {
    if (/[\t\n\r ]/u.test(character)) return;
    const current = state();
    if ((current === "keyOrEnd" || current === "key") && character === '"') {
      mode = "string"; stringIsKey = true; key = ""; keyTooLong = false; exactKey = "";
      if (scanKeys) { stringScanner = createTextScanner(); stringBuffer = ""; }
    } else if (current === "colon" && character === ":") setState("value");
    else if ((current === "commaOrEnd" || current === "keyOrEnd" || current === "valueOrEnd") && (character === "}" || character === "]")) {
      if (!frame() || (character === "}") !== (frame().type === "object")) { invalid = true; return; }
      stack.pop(); completeValue();
    } else if (current === "commaOrEnd" && frame() && character === ",") {
      setState(frame().type === "object" ? "key" : "value");
    } else if (current === "value" || current === "valueOrEnd") {
      if (character === "{" || character === "[") {
        if (stack.length >= MAX_DEPTH) { limit(); return; }
        const type = character === "{" ? "object" : "array";
        stack.push({ type, state: type === "object" ? "keyOrEnd" : "valueOrEnd", sensitive: false, scope: childScope(type), key: null });
        depthChanged(stack.length);
      } else if (character === '"') {
        mode = "string"; stringIsKey = false; sensitive = Boolean(frame()?.sensitive);
        stringScanner = createTextScanner(); stringBuffer = "";
      } else if (character === "-" || /\d/u.test(character)) {
        mode = "number"; scalar = character === "-" ? "sign" : character === "0" ? "zero" : "integer";
      } else if ("tfn".includes(character)) {
        mode = "literal"; scalar = character === "t" ? "true" : character === "f" ? "false" : "null"; literalOffset = 1;
      } else invalid = true;
    } else invalid = true;
  }
  return {
    write(text) {
      if (invalid) return;
      for (const character of text) {
        if (invalid) break;
        if (mode === "string") {
          if (escape === "unicode") {
            if (!/[a-f\d]/iu.test(character)) { invalid = true; continue; }
            unicode += character;
            if (unicode.length === 4) { addString(String.fromCharCode(Number.parseInt(unicode, 16))); escape = ""; }
          } else if (escape) {
            if (character === "u") { escape = "unicode"; unicode = ""; }
            else {
              const escapes = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
              if (!Object.hasOwn(escapes, character)) invalid = true;
              else addString(escapes[character]);
              escape = "";
            }
          } else if (character === "\\") escape = "escape";
          else if (character === '"') {
            mode = "normal";
            if (stringIsKey) {
              frame().sensitive = !keyTooLong && credentialKey(key, frame().scope);
              frame().key = exactKey;
              if (scanKeys) report(() => { stringScanner.write(stringBuffer); stringScanner.finish(); });
              stringBuffer = ""; setState("colon");
            }
            else { report(() => { stringScanner.write(stringBuffer); stringScanner.finish(); }); stringBuffer = ""; completeValue(); }
          } else if (character.charCodeAt(0) < 32) invalid = true;
          else addString(character);
        } else if (mode === "literal") {
          if (literalOffset < scalar.length) {
            if (character !== scalar[literalOffset++]) invalid = true;
          } else { finishScalar(); normal(character); }
        } else if (mode === "number") {
          const digit = /\d/u.test(character);
          if (scalar === "sign" && digit) scalar = character === "0" ? "zero" : "integer";
          else if ((scalar === "integer" || scalar === "fraction" || scalar === "exponent") && digit) { /* Continue the scalar without retaining its text. */ }
          else if ((scalar === "integer" || scalar === "zero") && character === ".") scalar = "fractionStart";
          else if (scalar === "fractionStart" && digit) scalar = "fraction";
          else if (["zero", "integer", "fraction"].includes(scalar) && /e/iu.test(character)) scalar = "exponentStart";
          else if (scalar === "exponentStart" && /[+-]/u.test(character)) scalar = "exponentSign";
          else if ((scalar === "exponentStart" || scalar === "exponentSign") && digit) scalar = "exponent";
          else { finishScalar(); normal(character); }
        } else normal(character);
      }
    },
    finish() {
      if (!invalid && (mode === "number" || mode === "literal")) finishScalar();
      if (!invalid && mode === "normal" && !stack.length && root === "commaOrEnd" && deferredError) throw deferredError;
    },
  };
}
