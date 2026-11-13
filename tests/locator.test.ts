import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bumpDocumentGeneration,
  clickElement,
  getDocumentGeneration,
  isHandleCurrent,
  locate,
  resolveElement,
  safeClick,
  type DocumentGeneration,
  type ElementHandle,
} from "../index.js";

type StyleState = {
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
};

class FakeText {
  nodeType = 3;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  data: string;

  constructor(document: FakeDocument, data: string) {
    this.ownerDocument = document;
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  get isConnected(): boolean {
    let current: FakeNode | null = this;
    while (current) {
      if (current.nodeType === 9) return true;
      if (current instanceof FakeShadowRoot) {
        current = current.host;
        continue;
      }
      current = current.parentNode;
    }
    return false;
  }
}

type FakeNode = FakeElement | FakeDocument | FakeShadowRoot | FakeText;

function fakeChildNodes(node: FakeNode): FakeNode[] {
  return node instanceof FakeText ? [] : node.childNodes;
}

function fakeText(node: FakeNode): string {
  if (node instanceof FakeText) return node.data;
  if (node instanceof FakeElement) return node.textContent;
  return "";
}

class FakeWindow {
  document: FakeDocument;
  innerWidth = 1280;
  innerHeight = 720;
  frameElement: FakeElement | null = null;

  constructor(document: FakeDocument) {
    this.document = document;
  }

  getComputedStyle(element: FakeElement): StyleState {
    return { ...element.style };
  }
}

class FakeDocument {
  nodeType = 9;
  ownerDocument: FakeDocument | null = null;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  documentElement!: FakeElement;
  body!: FakeElement;
  defaultView: FakeWindow;

  constructor() {
    this.defaultView = new FakeWindow(this);
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (node): node is FakeElement => node instanceof FakeElement,
    );
  }

  append(node: FakeNode): void {
    node.parentNode = this;
    this.childNodes.push(node);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(this, text);
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeNode): void => {
      if (node instanceof FakeElement) {
        if (node.matches(selector)) found.push(node);
        if (node.shadowRoot) {
          for (const child of node.shadowRoot.children) visit(child);
        }
      }
      for (const child of fakeChildNodes(node)) visit(child);
    };
    for (const child of this.childNodes) visit(child);
    return found;
  }
}

class FakeShadowRoot {
  nodeType = 11;
  mode: "open" | "closed";
  host: FakeElement;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];

  constructor(
    host: FakeElement,
    mode: "open" | "closed",
    document: FakeDocument,
  ) {
    this.host = host;
    this.mode = mode;
    this.ownerDocument = document;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (node): node is FakeElement => node instanceof FakeElement,
    );
  }

  get isConnected(): boolean {
    return this.host.isConnected;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
}

class FakeElement {
  nodeType = 1;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  localName: string;
  tagName: string;
  attributes = new Map<string, string>();
  shadowRoot: FakeShadowRoot | null = null;
  contentDocument: FakeDocument | null = null;
  assigned: FakeNode[] = [];
  clickCount = 0;
  style: StyleState = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    pointerEvents: "auto",
  };
  rect = { x: 10, y: 10, width: 100, height: 40 };
  labels: FakeElement[] = [];

  constructor(document: FakeDocument, tagName: string) {
    this.ownerDocument = document;
    this.localName = tagName.toLocaleLowerCase();
    this.tagName = tagName.toLocaleUpperCase();
    if (this.localName === "slot") {
      this.setAttribute("name", "");
    }
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter(
      (node): node is FakeElement => node instanceof FakeElement,
    );
  }

  get isConnected(): boolean {
    let current: FakeNode | null = this;
    while (current) {
      if (current.nodeType === 9) return true;
      if (current instanceof FakeShadowRoot) {
        current = current.host;
        continue;
      }
      current = current.parentNode;
    }
    return false;
  }

  get textContent(): string {
    return this.childNodes.map((node) => fakeText(node)).join("");
  }

  set textContent(value: string) {
    this.childNodes = [new FakeText(this.ownerDocument, value)];
    for (const child of this.childNodes) child.parentNode = this;
  }

  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  remove(): void {
    if (!this.parentNode) return;
    const parent = this.parentNode as
      | FakeElement
      | FakeDocument
      | FakeShadowRoot;
    parent.childNodes = parent.childNodes.filter((child) => child !== this);
    this.parentNode = null;
  }

  attachShadow(options: { mode: "open" | "closed" }): FakeShadowRoot {
    this.shadowRoot = new FakeShadowRoot(
      this,
      options.mode,
      this.ownerDocument,
    );
    return this.shadowRoot;
  }

  assign(nodes: FakeNode[]): void {
    this.assigned = nodes;
  }

  assignedNodes(options?: { flatten?: boolean }): FakeNode[] {
    void options;
    return this.assigned;
  }

  assignedElements(options?: { flatten?: boolean }): FakeElement[] {
    return this.assignedNodes(options).filter(
      (node): node is FakeElement => node instanceof FakeElement,
    );
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getRootNode(): FakeDocument | FakeShadowRoot {
    let current: FakeNode = this;
    while (current.parentNode) current = current.parentNode;
    return current as FakeDocument | FakeShadowRoot;
  }

  getBoundingClientRect(): {
    x: number;
    y: number;
    width: number;
    height: number;
    top: number;
    right: number;
    bottom: number;
    left: number;
  } {
    if (this.style.display === "none" || this.hasAttribute("hidden")) {
      return {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      };
    }
    return {
      x: this.rect.x,
      y: this.rect.y,
      width: this.rect.width,
      height: this.rect.height,
      top: this.rect.y,
      left: this.rect.x,
      right: this.rect.x + this.rect.width,
      bottom: this.rect.y + this.rect.height,
    };
  }

  getClientRects(): Array<ReturnType<FakeElement["getBoundingClientRect"]>> {
    const rect = this.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? [rect] : [];
  }

  click(): void {
    this.clickCount += 1;
  }

  scrollIntoView(): void {}

  matches(selector: string): boolean {
    return selector
      .split(",")
      .some((part) => matchComplexSelector(this, part.trim()));
  }
}

function matchComplexSelector(element: FakeElement, selector: string): boolean {
  const parts = selector
    .replace(/\s*>\s*/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return false;

  let current: FakeElement | null = element;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (!current || !matchCompoundSelector(current, parts[index])) {
      return false;
    }
    if (index > 0) {
      let ancestor: FakeElement | null = current.parentElement;
      while (ancestor && !matchCompoundSelector(ancestor, parts[index - 1])) {
        ancestor = ancestor.parentElement;
      }
      current = ancestor;
    }
  }
  return true;
}

function matchCompoundSelector(
  element: FakeElement,
  selector: string,
): boolean {
  const tagMatch = selector.match(/^[a-zA-Z][\w-]*/);
  if (
    tagMatch &&
    tagMatch[0].toLocaleLowerCase() !== element.localName.toLocaleLowerCase()
  ) {
    return false;
  }

  for (const id of selector.matchAll(/#([\w-]+)/g)) {
    if (element.id !== id[1]) return false;
  }

  for (const cls of selector.matchAll(/\.([\w-]+)/g)) {
    if (!element.className.split(/\s+/).includes(cls[1])) return false;
  }

  for (const attribute of selector.matchAll(
    /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g,
  )) {
    const name = attribute[1];
    const expected = attribute[2] ?? attribute[3] ?? attribute[4];
    const actual = element.getAttribute(name);
    if (expected === undefined) {
      if (actual === null) return false;
    } else if (actual !== expected) {
      return false;
    }
  }

  const nth = selector.match(/:nth-of-type\((\d+)\)/);
  if (nth) {
    const parent = element.parentElement;
    if (!parent) return false;
    const sameType = parent.children.filter(
      (child) =>
        child.localName.toLocaleLowerCase() ===
        element.localName.toLocaleLowerCase(),
    );
    if (sameType.indexOf(element) + 1 !== Number(nth[1])) return false;
  }

  return true;
}

function makeDocument(): FakeDocument {
  const document = new FakeDocument();
  const html = document.createElement("html");
  const body = document.createElement("body");
  document.append(html);
  html.append(body);
  document.documentElement = html;
  document.body = body;
  return document;
}

function asDocument(document: FakeDocument): Document {
  return document as unknown as Document;
}

function asHandle(handle: ElementHandle | null): ElementHandle {
  assert.ok(handle, "expected a unique handle");
  return handle;
}

function makeButton(
  document: FakeDocument,
  options: {
    id?: string;
    className?: string;
    label?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  } = {},
): FakeElement {
  const button = document.createElement("button");
  if (options.id) button.id = options.id;
  if (options.className) button.className = options.className;
  if (options.label) button.setAttribute("aria-label", options.label);
  button.rect = {
    x: options.x ?? 10,
    y: options.y ?? 10,
    width: options.width ?? 100,
    height: options.height ?? 40,
  };
  return button;
}

test("locates through open shadow roots and slots", () => {
  const document = makeDocument();
  const host = document.createElement("section");
  document.body.append(host);

  const shadowRoot = host.attachShadow({ mode: "open" });
  const slot = document.createElement("slot");
  shadowRoot.append(slot);

  const slotted = makeButton(document, {
    id: "slotted",
    className: "action",
    label: "Slotted action",
  });
  host.append(slotted);
  slot.assign([slotted]);

  const shadowButton = makeButton(document, {
    id: "deep",
    label: "Deep action",
  });
  shadowRoot.append(shadowButton);

  const slottedResult = locate(asDocument(document), "#slotted");
  assert.equal(slottedResult.status, "unique");
  assert.equal(slottedResult.element, slotted as unknown as Element);
  assert.deepEqual(
    slottedResult.steps.map((step) => step.kind),
    ["root", "shadow-root", "slot"],
  );

  const deepResult = locate(asDocument(document), "#deep");
  assert.equal(deepResult.status, "unique");
  assert.deepEqual(
    deepResult.steps.map((step) => step.kind),
    ["root", "shadow-root"],
  );
});

test("text and accessible-name queries see composed content", () => {
  const document = makeDocument();
  const host = document.createElement("div");
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: "open" });
  const button = document.createElement("button");
  button.textContent = "  Save changes  ";
  shadowRoot.append(button);

  const result = locate(asDocument(document), {
    selector: "button",
    text: "Save changes",
    name: "Save changes",
  });
  assert.equal(result.status, "unique");
  assert.equal(result.element, button as unknown as Element);
});

test("slot fallback content remains resolvable", () => {
  const document = makeDocument();
  const host = document.createElement("div");
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: "open" });
  const slot = document.createElement("slot");
  const fallback = makeButton(document, { id: "fallback" });
  slot.append(fallback);
  shadowRoot.append(slot);

  const result = locate(asDocument(document), "#fallback");
  assert.equal(result.status, "unique");
  const handle = asHandle(result.handle);
  assert.equal(isHandleCurrent(handle), true);
  assert.equal(resolveElement(handle).status, "current");
});

test("locates through same-origin iframes and binds the iframe generation", () => {
  const document = makeDocument();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);

  const frameDocument = makeDocument();
  iframe.contentDocument = frameDocument;
  frameDocument.defaultView.frameElement = iframe;

  const frameButton = makeButton(frameDocument, {
    id: "inside-frame",
    label: "Frame action",
  });
  frameDocument.body.append(frameButton);

  const result = locate(asDocument(document), "#inside-frame");
  assert.equal(result.status, "unique");
  assert.equal(result.element, frameButton as unknown as Element);
  const iframeStep = result.steps.find((step) => step.kind === "iframe");
  assert.ok(iframeStep);
  assert.equal(iframeStep.document, frameDocument as unknown as Document);
  assert.equal(
    iframeStep.generation === getDocumentGeneration(frameDocument as unknown as Document),
    true,
  );
});

test("re-locates and refreshes a handle after document generation invalidation", () => {
  const document = makeDocument();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);

  const frameDocument = makeDocument();
  iframe.contentDocument = frameDocument;
  frameDocument.defaultView.frameElement = iframe;
  const frameButton = makeButton(frameDocument, { id: "frame-action" });
  frameDocument.body.append(frameButton);

  const first = locate(asDocument(document), "#frame-action");
  const handle = asHandle(first.handle);
  const oldGeneration: DocumentGeneration = getDocumentGeneration(
    frameDocument as unknown as Document,
  );

  bumpDocumentGeneration(frameDocument as unknown as Document, "navigation");
  assert.equal(isHandleCurrent(handle), false);

  const resolution = resolveElement(handle);
  assert.equal(resolution.status, "refreshed");
  assert.equal(resolution.element, frameButton as unknown as Element);
  assert.ok(resolution.handle);
  assert.equal(resolution.handle.revision, 1);
  assert.notEqual(
    resolution.handle.steps.find((step) => step.kind === "iframe")?.generation,
    oldGeneration,
  );
  assert.equal(
    resolution.handle.steps
      .filter((step) => step.kind === "iframe")
      .every((step) => step.generation.version === 1),
    true,
  );
});

test("iframe navigation never clicks the old document's element", () => {
  const document = makeDocument();
  const iframe = document.createElement("iframe");
  document.body.append(iframe);

  const oldDocument = makeDocument();
  iframe.contentDocument = oldDocument;
  oldDocument.defaultView.frameElement = iframe;
  const oldButton = makeButton(oldDocument, { id: "go" });
  oldDocument.body.append(oldButton);

  const first = locate(asDocument(document), "#go");
  const handle = asHandle(first.handle);

  const newDocument = makeDocument();
  iframe.contentDocument = newDocument;
  newDocument.defaultView.frameElement = iframe;
  const newButton = makeButton(newDocument, { id: "go" });
  newDocument.body.append(newButton);

  const resolution = resolveElement(handle);
  assert.equal(resolution.status, "relocated");
  assert.equal(resolution.element, newButton as unknown as Element);

  const clicked = clickElement(asHandle(resolution.handle));
  assert.equal(clicked.clicked, true);
  assert.equal(oldButton.clickCount, 0);
  assert.equal(newButton.clickCount, 1);
});

test("top-level document replacement re-locates in the browsing context", () => {
  const oldDocument = makeDocument();
  const oldButton = makeButton(oldDocument, { id: "next" });
  oldDocument.body.append(oldButton);
  const handle = asHandle(locate(asDocument(oldDocument), "#next").handle);

  const newDocument = makeDocument();
  const newButton = makeButton(newDocument, { id: "next" });
  newDocument.body.append(newButton);
  oldDocument.defaultView.document = newDocument;

  assert.equal(isHandleCurrent(handle), false);
  const resolution = resolveElement(handle);
  assert.equal(resolution.status, "relocated");
  assert.equal(resolution.element, newButton as unknown as Element);

  const clicked = clickElement(asHandle(resolution.handle));
  assert.equal(clicked.clicked, true);
  assert.equal(oldButton.clickCount, 0);
  assert.equal(newButton.clickCount, 1);
});

test("ties on the top score are ambiguous and refuse clicking", () => {
  const document = makeDocument();
  const left = makeButton(document, { className: "action", label: "Save" });
  const right = makeButton(document, {
    className: "action",
    label: "Save",
    x: 10,
    y: 10,
  });
  document.body.append(left, right);

  const result = locate(asDocument(document), {
    selector: ".action",
    name: "Save",
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.element, null);
  assert.equal(result.ties.length, 2);
  assert.equal(result.ties[0].score, result.ties[1].score);

  const clicked = safeClick(result);
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.reason, "ambiguous");
  assert.equal(left.clickCount, 0);
  assert.equal(right.clickCount, 0);
});

test("semantic attributes and visible geometry break a tie", () => {
  const document = makeDocument();
  const semantic = makeButton(document, { className: "action", label: "Save" });
  semantic.setAttribute("role", "button");
  semantic.setAttribute("data-testid", "save");
  const plain = makeButton(document, { className: "action", label: "Save" });
  document.body.append(plain, semantic);

  const result = locate(asDocument(document), {
    selector: ".action",
    role: "button",
    name: "Save",
  });
  assert.equal(result.status, "unique");
  assert.equal(result.element, semantic as unknown as Element);
  assert.ok(result.semanticScore > result.candidates[1].semanticScore);
});

test("larger visible geometry wins when semantic scores are equal", () => {
  const document = makeDocument();
  const small = makeButton(document, {
    className: "action",
    label: "Open",
    width: 20,
    height: 20,
  });
  const large = makeButton(document, {
    className: "action",
    label: "Open",
    width: 200,
    height: 100,
    x: 40,
    y: 40,
  });
  document.body.append(small, large);

  const result = locate(asDocument(document), {
    selector: ".action",
    name: "Open",
  });
  assert.equal(result.status, "unique");
  assert.equal(result.element, large as unknown as Element);
  assert.ok(result.geometryScore > result.candidates[1].geometryScore);
});

test("automatic click re-ranks and refuses a newly appeared tie", () => {
  const document = makeDocument();
  const original = makeButton(document, { id: "save", label: "Save" });
  document.body.append(original);
  const handle = asHandle(locate(asDocument(document), "#save").handle);

  const duplicate = makeButton(document, { id: "save", label: "Save" });
  document.body.append(duplicate);

  const clicked = safeClick(handle);
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.reason, "ambiguous");
  assert.equal(clicked.resolution?.status, "ambiguous");
  assert.equal(original.clickCount, 0);
  assert.equal(duplicate.clickCount, 0);
});

test("an Element produced by locate can be clicked through its registered handle", () => {
  const document = makeDocument();
  const button = makeButton(document, { id: "registered" });
  document.body.append(button);
  const result = locate(asDocument(document), "#registered");
  assert.equal(result.status, "unique");

  const clicked = safeClick(result.element as Element);
  assert.equal(clicked.clicked, true);
  assert.equal(button.clickCount, 1);
});

test("an unrelated raw Element is refused as an unsafe target", () => {
  const document = makeDocument();
  const button = makeButton(document, { id: "unregistered" });
  document.body.append(button);

  const clicked = safeClick(button as unknown as Element);
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.reason, "unsafe-target");
  assert.equal(button.clickCount, 0);
});

test("detached elements are re-located and the old node is never clicked", () => {
  const document = makeDocument();
  const oldButton = makeButton(document, { id: "save", label: "Save" });
  document.body.append(oldButton);

  const first = locate(asDocument(document), "#save");
  const oldHandle = asHandle(first.handle);

  oldButton.remove();
  const replacement = makeButton(document, { id: "save", label: "Save" });
  document.body.append(replacement);

  assert.equal(isHandleCurrent(oldHandle), false);
  const resolution = resolveElement(oldHandle);
  assert.equal(resolution.status, "relocated");
  assert.equal(resolution.element, replacement as unknown as Element);

  const clicked = clickElement(asHandle(resolution.handle));
  assert.equal(clicked.clicked, true);
  assert.equal(oldButton.clickCount, 0);
  assert.equal(replacement.clickCount, 1);
});

test("clicking a stale handle uses the fresh unique match", () => {
  const document = makeDocument();
  const oldButton = makeButton(document, { id: "submit", label: "Submit" });
  document.body.append(oldButton);
  const handle = asHandle(locate(asDocument(document), "#submit").handle);

  oldButton.remove();
  const replacement = makeButton(document, { id: "submit", label: "Submit" });
  document.body.append(replacement);

  const clicked = safeClick(handle);
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.resolution?.status, "relocated");
  assert.equal(oldButton.clickCount, 0);
  assert.equal(replacement.clickCount, 1);
});

test("detach without a replacement refuses the click", () => {
  const document = makeDocument();
  const button = makeButton(document, { id: "gone" });
  document.body.append(button);
  const handle = asHandle(locate(asDocument(document), "#gone").handle);

  button.remove();
  const resolution = resolveElement(handle);
  assert.equal(resolution.status, "not-found");
  assert.equal(resolution.element, null);

  const clicked = safeClick(handle);
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.reason, "not-found");
  assert.equal(button.clickCount, 0);
});

test("detach followed by a score tie refuses the click", () => {
  const document = makeDocument();
  const original = makeButton(document, { id: "row" });
  document.body.append(original);
  const handle = asHandle(locate(asDocument(document), "#row").handle);

  original.remove();
  const first = makeButton(document, { id: "row" });
  const second = makeButton(document, { id: "row" });
  document.body.append(first, second);

  const resolution = resolveElement(handle);
  assert.equal(resolution.status, "ambiguous");
  assert.equal(resolution.element, null);

  const clicked = safeClick(handle);
  assert.equal(clicked.clicked, false);
  assert.equal(clicked.reason, "ambiguous");
  assert.equal(first.clickCount, 0);
  assert.equal(second.clickCount, 0);
});

test("hidden candidates are filtered by default", () => {
  const document = makeDocument();
  const hidden = makeButton(document, { id: "hidden" });
  hidden.style.display = "none";
  document.body.append(hidden);

  assert.equal(locate(asDocument(document), "#hidden").status, "not-found");
  assert.equal(
    locate(asDocument(document), "#hidden", { requireVisible: false }).status,
    "unique",
  );
});

test("closed shadow roots are not traversed", () => {
  const document = makeDocument();
  const host = document.createElement("div");
  document.body.append(host);
  const shadowRoot = host.attachShadow({ mode: "closed" });
  const closedButton = makeButton(document, { id: "closed" });
  shadowRoot.append(closedButton);

  assert.equal(locate(asDocument(document), "#closed").status, "not-found");
});
