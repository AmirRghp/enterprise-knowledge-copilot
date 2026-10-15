/**
 * Navigation checks.
 *
 * The finding these exist for: the sidebar is hidden below 1024px, and the bar that
 * replaces it was rendered for managers alone and listed only two destinations. An employee
 * on a phone therefore had no way to reach the ask page or the document list at all, and a
 * manager could not reach the list either. Reaching one section from a citation is not a
 * substitute - the list is how a reader finds out what they may cite at all.
 *
 * The check is on the rendered markup for both roles. A version that asserted only that
 * `/sources` appears somewhere would pass against a link no employee can see.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ts = (await import("typescript")).default;
const react = (await import("react")).default;
const { renderToStaticMarkup } = await import("react-dom/server");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
};

// `lucide-react` icons are the only collaborator the shell needs; they render to nothing
// here and asserting on them would test the icon library.
const source = readFileSync(resolve(here, "../src/components/workspace-shell.tsx"), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: "react" },
});
const body = outputText
  .split("\n")
  // `import` lines are removed; the one name they supplied that the shell still references
  // is passed in below. Its own `export` is dropped here so the stub does not collide.
  .filter((line) => !line.startsWith("import ") && !line.startsWith("export { SessionControls }"))
  .map((line) => line.replace(/^export (async function|function|const) /, "$1 "))
  .join("\n");

const icon = () => null;
const Link = ({ children, href, ...rest }) => react.createElement("a", { href, ...rest }, children);

// Every icon the shell imports is supplied as a name-matching null component. The names
// are read out of the import statement rather than listed here, so adding an icon to the
// shell cannot make this test fail to compile - which would read as a broken test rather
// than the incompleteness it is.
const icons = [...source.matchAll(/import \{([^}]+)\} from "lucide-react"/g)]
  .flatMap((match) => match[1].split(","))
  .map((name) => name.trim())
  .filter(Boolean);

const factory = new Function(
  "React",
  "Link",
  ...icons,
  "organizationName",
  // Passed as a parameter, not declared: a declaration would shadow nothing but would
  // collide with the shell's own binding of the same name.
  "SessionControls",
  `
    ${body}
    return WorkspaceShell;
  `,
);
const WorkspaceShell = factory(
  react,
  Link,
  ...icons.map((name) => ({ [name]: icon })[name]),
  async () => "سازمان آزمون",
  () => null,
);

const identity = (role) => ({ login: role, role, display_name: role });

const render = async (role, section) =>
  renderToStaticMarkup(
    await WorkspaceShell({ identity: identity(role), section, children: "محتوا" }),
  );

check(
  "staff breadcrumb names the current section",
  /class="breadcrumb-current">مدیریت کارکنان</.test(await render("manager", "users")),
);

for (const role of ["employee", "manager"]) {
  const markup = await render(role, "sources");

  check(
    `staff link follows ${role} permission in sidebar and phone navigation`,
    markup.includes('href="/manager/users"') === (role === "manager"),
  );
  if (role === "manager")
    check(
      "staff navigation marks current page",
      /<a(?=[^>]*href="\/manager\/users")(?=[^>]*aria-current="page")[^>]*>/.test(
        await render(role, "users"),
      ),
    );

  // The phone bar specifically: it is the only navigation below 1024px.
  const mobile = markup.match(/<nav class="mobile-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
  check(`the phone navigation exists for an ${role}`, mobile.length > 0);

  for (const [label, href] of [
    ["overview", "/"],
    ["ask", "/ask"],
    ["sources", "/sources"],
  ]) {
    check(
      `an ${role} can reach ${label} from the phone navigation`,
      new RegExp(`href="${href === "/" ? "/" : href}"`).test(mobile),
      href,
    );
  }

  check(
    `the management link is ${role === "manager" ? "present" : "absent"} for an ${role}`,
    role === "manager"
      ? mobile.includes('href="/manager/documents"')
      : !mobile.includes('href="/manager/documents"'),
  );
  check(
    `the prompt link is ${role === "manager" ? "present" : "absent"} for an ${role}`,
    role === "manager"
      ? mobile.includes('href="/manager/system-prompts"')
      : !mobile.includes('href="/manager/system-prompts"'),
  );

  // The current page is marked, so a reader who has navigated knows where they are - and
  // `aria-current` is what a screen reader announces, not the visual weight alone.
  check(
    `the phone navigation marks the current page for an ${role}`,
    /aria-current="page"/.test(mobile),
  );
}

// The sidebar keeps its own entries; the phone bar is an addition, not a replacement.
const managerMarkup = await render("manager", "manager");
const sidebar = managerMarkup.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
check(
  "the sidebar still lists the sources page for a manager",
  sidebar.includes('href="/sources"'),
);
check(
  "the manager sidebar links to system prompts",
  managerMarkup.includes('href="/manager/system-prompts"') &&
    managerMarkup.includes("سیستم‌پرامپت‌ها"),
);
const employeeMarkup = await render("employee", "ask");
const employeeSidebar = employeeMarkup.match(/<nav class="sidebar-nav"[\s\S]*?<\/nav>/)?.[0] ?? "";
check(
  "the sidebar still lists the sources page for an employee",
  employeeSidebar.includes('href="/sources"'),
);

// The skip link is the keyboard route past the navigation; it must not depend on width.
check(
  "the skip link is present for both roles",
  (await render("employee", "sources")).includes('href="#main-content"') &&
    (await render("manager", "sources")).includes('href="#main-content"'),
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all navigation checks passed");
