/**
 * A DOM small enough to read and large enough for React.
 *
 * The defects this file's tests exist for are all about *transitions*: a handle changing
 * while the previous read is still in flight, and a late response body arriving after a
 * newer one has already settled. Neither is visible from a single synchronous render, so
 * the hook has to actually run.
 *
 * `react-dom/server` runs no effects and `react-dom/test-utils` needs a document, and this
 * project has no jsdom. So the document is here, and it is deliberately the smallest one
 * that `react-dom/client` accepts - `document.createElement`, `createTextNode`,
 * `createElementNS`, `addEventListener`, `defaultView`, `body`, `head` and `readyState`.
 * React's DOM bindings touch nothing else at mount time; if they start to, this file fails
 * loudly rather than silently rendering nothing.
 */

class ClassList {
  constructor(element) {
    this.element = element;
  }
  add(...names) {
    const set = new Set((this.element.className || "").split(" ").filter(Boolean));
    for (const name of names) set.add(name);
    this.element.className = [...set].join(" ");
  }
  contains(name) {
    return (this.element.className || "").split(" ").includes(name);
  }
}

class Node {
  constructor(type) {
    this.nodeType = type;
    this.childNodes = [];
    this.parentNode = null;
    this.ownerDocument = null;
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child, before) {
    child.parentNode = this;
    const index = this.childNodes.indexOf(before);
    if (index < 0) return this.appendChild(child);
    this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
}

class TextNode extends Node {
  constructor(text) {
    super(3);
    this.nodeValue = text;
  }
  get textContent() {
    return this.nodeValue;
  }
  set textContent(value) {
    this.nodeValue = value;
  }
}

class Element extends Node {
  constructor(tagName) {
    super(1);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = "";
    this.style = {};
    this.classList = new ClassList(this);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  dispatchEvent(event) {
    event.target = event.target ?? this;
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
    if (event.bubbles && this.parentNode?.dispatchEvent) this.parentNode.dispatchEvent(event);
    return true;
  }
  scrollIntoView() {
    this.scrollCount = (this.scrollCount ?? 0) + 1;
  }
  get textContent() {
    return this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    if (value) this.appendChild(new TextNode(String(value)));
  }
}

const setGlobal = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

class DocumentNode extends Node {
  constructor() {
    super(9);
    this.readyState = "complete";
    this.documentElement = new Element("html");
    this.head = new Element("head");
    this.body = new Element("body");
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.documentElement.ownerDocument = this;
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
    this.listeners = new Map();
  }
  createElement(tagName) {
    const element = new Element(tagName);
    element.ownerDocument = this;
    return element;
  }
  createElementNS(namespace, tagName) {
    return this.createElement(tagName);
  }
  createTextNode(text) {
    const node = new TextNode(text);
    node.ownerDocument = this;
    return node;
  }
  createRange() {
    return {
      setStart: () => {},
      setEnd: () => {},
      collapse: () => {},
      selectNodeContents: () => {},
      createContextualFragment: () => this.createElement("fragment"),
    };
  }
  querySelector() {
    return null;
  }
  getElementById() {
    return null;
  }
  getElementsByTagName() {
    return [];
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
}

/**
 * Install a minimal document as the globals React reads.
 *
 * Returns a restore function. Every test file calls it once and restores at the end, so a
 * document installed by one file cannot be seen by the next.
 */
export function installDom() {
  const document = new DocumentNode();
  const previous = {};
  for (const name of [
    "document",
    "window",
    "navigator",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLIFrameElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLAnchorElement",
    "SVGElement",
    "Event",
    "CustomEvent",
  ]) {
    previous[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  }

  // React's DOM bindings reach for `window.HTMLIFrameElement` (and its siblings) with an
  // `instanceof` on every commit, so an absent constructor throws rather than degrading.
  // They are real classes here because nothing about the elements under test depends on
  // their behaviour - only on their identity.
  class NodeConstructor {}
  const constructors = {
    Node: NodeConstructor,
    Element: class extends NodeConstructor {},
    HTMLElement: class extends NodeConstructor {},
    HTMLIFrameElement: class extends NodeConstructor {},
    HTMLInputElement: class extends NodeConstructor {},
    HTMLTextAreaElement: class extends NodeConstructor {},
    HTMLAnchorElement: class extends NodeConstructor {},
    SVGElement: class extends NodeConstructor {},
    Event: class {
      constructor(type, init = {}) {
        this.type = type;
        this.bubbles = Boolean(init.bubbles);
      }
      preventDefault() {}
      stopPropagation() {}
    },
    CustomEvent: class extends class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    } {},
  };

  const window = {
    document,
    navigator: { userAgent: "node" },
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle) => clearTimeout(handle),
    ...constructors,
  };
  document.defaultView = window;
  // The same constructors have to be reachable globally: the compiled hook runs with
  // `globalThis` as its scope.
  for (const [name, value] of Object.entries(constructors)) {
    if (!(name in globalThis)) setGlobal(name, value);
  }

  // `navigator` is a getter-only global in recent Node, so plain assignment throws.
  // defineProperty is used for all of them so the restore below is exact rather than
  // leaving a writable copy behind.
  const set = setGlobal;

  set("document", document);
  set("window", window);
  set("navigator", window.navigator);
  set("requestAnimationFrame", window.requestAnimationFrame);
  set("cancelAnimationFrame", window.cancelAnimationFrame);
  // React refuses to render outside act() unless this is set, which is exactly the
  // discipline these tests want: every state change is deliberate.
  set("IS_REACT_ACT_ENVIRONMENT", true);

  return () => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

/**
 * A `fetch` the test settles by hand.
 *
 * Each call is recorded and left pending until `respond` releases it, so a test can hold
 * one read open, let a newer one settle, and only then deliver the stale body. That
 * ordering is the whole point: it is the sequence in which a late result overwrites a
 * newer one, and it cannot be produced by a stub that answers immediately.
 */
export function controlledFetch() {
  const pending = [];
  const stub = (url, init = {}) => {
    const call = {
      url: String(url),
      signal: init.signal ?? null,
      /** Settled = the fetch resolved. The body is separate; see `releaseBody`. */
      settled: false,
      bodyReleased: false,
      resolve: null,
      releaseBody: null,
    };
    const promise = new Promise((resolve, reject) => {
      call.resolve = resolve;
      // An aborted request rejects the way a real one does, so the hook's abort handling
      // is exercised rather than bypassed. The listener stays attached after the response
      // resolves, because a real abort also tears down a body that is still being read -
      // dropping the listener at that point is what let a mid-body deadline pass unseen.
      const abort = (event) => {
        const reason = event?.target?.reason ?? call.signal?.reason;
        const error =
          reason instanceof Error
            ? reason
            : Object.assign(new Error("aborted"), { name: "AbortError" });
        reject(error);
        call.abortBody?.(error);
      };
      if (init.signal) {
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort);
      }
    });
    // An abort can arrive before the caller has reached its `await` - an effect's cleanup
    // runs between microtasks - and a rejection nobody is awaiting is reported by Node as an
    // unhandled one, which ends the run before any check can read the state. Marking it
    // handled is not a silencing of the behaviour under test: the caller still receives the
    // rejection through the promise it holds, and still has to act on it.
    promise.catch(() => {});
    call.response = promise;
    pending.push(call);
    return promise;
  };
  stub.pending = pending;
  /**
   * Resolve the nth call with a response whose body is still unread.
   *
   * `json()` stays pending until `releaseBody`, which is what makes the second defect
   * observable: the hook reaches `await response.json()` while its own effect is still
   * current, and only then loses it. A stub that delivered the body with the response
   * could never produce that ordering, and the check would pass for the wrong reason.
   */
  stub.respond = (index, body, status = 200) => {
    const call = pending[index];
    if (!call) throw new Error(`no call at index ${index}; recorded ${pending.length}`);
    call.settled = true;
    // The gate. `json()` returns a promise that only settles when the test opens it, so
    // "resolved but body unread" is a state the test can actually hold the code in.
    //
    // The gate is wired to the abort signal, because a real `Response` body is a stream:
    // aborting after the headers have arrived tears that stream down and the pending
    // `json()` rejects. Without this the harness would swallow the very abort it exists to
    // test, and a deadline landing mid-body would look like it had not fired - the harness
    // would have reported the product's behaviour, which is the one thing it must not do.
    let open;
    let fail;
    const gate = new Promise((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    call.releaseBody = () => {
      if (call.bodyReleased) return;
      call.bodyReleased = true;
      open(undefined);
    };
    call.abortBody = (reason) => {
      if (call.bodyReleased) return;
      call.bodyReleased = true;
      // Rejecting a promise nobody is awaiting is not a failure, but Node reports it as
      // one. Attaching a no-op handler marks it handled; the code under test still sees the
      // rejection through the `json()` it is awaiting.
      gate.catch(() => {});
      fail(reason ?? Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    // A `Response` cannot have its `json()` re-pointed, and the code under test calls it
    // once, so a plain object shaped like one is both sufficient and honest about it.
    call.resolve({
      status,
      ok: status >= 200 && status < 300,
      json: async () => {
        await gate;
        return body;
      },
      headers: new Headers({ "content-type": "application/json" }),
    });
  };
  stub.reject = (index, error) => {
    const call = pending[index];
    if (!call) throw new Error(`no call at index ${index}; recorded ${pending.length}`);
    call.settled = true;
    call.releaseBody = () => {};
    call.resolve(Promise.reject(error));
  };
  return stub;
}

/** A section body shaped like the API's, for a given handle. */
export function sectionBody(handle, overrides = {}) {
  return {
    document_id: handle.document_id,
    section_id: handle.section_id,
    revision: handle.revision,
    title: `عنوان ${handle.section_id}`,
    heading_path: ["سند"],
    text: `متن ${handle.document_id}`,
    ...overrides,
  };
}
