/**
 * Render checks for the source inspector and the citation link.
 *
 * Two things here are load-bearing and neither is visible from a passing render:
 *
 *  - the three API refusals reach the page as **one** message. The API answers absent,
 *    forbidden and stale with a byte-identical 404, so a component that named which one
 *    happened would be telling a reader that a document they may not read exists.
 *  - the citation link carries `rel="noopener noreferrer"`. The app sets no
 *    Content-Security-Policy, so nothing else denies an opened tab a handle on the page
 *    that cited the document.
 *
 * Rendered with React's own server renderer, which is what a review did to find the earlier
 * version: it rewrote the service's abstention wording into its own sentence.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ts = (await import("typescript")).default;
const react = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/** Compile a component module and return its named export. */
async function loadComponent(relative, exportName, extra = "") {
  const source = readFileSync(resolve(here, "../" + relative), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: "react" },
  });
  const body = outputText
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .map((line) => line.replace(/^export (async function|function|const) /, "$1 "))
    .join("\n");
  // Hooks are stubbed: what is under test is the markup, not the fetching, and a hook
  // that actually ran would suspend a synchronous render.
  const factory = new Function(
    "React",
    `
    const useState = (initial) => [initial, () => {}];
    const useEffect = () => {};
    const useRef = (v) => ({ current: v });
    const useCallback = (fn) => fn;
    ${extra}
    ${body}
    return ${exportName};
  `,
  );
  return factory(react);
}

const h = react.createElement;

// --- The citation link, taken from the answer panel. ------------------------------------

const SectionBody = await loadComponent("src/components/source-inspector.tsx", "SectionBody");
// Loaded here rather than beside the checks that need it: the trail assertions below run
// first and reference this too, and a `const` cannot be read before it is initialised.
const parentHeadings = await loadComponent("src/components/source-inspector.tsx", "parentHeadings");

// The heading path is taken from the live corpus. `COM-001/COM-001-S1` carries a two-level
// trail whose last element repeats the section title, so the ordering check uses two
// distinct strings rather than one that would appear twice.
const section = {
  document_id: "COM-001",
  section_id: "COM-001-S1",
  revision: "9d7dbde1-1111-4222-8333-444444444444",
  title: "انتخاب کانال",
  heading_path: ["ارتباطات داخلی و کانال‌های تیم", "انتخاب کانال"],
  text: "برای هماهنگی جاری از کانال رسمی تیم استفاده کنید.\nخط دوم با فاصله و شکست خط.",
};

const markup = renderToStaticMarkup(h(SectionBody, { section, heading: { current: null } }));

// The heading trail is rendered in order, as a trail of its ancestors.
//
// Scoped to the path element rather than the whole page: the corpus repeats the section
// title as the last heading level, so a page-wide `indexOf` finds that string in the `<h2>`
// first and reports the trail backwards. The failure was in the test, not the component.
//
// Three levels, so "in order" means something. With the corpus's own two-level shape the
// assertion could not tell a correctly ordered trail from one with a single level, which
// is the same class of defect as the repeated Part 16 assertion.
const deep = {
  ...section,
  heading_path: ["سازمان", "ارتباطات داخلی و کانال‌های تیم", section.title],
};
const deepMarkup = renderToStaticMarkup(
  h(SectionBody, { section: deep, heading: { current: null } }),
);
const pathMarkup = deepMarkup.match(/<p class="source-path">[\s\S]*?<\/p>/)?.[0] ?? "";

check("the heading path has its own element", pathMarkup.length > 0);
const keptParents = parentHeadings(deep);
check(
  "heading path rendered in order, ancestor first",
  pathMarkup.indexOf("سازمان") > 0 &&
    pathMarkup.indexOf("سازمان") < pathMarkup.indexOf("ارتباطات داخلی"),
  "the deepest level is the heading below, not a step in the trail",
);
check(
  "heading path levels are marked",
  (pathMarkup.match(/›/g) ?? []).length === keptParents.length - 1,
  `${keptParents.length} kept levels need ${keptParents.length - 1} separators`,
);
check("the dropped level is not in the trail", !pathMarkup.includes(section.title));
check("section title rendered", markup.includes(section.title));
check(
  "document and section identifiers rendered",
  markup.includes(section.document_id) && markup.includes(section.section_id),
);

// The text is a text node. If it were injected as markup these would be interpreted; as a
// text node they arrive escaped, which is the whole point of rendering untrusted uploaded
// content this way.
const hostile = {
  ...section,
  text: '<script>alert(1)</script> & "quoted" <b>bold</b>',
};
const hostileMarkup = renderToStaticMarkup(
  h(SectionBody, { section: hostile, heading: { current: null } }),
);
check(
  "document text is escaped, not interpreted",
  !hostileMarkup.includes("<script>") && hostileMarkup.includes("&lt;script&gt;"),
);
check(
  "text is in a pre-wrap container so line breaks survive",
  /source-text/.test(markup) && /pre-wrap|white-space/.test(markup) === false,
  "the container class is present; the rule lives in globals.css",
);

// --- The citation link from the answer. --------------------------------------------------

// The whole panel module is compiled, so `foldRepeated` and `AnswerCard` arrive with it and
// need no stubs - only `SourceLink` is picked out of the result.
// `SourceLink` builds its href with `sourcePath` from the contract module. That one is
// supplied rather than stubbed, because the href is what the citation is: a stub would let
// the test pass on a link that pointed nowhere.
const contractSource = readFileSync(resolve(here, "../src/lib/document-contract.ts"), "utf8");
const pathStart = contractSource.indexOf("export function sourcePath");
const contract = ts.transpileModule(contractSource.slice(pathStart), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const sourcePath = new Function(
  "URLSearchParams",
  `${contract.replace(/^export /gm, "")}\nreturn sourcePath;`,
)(URLSearchParams);

globalThis.__sourcePath = sourcePath;
const SourceLink = await loadComponent(
  "src/components/ask-panel.tsx",
  "SourceLink",
  `const sourcePath = (s) => globalThis.__sourcePath(s);`,
);

const link = renderToStaticMarkup(
  h(SourceLink, {
    source: {
      document_id: section.document_id,
      section_id: section.section_id,
      revision: section.revision,
    },
  }),
);

check("citation link carries the revision it was made against", link.includes(section.revision));
check("citation link opens in a new tab", /target="_blank"/.test(link));
check(
  "citation link denies the opener",
  /rel="noopener noreferrer"/.test(link),
  link.match(/rel="[^"]*"/)?.[0] ?? "no rel",
);

// The link opens the page; the page's own read goes to the proxy. Conflating the two makes
// the inspector fetch itself - a 200 carrying HTML, which the contract reader refuses, and
// the citation renders as a failed read instead of as text. Both addresses are asserted
// here so the mistake cannot return unnoticed.
const apiStart = contractSource.indexOf("export function sourceApiPath");
const apiCompiled = ts.transpileModule(contractSource.slice(apiStart), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const sourceApiPath = new Function(
  `${apiCompiled.replace(/^export /gm, "")}\nreturn sourceApiPath;`,
)();

check(
  "the citation link points at the page, not the proxy",
  link.includes(`href="/sources?document=COM-001`) && !link.includes("/api/sources"),
  link.match(/href="[^"]*"/)?.[0] ?? "no href",
);
check(
  "the section read points at the proxy, not the page",
  sourceApiPath(section) ===
    `/api/sources/COM-001/sections/COM-001-S1?revision=${section.revision}`,
  sourceApiPath(section),
);
check(
  "the two addresses are not the same address",
  sourceApiPath(section) !== sourcePath(section),
  "a page and a JSON read are different things",
);

// The hook that fetches the section is the place the conflation actually happened, so it
// is asserted at the source: the request it issues names `/api/`.
const hookSource = readFileSync(resolve(here, "../src/lib/use-source-section.ts"), "utf8");
const fetchCalls = [...hookSource.matchAll(/fetch\(\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
check(
  "the section read is issued against the proxy address",
  fetchCalls.length === 1 && fetchCalls[0] === "sourceApiPath",
  `fetch(${fetchCalls.join(", ") || "nothing"})`,
);
check(
  "the page address is never fetched",
  !/fetch\([^)]*sourcePath/.test(hookSource),
  "the page is what the link opens; fetching it returns HTML, not a section",
);

// --- The trail's ancestor levels. ---------------------------------------------------------

// The heading trail ends with the section's own title in all 80 corpus sections, so
// printing it in full shows the title twice. `parentHeadings` is checked against that
// measured shape, and against the ZWNJ that most corpus titles contain - a byte comparison
// would leave the repetition standing for exactly the sections that need it removed.
const zwnj = "‌";
// The ZWNJ is in the *title* only, and the trail's last step spells the same words without
// it. A fixture that put the mark in both strings would pass a byte comparison too, and so
// would have asserted nothing about the normalisation it was written for.
const withZwnj = {
  title: `انتخاب${zwnj}مسیر درست`,
  heading_path: ["ثبت و پیگیری درخواست هزینه", "انتخاب مسیر درست"],
};
const withoutZwnj = {
  title: "انتخاب کانال",
  heading_path: ["ارتباطات داخلی و کانال‌های تیم", "انتخاب کانال"],
};

check(
  "the trail's own last step is dropped even when the title carries a ZWNJ",
  parentHeadings(withZwnj).length === 1 &&
    parentHeadings(withZwnj)[0] === "ثبت و پیگیری درخواست هزینه",
  JSON.stringify(parentHeadings(withZwnj)),
);
check(
  "the fixture would fail a byte comparison",
  withZwnj.heading_path[1] !== withZwnj.title,
  "otherwise the check above asserts nothing about normalisation",
);
check(
  "the trail's own last step is dropped when it matches plainly too",
  parentHeadings(withoutZwnj).length === 1,
  JSON.stringify(parentHeadings(withoutZwnj)),
);
check(
  "a trail that does not end in the title is left alone",
  parentHeadings({ title: "الف", heading_path: ["ب", "ج"] }).length === 2,
  "a differing last step is real context, not a duplicate",
);
check(
  "a trail that is only the title leaves nothing behind",
  parentHeadings({ title: "الف", heading_path: ["الف"] }).length === 0,
);

// And on the rendered page: the title appears once, not twice.
const rendered = renderToStaticMarkup(
  h(SectionBody, { section: withoutZwnj, heading: { current: null } }),
);
const trailPart = rendered.match(/<p class="source-path">([\s\S]*?)<\/p>/)?.[1] ?? "";
check(
  "the title is not repeated between the trail and the heading",
  !trailPart.includes(withoutZwnj.title) && rendered.includes(withoutZwnj.title),
  "shown once, as the heading",
);

const DocumentRows = await loadComponent("src/components/document-list.tsx", "DocumentRows");

const list = {
  document_id: "MGR-002",
  title: "گزارش‌های مدیریتی",
  access_role: "manager",
  revision: section.revision,
};
const shared = {
  document_id: "COM-001",
  title: "ارتباطات داخلی",
  access_role: "employee",
  revision: section.revision,
};

const forEmployee = renderToStaticMarkup(
  h(DocumentRows, { documents: [list, shared], role: "employee" }),
);
const forManager = renderToStaticMarkup(
  h(DocumentRows, { documents: [list, shared], role: "manager" }),
);

// The employee sees the same documents either way - the API's allowlist already decided -
// so the label tells them nothing, and putting it on screen draws the boundary between the
// two roles in front of the person it is drawn around.
check(
  "an employee is shown no access label",
  !forEmployee.includes("سطح دسترسی"),
  forEmployee.includes("MGR-002") ? "titles present, no role text" : "list did not render",
);
check(
  "an employee still sees every document in their list",
  forEmployee.includes("MGR-002") && forEmployee.includes("COM-001"),
);
check(
  "a manager is shown the access level of each document",
  forManager.includes("سطح دسترسی: مدیر") && forManager.includes("سطح دسترسی: کارمند"),
);
check(
  "the two roles see the same documents, only the label differs",
  forEmployee.includes("MGR-002") === forManager.includes("MGR-002"),
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all source rendering checks passed");
