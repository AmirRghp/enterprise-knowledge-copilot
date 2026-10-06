import React from "react";
import { createRoot } from "react-dom/client";

import { SourcesReceipt } from "../base/src/components/SourcesReceipt.jsx";
import dashboardStyles from "../base/src/styles.css?inline";
import sourcePreviewStyles from "../base/src/source-preview.css?raw";
// Preserve native light-dark() inside the Shadow DOM. Legacy CSS lowering uses
// document-level scheme helpers that cannot follow the host's inherited scheme.
import receiptStyles from "./sources.css?raw";

const mountedReceipts = new WeakMap();

function scopedStyles(styles) {
  return styles.replace(/:root((?:\[[^\]]+\]|:(?:is|not|where)\([^)]*\))*)/gu,
    (_, conditions) => conditions ? `:host(${conditions})` : ":host");
}

export function mountSourcesReceipt(host, payload) {
  if (!host || typeof host.attachShadow !== "function") throw new TypeError("A receipt requires a Shadow DOM host.");
  if (payload?.schemaVersion !== 1 || payload.kind !== "sources" || !payload.items?.length || typeof payload.theme?.css !== "string")
    throw new TypeError("A receipt requires a reviewed sources payload and bundled theme.");
  mountedReceipts.get(host)?.();
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const previousTheme = host.getAttribute("data-app-theme");
  host.setAttribute("data-app-theme", payload.theme.id);
  const stylesheet = host.ownerDocument.createElement("style");
  const scheme = ["dark", "light"].includes(payload.theme.fixedScheme) ? payload.theme.fixedScheme : "inherit";
  stylesheet.textContent = [scopedStyles(dashboardStyles), scopedStyles(payload.theme.css), receiptStyles, sourcePreviewStyles,
    `:host { color-scheme: ${scheme}; }`].join("\n");
  const container = host.ownerDocument.createElement("div");
  shadow.append(stylesheet, container);
  const root = createRoot(container);
  root.render(<SourcesReceipt items={payload.items} />);
  function unmount() {
    if (mountedReceipts.get(host) !== unmount) return;
    mountedReceipts.delete(host);
    root.unmount(); container.remove(); stylesheet.remove();
    if (previousTheme === null) host.removeAttribute("data-app-theme");
    else host.setAttribute("data-app-theme", previousTheme);
  }
  mountedReceipts.set(host, unmount);
  return unmount;
}
