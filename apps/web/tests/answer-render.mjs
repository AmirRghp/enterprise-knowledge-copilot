/**
 * Render AnswerCard with each of the service's four abstention texts and confirm the
 * served text survives to the page.
 *
 * Why this exists: an earlier version of the panel ignored `contract.answer` entirely
 * and wrote its own "no evidence found" sentence, so a conflict was reported to the user
 * as missing evidence. A review caught it by rendering the component; this makes the
 * same check repeatable.
 *
 * Rendered with React's own server renderer rather than a DOM, because what matters is
 * what a reader receives: if the service's words are in the markup, they reach the page.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(resolve(here, "../src/components/ask-panel.tsx"), "utf8");

const ts = (await import("typescript")).default;
const react = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

// The panel is a client component with hooks and network calls, so only the two pure
// functions at the bottom - foldRepeated and AnswerCard - are compiled and evaluated
// here. foldRepeated is included because AnswerCard calls it. The slice runs to the end
// of the file: cutting at the *start* of AnswerCard would remove it entirely, which is
// what an earlier version of this test did.
const foldStart = panelSource.indexOf("function foldRepeated");
const answerStart = panelSource.indexOf("function AnswerCard");
if (foldStart < 0 || answerStart < 0) {
  throw new Error("foldRepeated or AnswerCard is missing from ask-panel.tsx");
}
const compiled = ts.transpileModule(panelSource.slice(foldStart), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // "react", not React's JSXNamespace object: the compiler takes the classic runtime
    // name and emits `React.createElement`, and passing the object left the JSX in the
    // output as raw tags, which then failed to parse.
    jsx: "react",
  },
}).outputText;

// The transpiled output has no imports left - the slice starts below them - and only the
// two function declarations need their `export` removed. Doing both with one blanket
// regex over the whole body once rewrote JSX like `</h2>` into a broken token.
const body = compiled
  .split("\n")
  .filter((line) => !line.startsWith("import "))
  .map((line) => line.replace(/^export (function|const) /, "$1 "))
  .join("\n");

// The parameter is named `React`, not `react`: the classic JSX runtime emits
// `React.createElement`, and naming the parameter `react` gave "React is not defined".
const source = `
function hasBody() { return true; }
${body}
return AnswerCard;
`;
const factory = new Function("React", "sourcePath", `${source}`);
// The panel renders its citations through `sourcePath` from the contract module, which is
// not part of the compiled fragment. The real function is supplied rather than a stub: the
// citation's href is what the reader follows, and a stub would let this test pass on a
// link that pointed nowhere.
const contractSource = readFileSync(resolve(here, "../src/lib/document-contract.ts"), "utf8");
const pathStart = contractSource.indexOf("export function sourcePath");
const compiledPath = ts.transpileModule(contractSource.slice(pathStart), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const sourcePath = new Function(
  "URLSearchParams",
  `${compiledPath.replace(/^export /gm, "")}\nreturn sourcePath;`,
)(URLSearchParams);

const AnswerCard = factory(react, sourcePath);
const h = react.createElement;

const citation = { document_id: "HR-001", section_id: "HR-001-S1", revision: "rev-1" };

// The four texts compose_answer can produce, copied from app/answer/compose.py.
const cases = [
  ["conflict", "اسناد در دسترس دربارهٔ این پرسش با یکدیگر تعارض دارند."],
  ["ambiguous", "اسناد در دسترس دربارهٔ این پرسش روشن و یک‌دست نیستند."],
  ["insufficient evidence", "بر پایهٔ اسناد در دسترس، پاسخ کامل به این پرسش ممکن نیست."],
  ["no stated reason", "بر پایهٔ اسناد در دسترس، پاسخی برای این پرسش تأیید نشد."],
];

let failures = 0;
for (const [name, text] of cases) {
  const markup = renderToStaticMarkup(
    h(AnswerCard, {
      contract: { answer: text, claims: [], sources: [], abstained: true, request_id: "r1" },
    }),
  );
  if (!markup.includes(text)) {
    failures += 1;
    console.error(`FAIL ${name}: the served text is missing from the page`);
  } else if (markup.includes("شاهد کافی پیدا نشد")) {
    failures += 1;
    console.error(`FAIL ${name}: the panel still substitutes its own wording`);
  } else {
    console.log(`ok   ${name}: served text preserved`);
  }
}

// A partial answer keeps both its claims and the service's own warning about what is
// missing. The panel used to replace that warning with its own, losing the reason.
const partial = renderToStaticMarkup(
  h(AnswerCard, {
    contract: {
      answer:
        "مدت ثبت درخواست هفت روز کاری است.\nاسناد در دسترس دربارهٔ این پرسش با یکدیگر تعارض دارند.",
      claims: [
        { text: "مدت ثبت درخواست هفت روز کاری است.", quote: "هفت روز کاری", source: citation },
      ],
      sources: [citation],
      abstained: true,
      request_id: "r2",
    },
  }),
);
if (!partial.includes("با یکدیگر تعارض دارند")) {
  failures += 1;
  console.error("FAIL partial answer: the service's conflict warning was dropped");
} else if (!partial.includes("هفت روز کاری")) {
  failures += 1;
  console.error("FAIL partial answer: the claim text is missing");
} else {
  console.log("ok   partial answer: claim and conflict warning both shown");
}

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("all abstention texts reach the page");
