import { readFileSync } from "node:fs";
import { installDom, controlledFetch } from "./dom-harness.mjs";

const restore = installDom();
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const ts = (await import("typescript")).default;
const { act } = React;
const source = readFileSync(new URL("../src/components/ask-panel.tsx", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.React,
  },
}).outputText;
const body = transpiled
  .split("\n")
  .filter((line) => !line.startsWith("import "))
  .map((line) => line.replace(/^export /, ""))
  .join("\n");
const navigation = [];
const AskPanel = new Function(
  "React",
  "useCallback",
  "useEffect",
  "useId",
  "useRef",
  "useState",
  "useRouter",
  "PromptComposer",
  "answerContractFrom",
  "sourcePath",
  `${body}\nreturn AskPanel;`,
)(
  React,
  React.useCallback,
  React.useEffect,
  React.useId,
  React.useRef,
  React.useState,
  () => ({ replace: (path) => navigation.push(path) }),
  () => React.createElement("div"),
  (value) => value,
  () => "#",
);
globalThis.window.location = { search: "" };
let poll;
globalThis.window.setInterval = (callback) => {
  poll = callback;
  return 1;
};
globalThis.window.clearInterval = () => {};
const fetchStub = controlledFetch();
const realFetch = globalThis.fetch;
globalThis.fetch = fetchStub;
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const find = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of node.childNodes) {
    const result = find(child, predicate);
    if (result) return result;
  }
  return null;
};
const button = (label) =>
  find(container, (node) => node.tagName === "BUTTON" && node.textContent === label);
const heading = () => find(container, (node) => node.tagName === "H1")?.textContent;
const settle = async (index, value) => {
  await act(async () => {
    fetchStub.respond(index, value);
    fetchStub.pending[index].releaseBody();
  });
};
try {
  await act(async () => root.render(React.createElement(AskPanel)));
  await settle(0, {
    conversations: [
      { conversation_id: "a", title: "گفتگوی الف" },
      { conversation_id: "b", title: "گفتگوی ب" },
    ],
    next_cursor: null,
  });
  await act(async () =>
    button("گفتگوی الف").dispatchEvent(new window.Event("click", { bubbles: true })),
  );
  await act(async () =>
    button("گفتگوی ب").dispatchEvent(new window.Event("click", { bubbles: true })),
  );
  await settle(2, {
    conversation: { conversation_id: "b", title: "گفتگوی ب" },
    turns: [{ turn_id: "b1", question: "پرسش ب", status: "pending" }],
    next_cursor: null,
  });
  if (heading() !== "گفتگوی ب") throw new Error("newer selection was not shown");
  const scroller = find(container, (node) => node.className === "ask-scroll-end");
  const scrollCount = scroller.scrollCount;
  await act(async () => {
    poll();
    poll();
  });
  if (fetchStub.pending.length !== 4) throw new Error("overlapping polls were started");
  await settle(3, {
    conversation: { conversation_id: "b", title: "گفتگوی ب" },
    turns: [{ turn_id: "b1", question: "پرسش ب", status: "pending" }],
    next_cursor: null,
  });
  if (scroller.scrollCount !== scrollCount) {
    throw new Error("unchanged poll scrolled the conversation");
  }
  await settle(1, {
    conversation: { conversation_id: "a", title: "گفتگوی الف" },
    turns: [{ turn_id: "a1", question: "پرسش الف", status: "answered" }],
    next_cursor: null,
  });
  if (heading() !== "گفتگوی ب" || container.textContent.includes("پرسش الف")) {
    throw new Error("late response replaced the selected conversation");
  }
  if (navigation.at(-1) !== "/ask?conversationId=b") {
    throw new Error("URL and conversation diverged");
  }
  console.log("ok   late chat response cannot replace the selected conversation");
  console.log("ok   unchanged polling neither overlaps nor scrolls");
} finally {
  await act(async () => root.unmount());
  globalThis.fetch = realFetch;
  restore();
}
