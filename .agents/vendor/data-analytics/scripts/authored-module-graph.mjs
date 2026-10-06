import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseStrictCss } from "./css-syntax.mjs";
import { encodeDataAssetFragment } from "./data-url.mjs";
import { RUNTIME_MODULE_SPECIFIERS, validateRuntimeModuleExports } from "./prebuilt/manifest.mjs";

// These are the namespaces exported by the release-built browser runtime. This
// resolver is a build-dependency boundary, not a sandbox for authored browser JS.
export const AUTHORED_RUNTIME_MODULES = RUNTIME_MODULE_SPECIFIERS;

const RUNTIME_MODULES = new Set(AUTHORED_RUNTIME_MODULES);
const VIRTUAL_PREFIX = "\0data-app-authored:";
const RUNTIME_PREFIX = "\0data-app-runtime:";
const ENTRY_ID = `${VIRTUAL_PREFIX}entry`;
const SNAPSHOT_ID = "@openai/data-app-reviewed-snapshot";
// Match Vite's default extension order so an existing extensionless import does
// not silently select a different sibling when multiple suffixes are present.
const JS_EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx"];
const RESOLVE_EXTENSIONS = [...JS_EXTENSIONS, ".json"];
const CSS_EXTENSIONS = new Set([".css", ".pcss", ".postcss"]);
const SOURCE_ONLY_CODE = /\.(?:cjs|cts)$/iu;
const SOURCE_ONLY_STYLE = /(?:\.module\.(?:css|pcss|postcss)|\.(?:scss|sass|less|styl|stylus))$/iu;
const NODE_BINDINGS = new Set(["require", "module", "exports", "__dirname", "__filename"]);
const MIME_TYPES = Object.freeze({
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv",
  ".css": "text/css",
  ".eot": "application/vnd.ms-fontobject",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".pcss": "text/css",
  ".png": "image/png",
  ".postcss": "text/css",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

const slash = (value) => value.split(sep).join("/");
const inside = (root, filename) => {
  const name = relative(root, filename);
  return name === "" || (name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name));
};
const stringLiteral = (value) =>
  JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
const jsonExpression = (value) => `JSON.parse(${stringLiteral(JSON.stringify(value))})`;

function unsupported(message, filename) {
  return new Error(
    `Data's prebuilt build cannot ${message}${filename ? ` (${filename})` : ""}. ` +
      "Keep authored files beneath src/content and use the bundled public modules, " +
      "or use the explicit --source build with an already-installed compatible toolchain.",
  );
}

function decodeText(bytes, filename) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw unsupported("read a non-UTF-8 text file", filename);
  }
}

function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let end = source.length;
  let result = source;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > end) {
      throw new Error("Overlapping authored-source edits.");
    }
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    end = edit.start;
  }
  return result;
}

function childrenOf(node) {
  return node?.children ? [...node.children] : [];
}

function moduleName(node) {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function patternNames(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "RestElement") return patternNames(node.argument);
  if (node.type === "AssignmentPattern") return patternNames(node.left);
  if (node.type === "ArrayPattern") return node.elements.flatMap(patternNames);
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) =>
      patternNames(property.type === "RestElement" ? property.argument : property.value),
    );
  }
  return [];
}

function exportedNames(node) {
  if (node.type === "ExportAllDeclaration") return node.exported ? [moduleName(node.exported)] : [];
  const names = (node.specifiers ?? []).map((specifier) => moduleName(specifier.exported));
  if (node.declaration?.type === "VariableDeclaration") {
    names.push(...node.declaration.declarations.flatMap((declaration) => patternNames(declaration.id)));
  } else if (node.declaration?.id) names.push(...patternNames(node.declaration.id));
  return names;
}

function importValue(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function nodeChildren(node, visit) {
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === "string") visit(child, key);
    } else if (value && typeof value.type === "string") visit(value, key);
  }
}

function identifierIsReference(parent, key) {
  if (!parent) return false;
  if (
    ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
      key === "property" &&
      !parent.computed) ||
    ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") &&
      key === "key" &&
      !parent.computed) ||
    ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") &&
      key === "label") ||
    parent.type === "MetaProperty" ||
    parent.type.startsWith("Import") ||
    parent.type === "ExportSpecifier"
  )
    return false;
  return true;
}

// Scope analysis is used only to distinguish real CommonJS/Node references from
// ordinary authored parameters/properties named "require" or "exports". Module
// semantics, live bindings, cycles, and renaming belong to the bundled Rollup.
function inspectJavaScript(ast, filename, { generated = false } = {}) {
  const imports = [];
  const references = [];
  const bindings = new WeakSet();
  const identifiers = new Set();
  const makeScope = (parent, variable = false) => ({ parent, variable, names: new Set() });
  const root = makeScope(null, true);
  const variableScope = (scope) => (scope.variable ? scope : variableScope(scope.parent));
  const bound = (scope, name) => scope && (scope.names.has(name) || bound(scope.parent, name));

  function bindPattern(node, scope) {
    if (!node) return;
    if (node.type === "Identifier") {
      scope.names.add(node.name);
      bindings.add(node);
    } else if (node.type === "RestElement") bindPattern(node.argument, scope);
    else if (node.type === "AssignmentPattern") bindPattern(node.left, scope);
    else if (node.type === "ArrayPattern") node.elements.forEach((item) => bindPattern(item, scope));
    else if (node.type === "ObjectPattern") {
      for (const property of node.properties) {
        bindPattern(property.type === "RestElement" ? property.argument : property.value, scope);
      }
    }
  }

  function addImport(node, source, dynamic = false) {
    const value = importValue(source);
    if (typeof value !== "string") throw unsupported("bundle a computed dynamic import", filename);
    if (node.phase && node.phase !== "evaluation") throw unsupported("bundle a nonstandard import phase", filename);
    const names = [];
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportDefaultSpecifier") names.push("default");
        if (specifier.type === "ImportSpecifier") names.push(moduleName(specifier.imported));
      }
    } else if (node.type === "ExportNamedDeclaration") {
      for (const specifier of node.specifiers) names.push(moduleName(specifier.local));
    }
    imports.push({ specifier: value, start: source.start, end: source.end, dynamic, names });
  }

  function visit(node, scope, parent, key, functionDepth = 0) {
    if (!node) return;
    if (node.type === "Identifier") {
      identifiers.add(node.name);
      if (identifierIsReference(parent, key)) references.push({ node, scope, parent, key });
      return;
    }
    if (node.type === "ImportDeclaration") {
      addImport(node, node.source);
      for (const specifier of node.specifiers) bindPattern(specifier.local, scope);
      return;
    }
    if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      if (!generated && exportedNames(node).includes("__proto__")) {
        throw unsupported(
          'export the ESM name "__proto__"; use another export name or access that key through a default object',
          filename,
        );
      }
      if (node.source) addImport(node, node.source);
      if (node.declaration) visit(node.declaration, scope, node, "declaration", functionDepth);
      return;
    }
    if (node.type === "ImportExpression") {
      if (!generated) {
        throw unsupported("preserve lazy dynamic-import evaluation; use a static import", filename);
      }
      addImport(node, node.source, true);
      if (node.options) throw unsupported("bundle dynamic-import options", filename);
      return;
    }
    if (node.type === "MetaProperty" && node.meta.name === "import") {
      throw unsupported("use import.meta in the prebuilt authoring surface", filename);
    }
    if ((node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) && functionDepth === 0) {
      throw unsupported("bundle top-level await", filename);
    }
    if (node.type === "VariableDeclaration") {
      const target = node.kind === "var" ? variableScope(scope) : scope;
      for (const declaration of node.declarations) bindPattern(declaration.id, target);
    }
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      if (node.type === "FunctionDeclaration") bindPattern(node.id, scope);
      const parameters = makeScope(scope, true);
      if (node.id) bindPattern(node.id, parameters);
      for (const parameter of node.params) bindPattern(parameter, parameters);
      if (node.id) identifiers.add(node.id.name);
      for (const parameter of node.params) visit(parameter, parameters, node, "params", functionDepth + 1);
      // Body var/function declarations are not visible to default-parameter
      // initializers. Keeping these scopes separate also handles arrow functions.
      visit(node.body, makeScope(parameters, true), node, "body", functionDepth + 1);
      return;
    }
    if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      if (node.type === "ClassDeclaration") bindPattern(node.id, scope);
      const inner = makeScope(scope);
      if (node.id) {
        bindPattern(node.id, inner);
        identifiers.add(node.id.name);
      }
      visit(node.superClass, inner, node, "superClass", functionDepth);
      visit(node.body, inner, node, "body", functionDepth);
      return;
    }
    if (node.type === "CatchClause") {
      const inner = makeScope(scope);
      bindPattern(node.param, inner);
      visit(node.param, inner, node, "param", functionDepth);
      visit(node.body, inner, node, "body", functionDepth);
      return;
    }
    if (node.type === "SwitchStatement") {
      visit(node.discriminant, scope, node, "discriminant", functionDepth);
      const inner = makeScope(scope);
      for (const branch of node.cases) visit(branch, inner, node, "cases", functionDepth);
      return;
    }
    if (
      node.type === "BlockStatement" ||
      node.type === "StaticBlock" ||
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    )
      scope = makeScope(scope, node.type === "StaticBlock");
    nodeChildren(node, (child, childKey) => visit(child, scope, node, childKey, functionDepth));
  }

  visit(ast, root);
  const freeNodeReferences = references.filter(
    ({ node, scope }) => NODE_BINDINGS.has(node.name) && !bindings.has(node) && !bound(scope, node.name),
  );
  if (!generated && freeNodeReferences.length) {
    throw unsupported(`use the Node/CommonJS binding ${JSON.stringify(freeNodeReferences[0].node.name)}`, filename);
  }
  return { imports, identifiers, freeNodeReferences };
}

function parseSpecifier(specifier, filename) {
  if (typeof specifier !== "string" || !specifier || /[\\\u0000-\u001f\u007f]/u.test(specifier)) {
    throw unsupported(`resolve the invalid import ${JSON.stringify(specifier)}`, filename);
  }
  const fragmentAt = specifier.indexOf("#");
  const fragment = fragmentAt < 0 ? "" : specifier.slice(fragmentAt + 1);
  const withoutFragment = fragmentAt < 0 ? specifier : specifier.slice(0, fragmentAt);
  const queryAt = withoutFragment.indexOf("?");
  const query = queryAt < 0 ? "" : withoutFragment.slice(queryAt + 1);
  let pathname = queryAt < 0 ? withoutFragment : withoutFragment.slice(0, queryAt);
  if (!["", "raw", "url", "inline", "worker&inline"].includes(query)) {
    throw unsupported(`resolve the import query ${JSON.stringify(query)}`, filename);
  }
  if (/%(?:2f|5c|00)/iu.test(pathname)) throw unsupported("resolve an encoded path separator", filename);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    throw unsupported("resolve an invalid percent-encoded path", filename);
  }
  if (/[:?#\\\u0000-\u001f\u007f]/u.test(pathname)) throw unsupported("resolve an invalid local path", filename);
  return { pathname, query, fragment };
}

function cssName(compiler, value) {
  return compiler.decodeCssIdentifier(value).toLowerCase();
}

function cssRange(node) {
  return { start: node.loc.start.offset, end: node.loc.end.offset };
}

function enclosingRange(node, ranges) {
  return ranges.some((range) => node.loc.start.offset >= range.start && node.loc.end.offset <= range.end);
}

function classifyCssUrl(value, filename) {
  const url = value.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/gu, "");
  if (!url || /[\\\u0000-\u001f\u007f]/u.test(url)) throw unsupported("embed an invalid CSS URL", filename);
  if (url.startsWith("#")) return { embedded: true, value: url };
  if (/^data:/iu.test(url)) return { embedded: true, value: url };
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/iu.test(url)) {
    throw unsupported(`load the external CSS resource ${JSON.stringify(url)}`, filename);
  }
  return { embedded: false, value: url };
}

function cssResources(ast, compiler, filename) {
  const imports = [];
  const resources = [];
  const discarded = [];
  const topLevelImports = new Set();
  let importsAllowed = true;
  for (const child of childrenOf(ast)) {
    const name = child.type === "Atrule" ? cssName(compiler, child.name) : "";
    if (name === "import") {
      if (!importsAllowed) throw unsupported("honor a CSS @import placed after a style rule", filename);
      topLevelImports.add(child);
    } else if (name !== "charset" && !(name === "layer" && !child.block)) importsAllowed = false;
  }
  compiler.walkCss(ast, (node) => {
    if (node.type !== "Atrule") return;
    const name = cssName(compiler, node.name);
    if (name === "import") {
      if (!topLevelImports.has(node)) throw unsupported("flatten a nested CSS @import", filename);
      imports.push(node);
    }
    if (name === "charset") discarded.push(cssRange(node));
    if (name === "namespace") throw unsupported("bundle CSS @namespace rules", filename);
  });
  const skip = [...imports.map(cssRange), ...discarded];
  const functionUrls = [];
  compiler.walkCss(ast, (node) => {
    if (enclosingRange(node, skip)) return;
    if (node.type === "Url") resources.push({ node, value: node.value, kind: "url" });
    if (node.type !== "Function") return;
    const name = cssName(compiler, node.name);
    if (name === "url") {
      const children = childrenOf(node);
      if (children.length !== 1 || children[0].type !== "String") {
        throw unsupported("statically resolve this CSS url() function", filename);
      }
      functionUrls.push(cssRange(node));
      resources.push({ node, value: children[0].value, kind: "url" });
    } else if (["image", "image-set", "-webkit-image-set", "src"].includes(name)) {
      for (const child of childrenOf(node)) {
        if (child.type === "String") resources.push({ node: child, value: child.value, kind: "string" });
      }
    }
  });
  return {
    imports,
    discarded,
    resources: resources.filter(
      ({ node }) =>
        !functionUrls.some((range) => node.loc.start.offset > range.start && node.loc.end.offset < range.end),
    ),
  };
}

function importCssParts(node, compiler, filename) {
  const children = childrenOf(node.prelude);
  const source = children.shift();
  let value;
  if (source?.type === "String" || source?.type === "Url") value = source.value;
  else if (source?.type === "Function" && cssName(compiler, source.name) === "url") {
    const args = childrenOf(source);
    if (args.length === 1 && args[0].type === "String") value = args[0].value;
  }
  if (typeof value !== "string" || node.block) throw unsupported("resolve this CSS @import", filename);
  let layer = null;
  let supports = null;
  let media = null;
  for (const child of children) {
    if (layer === null && child.type === "Identifier" && cssName(compiler, child.name) === "layer") layer = "";
    else if (layer === null && child.type === "Function" && cssName(compiler, child.name) === "layer") {
      layer = childrenOf(child)
        .map((part) => compiler.generateCss(part))
        .join("");
    } else if (supports === null && child.type === "Function" && cssName(compiler, child.name) === "supports") {
      supports = childrenOf(child)
        .map((part) => compiler.generateCss(part))
        .join("");
    } else if (media === null && child.type === "MediaQueryList") media = compiler.generateCss(child);
    else throw unsupported("preserve these CSS @import conditions", filename);
  }
  return {
    value,
    wrap(css) {
      if (media) css = `@media ${media}{${css}}`;
      if (supports) css = `@supports (${supports}){${css}}`;
      if (layer !== null) css = `@layer${layer ? ` ${layer}` : ""}{${css}}`;
      return css;
    },
  };
}

class AuthoredGraph {
  constructor(projectRoot, compiler, runtimeModuleExports, worker = false) {
    this.root = projectRoot;
    this.compiler = compiler;
    this.runtimeModuleExports = runtimeModuleExports;
    this.worker = worker;
    this.workerModuleCount = 0;
    this.content = join(projectRoot, "src/content");
    this.publicFile = join(projectRoot, "src/data-app-public.jsx");
    this.snapshotFile = join(projectRoot, "src/data.json");
    this.themeFile = join(projectRoot, "src/theme.css");
    this.modules = new Map();
    this.sourceFiles = new Set();
    this.cssFiles = new Set();
    this.assets = new Set();
    this.cssCache = new Map();
    this.cssLoading = [];
    this.styleFiles = new Set();
    this.externalImports = new Map();
  }

  name(filename) {
    return slash(relative(this.root, filename));
  }

  allowed(filename) {
    return inside(this.content, filename) || [this.publicFile, this.snapshotFile, this.themeFile].includes(filename);
  }

  async exactFile(filename) {
    if (!this.allowed(filename)) throw unsupported("read outside the authored source boundary", this.name(filename));
    let current = this.root;
    const parts = relative(this.root, filename).split(sep);
    for (let index = 0; index < parts.length; index++) {
      let entries;
      try {
        entries = await readdir(current);
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
        throw error;
      }
      if (!entries.includes(parts[index])) {
        const differentlyCased = entries.find((name) => name.toLowerCase() === parts[index].toLowerCase());
        if (differentlyCased) {
          throw unsupported(
            `resolve a case-mismatched path; use ${JSON.stringify(differentlyCased)}`,
            this.name(filename),
          );
        }
        return false;
      }
      current = join(current, parts[index]);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw unsupported("follow an authored-source symlink", this.name(current));
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) return false;
    }
    if ((await realpath(filename)) !== filename)
      throw unsupported("follow a redirected authored-source path", this.name(filename));
    return true;
  }

  async read(filename) {
    if (!(await this.exactFile(filename))) throw unsupported("find the referenced file", this.name(filename));
    this.sourceFiles.add(this.name(filename));
    return readFile(filename);
  }

  async localFile(pathname, importer, { exact = false } = {}) {
    if (!pathname.startsWith("./") && !pathname.startsWith("../")) {
      throw unsupported(`resolve the non-relative local import ${JSON.stringify(pathname)}`, this.name(importer));
    }
    const candidate = resolve(dirname(importer), pathname);
    const candidates = [candidate];
    if (!exact && !extname(candidate)) {
      candidates.push(...RESOLVE_EXTENSIONS.map((extension) => candidate + extension));
      candidates.push(...RESOLVE_EXTENSIONS.map((extension) => join(candidate, `index${extension}`)));
    }
    const permitted = candidates.filter((filename) => this.allowed(filename));
    if (!permitted.length) {
      throw unsupported(`resolve ${JSON.stringify(pathname)} outside src/content`, this.name(importer));
    }
    for (const filename of permitted) if (await this.exactFile(filename)) return filename;
    throw unsupported(`find the local import ${JSON.stringify(pathname)}`, this.name(importer));
  }

  external(id, names = []) {
    if (!this.externalImports.has(id)) this.externalImports.set(id, new Set());
    for (const name of names) this.externalImports.get(id).add(name);
    return id;
  }

  runtimeModule(specifier, names, importer) {
    const available = this.runtimeModuleExports[specifier];
    for (const name of names) {
      if (!available.includes(name)) {
        throw unsupported(
          `import missing export ${JSON.stringify(name)} from bundled module ${JSON.stringify(specifier)}`,
          this.name(importer),
        );
      }
    }
    // Rollup 3's namespace object emitter cannot safely represent this exotic
    // named export. Default objects retain their own __proto__ data unchanged.
    if (available.includes("__proto__")) {
      throw unsupported(`represent the bundled namespace ${JSON.stringify(specifier)} with a named __proto__ export`);
    }
    const id = `${RUNTIME_PREFIX}${specifier}`;
    if (!this.modules.has(id)) {
      // External ESM exports are otherwise unknown to Rollup. Enumerating the
      // verified release surface lets its normal linker catch misspellings and
      // ambiguous names through arbitrary local reexport/star-export chains.
      const exports = available.map((name) => `${stringLiteral(name)} as ${stringLiteral(name)}`).join(", ");
      this.modules.set(id, { id, source: `export { ${exports} } from ${stringLiteral(specifier)};` });
    }
    // Check the same complete namespace again in the browser as a defense
    // against accidentally pairing generated content with a different runtime.
    this.external(specifier, available);
    return id;
  }

  async dataUrl(filename, fragment = "") {
    const bytes = await this.read(filename);
    this.assets.add(this.name(filename));
    const mime = MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
    let suffix = "";
    if (fragment) {
      try {
        suffix = `#${encodeDataAssetFragment(decodeURIComponent(fragment))}`;
      } catch {
        throw unsupported("encode an invalid asset fragment", this.name(filename));
      }
    }
    return `data:${mime};base64,${bytes.toString("base64")}${suffix}`;
  }

  async cssUrl(value, importer, { final = false } = {}) {
    const classified = classifyCssUrl(value, this.name(importer));
    if (classified.embedded) return classified.value;
    if (final) throw unsupported("emit a CSS URL that was not embedded during normalization", this.name(importer));
    const parsed = parseSpecifier(classified.value, this.name(importer));
    if (parsed.query && parsed.query !== "url") throw unsupported("preserve a CSS resource query", this.name(importer));
    const pathname = /^(?:\.\/|\.\.\/)/u.test(parsed.pathname) ? parsed.pathname : `./${parsed.pathname}`;
    const filename = await this.localFile(pathname, importer, { exact: true });
    if (!inside(this.content, filename))
      throw unsupported("embed a protected file as a CSS asset", this.name(filename));
    return this.dataUrl(filename, parsed.fragment);
  }

  parseCss(source, filename) {
    return parseStrictCss(source, this.compiler, {
      filename: this.name(filename),
      onInvalid: (error) => {
        throw unsupported(`parse CSS: ${error.message}`, this.name(filename));
      },
    });
  }

  async css(filename) {
    if (SOURCE_ONLY_STYLE.test(filename)) throw unsupported("compile Sass, Less, or CSS modules", this.name(filename));
    if (!CSS_EXTENSIONS.has(extname(filename).toLowerCase()))
      throw unsupported("import a non-CSS stylesheet", this.name(filename));
    if (this.cssCache.has(filename)) return this.cssCache.get(filename);
    if (this.cssLoading.includes(filename)) {
      throw unsupported(
        `flatten a circular CSS @import: ${[...this.cssLoading, filename].map((item) => this.name(item)).join(" -> ")}`,
      );
    }
    this.cssLoading.push(filename);
    try {
      const source = decodeText(await this.read(filename), this.name(filename));
      this.cssFiles.add(this.name(filename));
      const ast = this.parseCss(source, filename);
      const { imports, resources, discarded } = cssResources(ast, this.compiler, this.name(filename));
      const edits = discarded.map((range) => ({ ...range, text: "" }));
      for (const node of imports) {
        const parts = importCssParts(node, this.compiler, this.name(filename));
        const classified = classifyCssUrl(parts.value, this.name(filename));
        if (classified.embedded) throw unsupported("flatten a data-URL or fragment CSS @import", this.name(filename));
        const parsed = parseSpecifier(classified.value, this.name(filename));
        if (parsed.query || parsed.fragment)
          throw unsupported("preserve a CSS @import query or fragment", this.name(filename));
        const pathname = /^(?:\.\/|\.\.\/)/u.test(parsed.pathname) ? parsed.pathname : `./${parsed.pathname}`;
        const imported = await this.localFile(pathname, filename, { exact: true });
        edits.push({ ...cssRange(node), text: parts.wrap(await this.css(imported)) });
      }
      for (const resource of resources) {
        const value = await this.cssUrl(resource.value, filename);
        const type = resource.kind === "url" ? "Url" : "String";
        edits.push({ ...cssRange(resource.node), text: this.compiler.generateCss({ type, value }) });
      }
      // css-tree may canonicalize escaped identifiers across removed comments.
      // Reparse and check the exact generated bytes, not only the input AST.
      const rewritten = this.parseCss(applyEdits(source, edits), filename);
      const generated = this.compiler.generateCss(rewritten);
      const finalAst = this.parseCss(generated, filename);
      const finalResources = cssResources(finalAst, this.compiler, this.name(filename));
      if (finalResources.imports.length) throw unsupported("emit an unresolved CSS @import", this.name(filename));
      for (const resource of finalResources.resources) await this.cssUrl(resource.value, filename, { final: true });
      this.cssCache.set(filename, generated);
      return generated;
    } finally {
      this.cssLoading.pop();
    }
  }

  async resolveImport(specifier, importer, names = []) {
    if (RUNTIME_MODULES.has(specifier)) {
      if (this.worker) throw unsupported("import the UI runtime inside a calculation Worker", this.name(importer));
      return this.runtimeModule(specifier, names, importer);
    }
    const parsed = parseSpecifier(specifier, this.name(importer));
    if (!parsed.pathname.startsWith("./") && !parsed.pathname.startsWith("../")) {
      throw unsupported(`resolve the package or URL import ${JSON.stringify(specifier)}`, this.name(importer));
    }
    const filename = await this.localFile(parsed.pathname, importer);
    if (filename === this.publicFile || filename === this.snapshotFile) {
      if (this.worker) throw unsupported("import protected UI or snapshot modules inside a Worker; pass reviewed data with postMessage", this.name(importer));
      if (parsed.query || parsed.fragment)
        throw unsupported("apply a query to a protected public/data module", this.name(importer));
      if (filename === this.snapshotFile && names.includes("__proto__")) {
        throw unsupported(
          'import JSON key "__proto__" as a named export; read it from the default JSON object',
          this.name(importer),
        );
      }
      this.sourceFiles.add(this.name(filename));
      return filename === this.publicFile
        ? this.runtimeModule("@openai/data-app", names, importer)
        : this.external(SNAPSHOT_ID, names);
    }
    if (SOURCE_ONLY_CODE.test(filename) && !["raw", "url"].includes(parsed.query))
      throw unsupported(
        "compile CommonJS .cjs or .cts modules; use an ESM .js, .mjs, .ts, or .mts file",
        this.name(filename),
      );
    if (SOURCE_ONLY_STYLE.test(filename)) throw unsupported("compile Sass, Less, or CSS modules", this.name(filename));
    if (!parsed.query && extname(filename).toLowerCase() === ".json" && names.includes("__proto__")) {
      throw unsupported(
        'import JSON key "__proto__" as a named export; read it from the default JSON object',
        this.name(importer),
      );
    }
    if (parsed.fragment && parsed.query !== "url" && JS_EXTENSIONS.includes(extname(filename).toLowerCase())) {
      throw unsupported("use a fragment on a JavaScript module", this.name(filename));
    }
    const id = `${VIRTUAL_PREFIX}${this.name(filename)}${parsed.query ? `?${parsed.query}` : ""}${
      parsed.fragment ? `#${parsed.fragment}` : ""
    }`;
    if (!this.modules.has(id)) {
      // Install the record before descending so normal ESM cycles reach Rollup.
      const record = { id, filename, source: null, loading: true };
      this.modules.set(id, record);
      record.source = await this.loadModule(filename, parsed);
      record.loading = false;
    }
    return id;
  }

  async loadModule(filename, { query, fragment }) {
    const extension = extname(filename).toLowerCase();
    if (query === "worker&inline") {
      if (this.worker || fragment || !JS_EXTENSIONS.includes(extension))
        throw unsupported("bundle a nested, fragmented, or non-JavaScript calculation Worker", this.name(filename));
      const graph = new AuthoredGraph(this.root, this.compiler, this.runtimeModuleExports, true);
      const entry = await graph.resolveImport(`./${basename(filename)}`, filename);
      graph.modules.set(ENTRY_ID, { id: ENTRY_ID, source: `import ${stringLiteral(entry)};` });
      const { code } = await emitBundle(graph);
      for (const source of graph.sourceFiles) this.sourceFiles.add(source);
      this.workerModuleCount += [...graph.modules.values()].filter(record => record.filename).length;
      // The constructor matches the source-build import. Keep the URL alive until
      // startup has completed, or release it on construction failure/termination.
      return `export default function InlineCalculationWorker(options) {
        const url = URL.createObjectURL(new Blob([${stringLiteral(code)}], {type:"text/javascript"}));
        let worker, released = false;
        const release = () => { if (!released) { released = true; URL.revokeObjectURL(url); } };
        try { worker = new Worker(url, options); } catch (error) { release(); throw error; }
        worker.addEventListener("message", release, {once:true});
        worker.addEventListener("error", release, {once:true});
        const terminate = worker.terminate.bind(worker);
        worker.terminate = () => { release(); terminate(); };
        return worker;
      }`;
    }
    if (this.worker && (query || (!JS_EXTENSIONS.includes(extension) && extension !== ".json")))
      throw unsupported("import anything other than local JavaScript/TypeScript and JSON in a calculation Worker", this.name(filename));
    if (query === "raw") {
      if (fragment) throw unsupported("use a fragment on a raw-text import", this.name(filename));
      const value = decodeText(await this.read(filename), this.name(filename));
      if (!JS_EXTENSIONS.includes(extension) && extension !== ".json" && !CSS_EXTENSIONS.has(extension))
        this.assets.add(this.name(filename));
      return `export default ${jsonExpression(value)};`;
    }
    if (query === "url") {
      if (!inside(this.content, filename)) throw unsupported("embed a protected file as an asset", this.name(filename));
      if (CSS_EXTENSIONS.has(extension)) {
        if (fragment) throw unsupported("use a fragment on a stylesheet URL", this.name(filename));
        const css = await this.css(filename);
        this.assets.add(this.name(filename));
        return `export default ${jsonExpression(`data:text/css;base64,${Buffer.from(css).toString("base64")}`)};`;
      }
      return `export default ${jsonExpression(await this.dataUrl(filename, fragment))};`;
    }
    if (CSS_EXTENSIONS.has(extension)) {
      const css = await this.css(filename);
      if (fragment) throw unsupported("use a fragment on a stylesheet", this.name(filename));
      if (query === "inline") return `export default ${jsonExpression(css)};`;
      if (filename !== this.themeFile) this.styleFiles.add(filename);
      return "export {};";
    }
    if (query === "inline") throw unsupported("use ?inline on a non-CSS import", this.name(filename));
    if (extension === ".json") {
      if (fragment) throw unsupported("use a fragment on a JSON module", this.name(filename));
      let value;
      try {
        value = JSON.parse(decodeText(await this.read(filename), this.name(filename)));
      } catch (error) {
        throw unsupported(`parse JSON: ${error.message}`, this.name(filename));
      }
      const lines = [`const value = ${jsonExpression(value)};`, "export default value;"];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        let index = 0;
        for (const key of Object.keys(value)) {
          if (key === "default" || key === "__esModule" || key === "__proto__" || !/^[a-z_$][\w$]*$/iu.test(key))
            continue;
          const binding = `jsonValue${index++}`;
          lines.push(`const ${binding} = value[${stringLiteral(key)}]; export { ${binding} as ${key} };`);
        }
      }
      return lines.join("\n");
    }
    if (!JS_EXTENSIONS.includes(extension)) {
      if (!inside(this.content, filename)) throw unsupported("embed a protected file as an asset", this.name(filename));
      return `export default ${jsonExpression(await this.dataUrl(filename, fragment))};`;
    }
    const original = decodeText(await this.read(filename), this.name(filename));
    let source;
    let ast;
    try {
      source = this.compiler.transform(original, {
        filePath: this.name(filename),
        commonjs: false,
        typescript: [".ts", ".tsx", ".mts"].includes(extension),
      });
      ast = this.compiler.parseJavaScript(source, { sourceType: "module", locations: true });
    } catch (error) {
      throw unsupported(`parse authored JavaScript: ${error.message}`, this.name(filename));
    }
    const inspected = inspectJavaScript(ast, this.name(filename));
    const edits = [];
    for (const imported of inspected.imports) {
      const target = await this.resolveImport(imported.specifier, filename, imported.names);
      edits.push({ start: imported.start, end: imported.end, text: stringLiteral(target) });
    }
    return applyEdits(source, edits);
  }

  async collect() {
    const themeCss = await this.css(this.themeFile);
    const conventionalFiles = ["dashboard/dashboard.css", "report/report.css"].map((name) => join(this.content, name));
    for (const filename of conventionalFiles) {
      await this.css(filename);
      this.styleFiles.add(filename);
    }
    const dashboard = await this.resolveImport(
      "./src/content/dashboard/DashboardContent.jsx",
      join(this.root, "entry.js"),
    );
    const report = await this.resolveImport("./src/content/report/ReportContent.jsx", join(this.root, "entry.js"));
    this.modules.set(ENTRY_ID, {
      id: ENTRY_ID,
      source: `export { DashboardContent } from ${stringLiteral(
        dashboard,
      )};\nexport { ReportContent } from ${stringLiteral(report)};`,
    });
    return {
      themeCss,
      // The starter loads these before print.css; component-imported styles
      // follow print.css. Keep the combined field for existing graph consumers.
      conventionalCss: conventionalFiles.map((filename) => this.cssCache.get(filename)).join("\n"),
      importedCss: [...this.styleFiles]
        .filter((filename) => !conventionalFiles.includes(filename))
        .map((filename) => this.cssCache.get(filename))
        .join("\n"),
      styles: [...this.styleFiles].map((filename) => this.cssCache.get(filename)).join("\n"),
    };
  }
}

function validateBundledCode(code, compiler, allowed) {
  const ast = compiler.parseJavaScript(code, { sourceType: "script", locations: true });
  const inspected = inspectJavaScript(ast, "generated authored bundle", { generated: true });
  if (inspected.imports.length) throw new Error("Authored bundle retained an external ESM import.");
  for (const reference of inspected.freeNodeReferences) {
    if (reference.node.name !== "require") continue;
    const call = reference.parent;
    if (
      call?.type !== "CallExpression" ||
      reference.key !== "callee" ||
      call.arguments.length !== 1 ||
      !allowed.has(importValue(call.arguments[0]))
    )
      throw new Error("Authored bundle retained an unknown CommonJS dependency.");
  }
  return inspected.identifiers;
}

async function emitBundle(graph) {
  if (typeof graph.compiler.rollup !== "function") {
    throw new Error(
      "The bundled Data compiler is missing its reviewed module bundler; reinstall a complete Data plugin.",
    );
  }
  const externals = new Set(graph.worker ? [] : [...RUNTIME_MODULES, SNAPSHOT_ID]);
  const warnings = [];
  const plugin = {
    name: "closed-data-authored-graph",
    resolveId(id) {
      if (graph.modules.has(id)) return id;
      if (externals.has(id)) return { id, external: true };
      throw unsupported(`resolve an undeclared bundled module ${JSON.stringify(id)}`);
    },
    load(id) {
      const record = graph.modules.get(id);
      if (!record || typeof record.source !== "string") throw new Error(`Missing in-memory authored module: ${id}`);
      return record.source;
    },
  };
  let bundle;
  let code;
  try {
    bundle = await graph.compiler.rollup({
      input: ENTRY_ID,
      plugins: [plugin],
      external: (id) => externals.has(id),
      preserveEntrySignatures: "strict",
      // The large product runtime was already tree-shaken at release time.
      // Keep the small authored graph intact so Rollup also links otherwise
      // unused reexports instead of silently discarding a missing export.
      treeshake: false,
      onwarn(warning) {
        // Rollup may downgrade an unused missing import to a warning. ESM
        // still rejects that import at link time, so publishing must fail too.
        if (warning.code === "MISSING_EXPORT") throw new Error(warning.message);
        warnings.push({ code: warning.code, message: warning.message });
      },
    });
    const result = await bundle.generate({
      format: graph.worker ? "iife" : "cjs",
      exports: "named",
      inlineDynamicImports: true,
      dynamicImportInCjs: false,
      interop: "esModule",
      externalLiveBindings: true,
      sourcemap: false,
      strict: true,
    });
    if (result.output.length !== 1 || result.output[0].type !== "chunk") {
      throw new Error("The authored bundle must contain exactly one JavaScript chunk.");
    }
    code = result.output[0].code;
  } catch (error) {
    throw unsupported(`bundle authored modules: ${error.message}`);
  } finally {
    await bundle?.close();
  }
  const identifiers = validateBundledCode(code, graph.compiler, externals);
  return { code, warnings, identifiers };
}

async function emitFactory(graph) {
  const { code, warnings, identifiers } = await emitBundle(graph);
  let prefix = "__dataAuthored";
  while ([...identifiers].some((name) => name.startsWith(prefix))) prefix += "_";
  const runtime = `${prefix}Runtime`;
  const snapshot = `${prefix}Snapshot`;
  const data = `${prefix}Data`;
  const allowed = `${prefix}Allowed`;
  const load = `${prefix}Require`;
  const module = `${prefix}Module`;
  const key = `${prefix}Key`;
  const wanted = `${prefix}Wanted`;
  const namespace = `${prefix}Namespace`;
  const requirements = [...graph.externalImports].map(([name, names]) => [name, [...names].sort()]);
  const factorySource =
    `(function(${runtime}, ${snapshot}) {\n"use strict";\n` +
    `const ${data} = Object.create(null);\n` +
    `Object.defineProperty(${data}, "__esModule", {value:true});\n` +
    `Object.defineProperty(${data}, "default", {enumerable:true, value:${snapshot}});\n` +
    `if (${snapshot} && typeof ${snapshot} === "object") for (const ${key} of Object.keys(${snapshot})) {\n` +
    `if (${key} !== "default" && ${key} !== "__esModule" && ${key} !== "__proto__") Object.defineProperty(${data}, ${key}, {enumerable:true, get:()=>${snapshot}[${key}]});\n}\n` +
    `Object.freeze(${data});\nconst ${allowed} = new Set(${jsonExpression(AUTHORED_RUNTIME_MODULES)});\n` +
    `function ${load}(id) {\nif (id === ${stringLiteral(SNAPSHOT_ID)}) return ${data};\n` +
    `if (${allowed}.has(id) && ${runtime}?.modules && Object.prototype.hasOwnProperty.call(${runtime}.modules,id)) return ${runtime}.modules[id];\n` +
    `throw new Error("Missing bundled Data runtime module: " + id);\n}\n` +
    `for (const [${key}, ${wanted}] of ${jsonExpression(requirements)}) {\nconst ${namespace} = ${load}(${key});\n` +
    `for (const name of ${wanted}) if (!Object.prototype.hasOwnProperty.call(${namespace},name)) throw new Error("Missing bundled Data export " + name + " from " + ${key});\n}\n` +
    `const ${module} = {exports:Object.create(null)};\n` +
    `(function(module,exports,require){\n${code}\n})(${module},${module}.exports,${load});\n` +
    `return {DashboardContent:${module}.exports.DashboardContent,ReportContent:${module}.exports.ReportContent};\n})`;
  graph.compiler.parseJavaScript(factorySource, { sourceType: "script" });
  return { factorySource, warnings };
}

/** Compile only the supported, contained authored graph; no author code runs in Node. */
export async function compileAuthoredModules({ projectRoot, compiler, runtimeModuleExports }) {
  if (compiler?.apiVersion !== 1) throw new Error("Unsupported bundled Data compiler API version.");
  const exports = validateRuntimeModuleExports(runtimeModuleExports);
  const graph = new AuthoredGraph(await realpath(resolve(projectRoot)), compiler, exports);
  const styles = await graph.collect();
  const emitted = await emitFactory(graph);
  return {
    ...emitted,
    ...styles,
    moduleCount: [...graph.modules.values()].filter((record) => record.filename).length + graph.workerModuleCount,
    assetCount: graph.assets.size,
    cssFiles: [...graph.cssFiles].sort(),
    sourceFiles: [...graph.sourceFiles].sort(),
  };
}
