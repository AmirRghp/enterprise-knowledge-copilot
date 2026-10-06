import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export const PUBLICATION_GIT_OPERATIONS = Object.freeze([
  "version", "rev-parse", "config", "init", "add", "commit", "check-ref-format", "hash-object", "read-tree",
  "update-index", "write-tree", "ls-remote", "fetch", "commit-tree", "update-ref", "push", "symbolic-ref",
  "check-ignore", "ls-files", "unknown",
]);
export const PUBLICATION_GIT_FAILURE_SUBTYPES = Object.freeze([
  "certificate_verification", "certificate_revocation", "tls_handshake", "tls_shutdown", "tls_credentials", "connection_reset", "authentication", "http_401",
  "http_403", "expired_credential", "proxy_denied", "dns", "timeout", "missing_git", "untrusted_repository",
  "push_rejected", "missing_identity", "unknown",
]);

const messages = {
  MISSING_GIT: "Git was not found. Supply the installed Git executable path.",
  INVALID_PROJECT_ROOT: "Select the authoring project's own Git repository root.",
  MISSING_AUTHORING_HEAD: "Commit the reviewed authoring source before preparing publication.",
  MISSING_GIT_IDENTITY: "Configure the intended Git user name and email before publishing.",
  EXISTING_GIT_REPOSITORY: "The selected project already has Git state. Review and commit that state before publishing.",
  UNTRUSTED_REPOSITORY: "Git does not trust this checkout. Resolve its ownership or trust configuration before retrying.",
  INVALID_CREDENTIAL: "Supply the complete source credential returned by Sites for this Site.",
  UNSAFE_GIT_CONFIGURATION: "Git rewrites the selected source destination. Resolve that URL rewrite before retrying.",
  EXPIRED_CREDENTIAL: "Renew the source credential for the same Site and retry with the receipt.",
  AUTHENTICATION_FAILED: "Sites rejected source authentication. Renew the credential for the same Site and retry with the receipt.",
  TLS_FAILED: "Git could not complete the encrypted connection. Check the diagnostic subtype before choosing a repair.",
  NETWORK_FAILED: "The source request did not complete. Check network access and retry with the receipt.",
  PUSH_REJECTED: "The source branch changed or rejected the push. Inspect its current state; do not force-push.",
  SOURCE_CHANGED: "The prepared publication source changed. Prepare a new candidate from the reviewed artifact.",
  INVALID_RECEIPT: "The publication receipt does not match this checkout and selected source branch.",
  GIT_TIMEOUT: "The Git operation timed out. Check the failed operation before retrying with the retained receipt.",
  GIT_FAILED: "Git could not complete publication. Raw command output was omitted.",
};
const certificateMessage = "Git could not verify the server certificate. Check the local certificate configuration before retrying.";
export const PUBLICATION_GIT_ERROR_CODES = Object.freeze(Object.keys(messages));
export const publicationGitErrorMessage = (code, subtype) => code === "TLS_FAILED" && subtype === "certificate_verification"
  ? certificateMessage : Object.hasOwn(messages, code) ? messages[code] : messages.GIT_FAILED;

export class PublicationGitError extends Error {
  constructor(code, stage, receipt, diagnostics) {
    super(publicationGitErrorMessage(code, diagnostics?.subtype));
    this.name = "PublicationGitError";
    this.code = PUBLICATION_GIT_ERROR_CODES.includes(code) ? code : "GIT_FAILED";
    this.stage = stage;
    if (receipt) this.receipt = receipt;
    if (diagnostics) {
      this.operation = PUBLICATION_GIT_OPERATIONS.includes(diagnostics.operation) ? diagnostics.operation : "unknown";
      this.subtype = PUBLICATION_GIT_FAILURE_SUBTYPES.includes(diagnostics.subtype) ? diagnostics.subtype : "unknown";
      this.operationMilliseconds = Number.isFinite(diagnostics.operationMilliseconds) ? Math.max(0, Math.round(diagnostics.operationMilliseconds)) : 0;
    }
  }
}
export const failPublicationGit = (code, stage, receipt) => { throw new PublicationGitError(code, stage, receipt); };

const processDiagnostics = new WeakMap();
const diagnosticOmitted = "[Git diagnostic omitted because it could not be safely redacted.]";
const diagnosticLimit = 2048;
const processSignals = new Set(["SIGABRT", "SIGALRM", "SIGBREAK", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT",
  "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGSYS", "SIGTERM", "SIGTRAP", "SIGUSR1", "SIGUSR2", "SIGXCPU", "SIGXFSZ"]);

/** Return a copy of diagnostics recorded by the subprocess client, never mutable Error fields. */
export function getPublicationGitProcessDiagnostics(error) {
  const value = error && typeof error === "object" ? processDiagnostics.get(error) : undefined;
  return value ? { ...value } : undefined;
}

const normalizeDiagnosticText = text => stripVTControlCharacters(text).replace(/\r\n?/gu, "\n")
  .replace(/[\p{Cc}\p{Cf}\p{M}]/gu, character => /[\n\t]/u.test(character) ? character : "");

function redactKnownCredentials(text, config) {
  const secrets = new Set();
  for (const [key, value] of config) {
    if (typeof key !== "string" || typeof value !== "string") throw new Error();
    if (!value || !/extraheader|password|token|secret/iu.test(key)) continue;
    if (value.length > 65536) throw new Error();
    secrets.add(value);
    const header = /^(?:Proxy-)?Authorization:\s*(.+)$/iu.exec(value)?.[1];
    if (header) {
      secrets.add(header);
      const token = /^(?:Bearer|Basic)\s+(.+)$/iu.exec(header)?.[1];
      if (token) secrets.add(token);
    }
  }
  // Cover literal and base64 encodings of supplied credentials. Other encoded
  // diagnostic formats are omitted below instead of running a general decoder.
  for (const secret of [...secrets]) {
    for (const encoding of ["base64", "base64url"]) {
      const encoded = Buffer.from(secret).toString(encoding);
      secrets.add(encoded); secrets.add(Buffer.from(encoded).toString(encoding));
    }
  }
  for (const secret of [...secrets]) secrets.add(normalizeDiagnosticText(secret));
  // A server can wrap a credential across lines and repeated Git/trace prefixes.
  // Map the compact form back to original spans before replacing entire values.
  const compact = value => value.replace(/^(?:remote:\s*|.*?(?:Send|Recv) header:\s*)/gmu, "").replace(/[\s"']/gu, "");
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    if (!secret) continue;
    text = text.replaceAll(secret, "[redacted]");
    const needle = compact(secret);
    if (!needle) continue;
    const skipped = new Set();
    for (const match of text.matchAll(/^(?:remote:\s*|.*?(?:Send|Recv) header:\s*)/gmu)) {
      for (let index = match.index; index < match.index + match[0].length; index++) skipped.add(index);
    }
    const positions = []; let haystack = "";
    for (let index = 0; index < text.length; index++) {
      if (!skipped.has(index) && !/[\s"']/u.test(text[index])) { positions.push(index); haystack += text[index]; }
    }
    const spans = [];
    for (let offset = haystack.indexOf(needle); offset !== -1; offset = haystack.indexOf(needle, offset + needle.length)) {
      spans.push([positions[offset], positions[offset + needle.length - 1] + 1]);
    }
    for (const [start, end] of spans.reverse()) text = text.slice(0, start) + "[redacted]" + text.slice(end);
    // Do not retain useful long prefixes/suffixes from a partial credential echo.
    if (secret.length >= 16) {
      for (const part of [secret.slice(0, 12), secret.slice(-12)]) {
        text = text.split("\n").map(line => line.includes(part) ? "[redacted partial credential]" : line).join("\n");
      }
    }
  }
  return text;
}

function stderrExcerpt(stderr, config = []) {
  if (stderr === undefined || stderr === null || stderr === "") return undefined;
  // Never truncate unredacted input: that could expose a credential prefix whose
  // complete value falls outside the inspection bound.
  if (typeof stderr !== "string" || stderr.length > 65536 || !Array.isArray(config) || config.length > 64) return diagnosticOmitted;
  try {
    let text = normalizeDiagnosticText(stderr);
    text = redactKnownCredentials(text, config);
    // Remove destinations wholesale, including userinfo, paths and query strings.
    text = text.replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"']+/giu, "[redacted-url]");
    // A normal Windows CA path contains \r or \t. Remove paths before deciding
    // whether remaining escape sequences require omission of the diagnostic.
    text = text.replace(/(["'])(?:[a-z]:[\\/]|\\\\)[^"'\r\n]*\1|\b[a-z]:[\\/][^\s<>"']*|\\\\[^\\\s]+\\[^\s<>"']*/giu, "[redacted-path]");
    if (/\\(?:[ux][\da-f{]|[0-7]{1,3}|[nrt])|%[\da-f]{2}|&#(?:x[\da-f]|\d)/iu.test(text) || text.includes("\uFFFD")) return diagnosticOmitted;
    const lines = [];
    for (const line of text.split("\n")) {
      // Keep recognizable Git error lines. Omit arbitrary payloads and folded
      // headers; classification and process status remain available separately.
      if (/\b(?:authorization|proxy[-_]authorization|cookie|set-cookie|password|passwd|access[_-]?token|api[_-]?key|secret)\s*[:=]|\b(?:Bearer|Basic)\s+\S/iu.test(line)) continue;
      if (!/^\s*(?:fatal:|error:|warning:|remote:|schannel:|curl:|OpenSSL|SSL\b|TLS\b|HTTP\b|CONNECT\b|Recv failure:)/iu.test(line)) continue;
      lines.push(line.replace(/\b(?:sk-|github_pat_|gh[pousr]_|glpat-|xox[baprs]-)[\w-]+|[A-Za-z\d_+/.~=-]{24,}/gu,
        value => /^[A-Z][A-Z_]+$/u.test(value) ? value : "[redacted]").trim());
    }
    const safe = lines.join("\n");
    if (!safe) return diagnosticOmitted;
    return safe.length <= diagnosticLimit ? safe : `[earlier diagnostic text omitted]\n${safe.slice(-(diagnosticLimit - 34)).replace(/^[\uDC00-\uDFFF]/u, "")}`;
  } catch { return diagnosticOmitted; }
}

function recordProcessDiagnostics(error, result, config) {
  const diagnostics = {
    stderrExcerpt: stderrExcerpt(result.stderr, config),
    exitStatus: Number.isInteger(result.status) && result.status >= 0 && result.status <= 0xffffffff ? result.status : null,
    signal: processSignals.has(result.signal) ? result.signal : null,
  };
  processDiagnostics.set(error, Object.freeze(diagnostics));
  Object.assign(error, diagnostics);
  return error;
}

function classify(result, fallback) {
  const failure = (code, subtype) => ({ code, subtype });
  if (result.error?.code === "ENOENT") return failure("MISSING_GIT", "missing_git");
  if (result.error?.code === "ETIMEDOUT") return failure("GIT_TIMEOUT", "timeout");
  const output = [result.stderr, result.stdout].filter(value => typeof value === "string").map(value => value.slice(-65536)).join("\n");
  if (/dubious ownership|unsafe repository|safe\.directory/iu.test(output)) return failure("UNTRUSTED_REPOSITORY", "untrusted_repository");
  // Schannel emits informational TLS and shutdown lines around unrelated
  // failures. Classify the actual rejection first; never infer trust failure
  // merely from a TLS backend name or the word "certificate".
  if (/CONNECT tunnel failed[^\n]*\b(?:403|407)\b|proxy authentication required/iu.test(output)) return failure("NETWORK_FAILED", "proxy_denied");
  if (/token[^\n]*expir|credential[^\n]*expir/iu.test(output)) return failure("EXPIRED_CREDENTIAL", "expired_credential");
  const httpStatus = /(?:HTTP(?:\/[\d.]+)?\s+(?:error\s+)?|requested URL returned error:\s*)(401|403)\b/iu.exec(output)?.[1];
  if (httpStatus) return failure("AUTHENTICATION_FAILED", `http_${httpStatus}`);
  if (/authentication failed|authorization failed|could not read Username|could not read Password/iu.test(output)) return failure("AUTHENTICATION_FAILED", "authentication");
  if (/non-fast-forward|\[rejected\]|fetch first|remote rejected/iu.test(output)) return failure("PUSH_REJECTED", "push_rejected");
  if (/unable to auto-detect email|Author identity unknown|empty ident/iu.test(output)) return failure("MISSING_GIT_IDENTITY", "missing_identity");
  if (/CRYPT_E_(?:REVOCATION_OFFLINE|NO_REVOCATION_CHECK)|CERT_E_REVOCATION_FAILURE|revocation (?:check|status)[^\n]*(?:failed|unavailable|unknown)/iu.test(output)) return failure("TLS_FAILED", "certificate_revocation");
  if (/SSL certificate problem|certificate (?:verify|verification) failed|server certificate verification failed|unable to (?:get local issuer|verify the first) certificate|self[- ]signed certificate|CERT_(?:E_(?:UNTRUSTEDROOT|EXPIRED|CN_NO_MATCH|CHAINING)|TRUST_IS_(?:UNTRUSTED_ROOT|NOT_TIME_VALID|PARTIAL_CHAIN))|SEC_E_(?:UNTRUSTED_ROOT|CERT_EXPIRED|WRONG_PRINCIPAL)|CertGetCertificateChain[^\n]*(?:failed|trust error)/iu.test(output)) {
    return failure("TLS_FAILED", "certificate_verification");
  }
  if (/connection (?:was )?reset|ECONNRESET|reset by peer/iu.test(output)) return failure("NETWORK_FAILED", "connection_reset");
  if (/missing close_notify|failed to (?:send|receive) close_notify|TLS[^\n]*(?:shutdown|close)[^\n]*failed|SSL_shutdown[^\n]*(?:failed|error)/iu.test(output)) return failure("TLS_FAILED", "tls_shutdown");
  if (/SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle[^\n]*failed/iu.test(output)) return failure("TLS_FAILED", "tls_credentials");
  if (/SSL connect error|(?:SSL\/TLS|TLS|SSL)[^\n]*handshake[^\n]*(?:failed|failure|error)|failed to receive handshake|InitializeSecurityContext[^\n]*failed|SEC_E_ILLEGAL_MESSAGE/iu.test(output)) return failure("TLS_FAILED", "tls_handshake");
  if (/could not resolve (?:host|proxy)|name or service not known/iu.test(output)) return failure("NETWORK_FAILED", "dns");
  return failure(fallback, "unknown");
}

// Use one environment contract for preflight, projection and network commands.
// Retain configured CA trust and config-file selection (including global ignore
// rules), while removing runtime config injection, directory overrides and tracing.
function childEnvironment(config = [], identity) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^GIT_(?:SSL_CA(?:INFO|PATH)|CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM))$/iu.test(key) || !/^GIT_|^GCM_|^CURL_VERBOSE$|^SSLKEYLOGFILE$/iu.test(key)));
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: String(config.length) });
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  }
  if (identity) Object.assign(env, {
    GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
  });
  return env;
}

export function publicationGitClient({ projectDir, gitExecutable = "git", runner = spawnSync, timeoutMs = 120000 }) {
  if (typeof gitExecutable !== "string" || !gitExecutable || /[\r\n\0]/u.test(gitExecutable)) failPublicationGit("MISSING_GIT", "preflight");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) failPublicationGit("GIT_FAILED", "preflight");
  return (args, { stage, fallback = "GIT_FAILED", operation = args[0] === "--version" ? "version" : args[0],
    input, config, identity, statuses = [0] } = {}) => {
    const started = performance.now();
    let result;
    try {
      result = runner(gitExecutable, args, {
        cwd: projectDir, shell: false, windowsHide: true, input, encoding: "utf8",
        env: childEnvironment(config, identity), maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs,
      });
    } catch (error) { result = { error }; }
    if (result.error || !statuses.includes(result.status)) {
      const { code, subtype } = classify(result, fallback);
      throw recordProcessDiagnostics(new PublicationGitError(code, stage, undefined,
        { operation, subtype, operationMilliseconds: performance.now() - started }), result, config);
    }
    return { status: result.status, stdout: result.stdout ?? "" };
  };
}
