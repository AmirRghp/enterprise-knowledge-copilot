import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const realRequire = createRequire(import.meta.url);
const source = readFileSync(
  new URL("../src/components/manager-documents.tsx", import.meta.url),
  "utf8",
);
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const loadedModule = { exports: {} };
new Function("require", "module", "exports", output)(
  (name) =>
    name === "next/navigation" ? { useRouter: () => ({ replace() {} }) } : realRequire(name),
  loadedModule,
  loadedModule.exports,
);
const { ManagerDocuments, readDocumentFile } = loadedModule.exports;
const rootLayout = readFileSync(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
assert(rootLayout.includes('lang="fa" dir="rtl"'), "manager route inherits the Persian RTL layout");
assert(styles.includes(".form-field[hidden]"), "the inactive entry mode is actually hidden");

const textData = new FormData();
textData.set("document_text", "  متن فارسی\n\nادامه  ");
const generated = readDocumentFile(textData, "text");
assert(generated instanceof File);
assert.equal(generated.name, "pasted-document.md");
assert.equal(await generated.text(), "  متن فارسی\n\nادامه  ");
assert.equal(textData.get("file"), generated);
assert.equal(textData.has("document_text"), false, "text is not duplicated in multipart body");

const blank = new FormData();
blank.set("document_text", " \n ");
assert.equal(readDocumentFile(blank, "text"), null);
const oversized = new FormData();
oversized.set("document_text", "x".repeat(1024 * 1024 + 1));
assert.equal(readDocumentFile(oversized, "text"), null);
const unsupported = new FormData();
unsupported.set("file", new File(["macro"], "book.xlsm"));
assert.equal(readDocumentFile(unsupported, "file"), null);

const markup = renderToStaticMarkup(React.createElement(ManagerDocuments));
assert(markup.includes('accept=".md,.txt,.pdf,.docx,.xlsx,.xls"'));
assert(markup.includes('name="document_text"') && markup.includes("متن سند"));
assert(markup.includes('aria-label="روش افزودن سند"'));
assert(markup.includes('aria-pressed="false"') && markup.includes("ورود از متن"));
assert.equal(
  (markup.match(/aria-pressed=/g) ?? []).length,
  2,
  "both keyboard-operable mode buttons expose their selected state",
);
console.log(
  "PASS manager document form supports file and text modes with limits and accessible labels",
);
