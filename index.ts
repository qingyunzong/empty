/**
 * Composed-tree element locator for RPA engines.
 *
 * The locator walks open shadow roots, slot assignments and same-origin
 * iframes. Every boundary crossing records the document incarnation it came
 * from. A handle is never trusted just because it still points at an Element:
 * resolve() validates the whole boundary chain and re-locates when a boundary,
 * document generation, or the target itself has gone stale.
 */

export type QueryRoot = Document | DocumentFragment | Element;

export type TextMatcher = string | RegExp;

export interface ElementQuery {
  selector?: string;
  tagName?: string;
  id?: string;
  type?: string;
  role?: string | readonly string[];
  name?: TextMatcher;
  ariaLabel?: TextMatcher;
  ariaDescription?: TextMatcher;
  text?: TextMatcher;
  exactText?: string;
  title?: TextMatcher;
  alt?: TextMatcher;
  placeholder?: TextMatcher;
  attributes?: Record<string, string | RegExp | boolean | null>;
  caseSensitive?: boolean;
  /** Overrides the locator option for this query. */
  visibleOnly?: boolean;
}

export interface LocatorOptions {
  /** Defaults to true. Hidden/zero-sized candidates are discarded. */
  requireVisible?: boolean;
  /** Defaults to false. When true, off-screen elements are discarded. */
  inViewportOnly?: boolean;
  includeShadowRoots?: boolean;
  includeSlots?: boolean;
  includeIframes?: boolean;
  maxCandidates?: number;
}

export interface LocateOptions extends LocatorOptions {
  /** CSS querySelector semantics: the root Element itself is not a candidate. */
  includeRoot?: boolean;
}

export interface ResolvedLocateOptions {
  requireVisible: boolean;
  inViewportOnly: boolean;
  includeShadowRoots: boolean;
  includeSlots: boolean;
  includeIframes: boolean;
  maxCandidates: number;
  includeRoot: boolean;
}

export interface DocumentGeneration {
  readonly document: Document;
  readonly token: symbol;
  readonly version: number;
  readonly issuedAt: number;
  readonly reason: string;
}

interface DocumentGenerationState {
  current: DocumentGeneration;
}

const documentGenerations = new WeakMap<Document, DocumentGenerationState>();

const DEFAULT_OPTIONS: ResolvedLocateOptions = {
  requireVisible: true,
  inViewportOnly: false,
  includeShadowRoots: true,
  includeSlots: true,
  includeIframes: true,
  maxCandidates: 10000,
  includeRoot: false,
};

function createGeneration(
  document: Document,
  version: number,
  reason: string,
): DocumentGeneration {
  return {
    document,
    token: Symbol(`document-generation:${version}`),
    version,
    issuedAt: Date.now(),
    reason,
  };
}

/**
 * Returns the current generation token for a Document. The token is stable
 * until invalidateDocumentGeneration()/bumpDocumentGeneration() is called.
 */
export function getDocumentGeneration(document: Document): DocumentGeneration {
  const existing = documentGenerations.get(document);
  if (existing) return existing.current;

  const current = createGeneration(document, 0, "initial");
  documentGenerations.set(document, { current });
  return current;
}

/** Invalidates every handle whose traversal passed through this Document. */
export function bumpDocumentGeneration(
  document: Document,
  reason = "manual",
): DocumentGeneration {
  const existing = documentGenerations.get(document);
  const version = existing ? existing.current.version + 1 : 1;
  const current = createGeneration(document, version, reason);
  documentGenerations.set(document, { current });
  return current;
}

/** Alias kept for callers that model document lifecycle as invalidation. */
export const invalidateDocumentGeneration = bumpDocumentGeneration;

export function isDocumentGenerationCurrent(
  generation: DocumentGeneration,
): boolean {
  const existing = documentGenerations.get(generation.document);
  return !!existing && existing.current.token === generation.token;
}

export type BoundaryKind = "root" | "shadow-root" | "slot" | "iframe";

/**
 * One composed-tree boundary crossed while walking to a candidate. A
 * candidate is only valid while every step's document generation is current
 * and the boundary's host/frame/slot still points at the same object.
 */
export interface TraversalStep {
  readonly kind: BoundaryKind;
  readonly document: Document;
  readonly generation: DocumentGeneration;
  readonly host?: Element;
  readonly shadowRoot?: ShadowRoot;
  readonly slot?: Element;
  readonly frame?: Element;
  readonly assignedNodes?: readonly Node[];
}

export interface RectSnapshot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface CandidateMatch {
  readonly element: Element;
  readonly score: number;
  readonly semanticScore: number;
  readonly geometryScore: number;
  readonly visible: boolean;
  readonly rect: RectSnapshot | null;
  readonly fingerprint: string;
  readonly order: number;
  readonly steps: readonly TraversalStep[];
}

export type LocationStatus = "unique" | "ambiguous" | "not-found";

export interface LocationResult {
  readonly status: LocationStatus;
  readonly query: string | ElementQuery;
  readonly root: QueryRoot;
  readonly rootDocument: Document;
  readonly generation: DocumentGeneration;
  readonly element: Element | null;
  readonly handle: ElementHandle | null;
  readonly score: number;
  readonly semanticScore: number;
  readonly geometryScore: number;
  readonly candidates: readonly CandidateMatch[];
  /** All candidates sharing the highest score. More than one means refuse. */
  readonly ties: readonly CandidateMatch[];
  readonly steps: readonly TraversalStep[];
  readonly reason?: string;
}

export interface RootAnchor {
  readonly kind: "document" | "shadow-root" | "element" | "fragment";
  readonly document: Document;
  readonly window: Window | null;
  readonly path: string | null;
  readonly hostPath: string | null;
}

export interface ElementHandle {
  readonly id: string;
  readonly query: string | ElementQuery;
  readonly normalizedQuery: Readonly<NormalizedQuery>;
  readonly root: QueryRoot;
  readonly rootDocument: Document;
  readonly rootAnchor: RootAnchor;
  readonly element: Element;
  readonly steps: readonly TraversalStep[];
  readonly generation: DocumentGeneration;
  readonly fingerprint: string;
  readonly score: number;
  readonly semanticScore: number;
  readonly geometryScore: number;
  readonly locateOptions: ResolvedLocateOptions;
  readonly revision: number;
  readonly createdAt: number;
}

export type ResolutionStatus =
  | "current"
  | "refreshed"
  | "relocated"
  | "ambiguous"
  | "not-found"
  | "stale";

export interface ResolutionResult {
  readonly status: ResolutionStatus;
  readonly element: Element | null;
  readonly handle: ElementHandle | null;
  readonly previous: ElementHandle;
  readonly result: LocationResult;
  readonly reason?: string;
}

export type ClickRefusalReason =
  | "ambiguous"
  | "not-found"
  | "stale"
  | "hidden"
  | "disabled"
  | "pointer-events-none"
  | "unsafe-target"
  | "blocked"
  | "not-actionable"
  | "exception";

export interface ClickOptions {
  requireVisible?: boolean;
  requireEnabled?: boolean;
  scrollIntoView?: boolean;
  /** Bypasses actionability checks, but never ambiguity or stale-handle checks. */
  force?: boolean;
  beforeClick?: (element: Element) => boolean | void;
}

export type ClickTarget = ElementHandle | LocationResult | Element;

export interface ClickResult {
  readonly clicked: boolean;
  readonly reason: ClickRefusalReason | null;
  readonly element: Element | null;
  readonly handle: ElementHandle | null;
  readonly resolution: ResolutionResult | null;
  readonly error?: unknown;
}

export class LocatorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocatorError";
    this.code = code;
  }
}

export class AmbiguousMatchError extends LocatorError {
  readonly ties: readonly CandidateMatch[];

  constructor(ties: readonly CandidateMatch[]) {
    super(
      "AMBIGUOUS_MATCH",
      `Refusing ambiguous match: ${ties.length} candidates share score ${ties[0]?.score ?? 0}`,
    );
    this.name = "AmbiguousMatchError";
    this.ties = ties;
  }
}

export class StaleElementError extends LocatorError {
  constructor(message: string) {
    super("STALE_ELEMENT", message);
    this.name = "StaleElementError";
  }
}

interface NormalizedQuery {
  selector: string | null;
  tagName: string | null;
  id: string | null;
  type: string | null;
  roles: readonly string[];
  name: TextMatcher | null;
  ariaLabel: TextMatcher | null;
  ariaDescription: TextMatcher | null;
  text: TextMatcher | null;
  exactText: string | null;
  title: TextMatcher | null;
  alt: TextMatcher | null;
  placeholder: TextMatcher | null;
  attributes: ReadonlyArray<{
    name: string;
    value: string | RegExp | boolean | null;
  }>;
  caseSensitive: boolean;
  visibleOnly: boolean | null;
}

interface WalkItem {
  element: Element;
  steps: readonly TraversalStep[];
  order: number;
}

interface GeometryInfo {
  rect: RectSnapshot | null;
  rendered: boolean;
  visibleArea: number;
  visibleInViewport: boolean;
  viewportWidth: number;
  viewportHeight: number;
  viewportIntersectionRatio: number;
  centerDistanceRatio: number;
  score: number;
}

interface HandleValidation {
  valid: boolean;
  reason?: string;
}

let handleSequence = 0;
const handlesByElement = new WeakMap<Element, ElementHandle>();

function isDocument(value: QueryRoot): value is Document {
  return value.nodeType === 9;
}

function isElement(value: QueryRoot | Node | null): value is Element {
  return !!value && value.nodeType === 1;
}

function isShadowRoot(value: QueryRoot): value is ShadowRoot {
  return value.nodeType === 11 && "host" in value;
}

function isDocumentFragment(value: QueryRoot): value is DocumentFragment {
  return value.nodeType === 11 && !("host" in value);
}

function ownerDocumentOf(root: QueryRoot): Document {
  if (isDocument(root)) return root;
  const document = root.ownerDocument;
  if (!document) {
    throw new LocatorError(
      "INVALID_ROOT",
      "Query root is not attached to a Document",
    );
  }
  return document;
}

function getAttribute(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name);
  } catch {
    return null;
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function regexTest(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function matchText(
  value: string,
  matcher: TextMatcher,
  mode: "exact" | "contains",
  caseSensitive: boolean,
): boolean {
  if (matcher instanceof RegExp) return regexTest(matcher, value);

  const left = caseSensitive
    ? normalizeWhitespace(value)
    : normalizeWhitespace(value).toLocaleLowerCase();
  const right = caseSensitive
    ? normalizeWhitespace(matcher)
    : normalizeWhitespace(matcher).toLocaleLowerCase();
  return mode === "exact" ? left === right : left.includes(right);
}

function childNodesOf(node: Node): Node[] {
  try {
    return Array.from(node.childNodes ?? []);
  } catch {
    return [];
  }
}

function elementChildrenOf(node: Node): Element[] {
  try {
    const parent = node as Node & { children?: HTMLCollection };
    if (parent.children) return Array.from(parent.children);
  } catch {
    // Fall through to childNodes.
  }
  return childNodesOf(node).filter(isElement);
}

function parentForVisibility(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;

  try {
    const root = element.getRootNode();
    if (root && root.nodeType === 11 && "host" in root) {
      return (root as ShadowRoot).host;
    }
  } catch {
    // getRootNode may be unavailable in a test double.
  }

  try {
    const frame = element.ownerDocument.defaultView?.frameElement;
    if (frame) return frame;
  } catch {
    // Cross-origin frame access can throw. Stop walking in that case.
  }

  return null;
}

function parentAcrossShadow(node: Node): Node | null {
  if (node.parentNode) return node.parentNode;
  try {
    const root = node.getRootNode();
    if (root.nodeType === 11 && "host" in root) {
      return (root as ShadowRoot).host;
    }
  } catch {
    // No composed parent is available.
  }
  return null;
}

function isInclusiveAncestor(ancestor: Node, element: Element): boolean {
  let current: Node | null = element;
  const seen = new Set<Node>();
  while (current && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentAcrossShadow(current);
  }
  return false;
}

function composedText(element: Element, visited = new Set<Node>()): string {
  if (visited.has(element)) return "";
  visited.add(element);

  const parts: string[] = [];
  const appendNode = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push((node as Text).data ?? node.textContent ?? "");
      return;
    }
    if (!isElement(node) || visited.has(node)) return;
    visited.add(node);

    if (isSlotElement(node)) {
      const assigned = assignedNodesOf(node, true).filter(isElement);
      if (assigned.length > 0) {
        for (const assignedNode of assigned) {
          parts.push(composedText(assignedNode, visited));
        }
        return;
      }
    }

    const shadowRoot = openShadowRoot(node);
    if (shadowRoot) {
      for (const child of elementChildrenOf(shadowRoot)) {
        parts.push(composedText(child, visited));
      }
    }

    for (const child of childNodesOf(node)) appendNode(child);
  };

  for (const child of childNodesOf(element)) appendNode(child);
  return normalizeWhitespace(parts.join(" "));
}

function accessibleName(element: Element, visited = new Set<Element>()): string {
  if (visited.has(element)) return "";
  visited.add(element);

  const ariaLabel = getAttribute(element, "aria-label");
  if (ariaLabel && ariaLabel.trim()) return normalizeWhitespace(ariaLabel);

  const labelledBy = getAttribute(element, "aria-labelledby");
  if (labelledBy) {
    const labels: string[] = [];
    let scope: Document | ShadowRoot = element.ownerDocument;
    try {
      const root = element.getRootNode();
      if (root.nodeType === 11) scope = root as ShadowRoot;
    } catch {
      // Fall back to the owner document.
    }
    for (const id of labelledBy.split(/\s+/)) {
      if (!id) continue;
      try {
        const label = scope.getElementById(id);
        if (label) labels.push(composedText(label));
      } catch {
        // Ignore inaccessible label references.
      }
    }
    const joined = normalizeWhitespace(labels.join(" "));
    if (joined) return joined;
  }

  try {
    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = normalizeWhitespace(
        Array.from(labels)
          .map((label) => composedText(label))
          .join(" "),
      );
      if (text) return text;
    }
  } catch {
    // Not an element with a labels collection.
  }

  const alt = getAttribute(element, "alt");
  if (alt && alt.trim()) return normalizeWhitespace(alt);

  const title = getAttribute(element, "title");
  if (title && title.trim()) return normalizeWhitespace(title);

  const text = composedText(element);
  if (text) return text;

  const placeholder = getAttribute(element, "placeholder");
  return placeholder ? normalizeWhitespace(placeholder) : "";
}

const IMPLICIT_ROLES: Record<string, string> = {
  article: "article",
  aside: "complementary",
  button: "button",
  dialog: "dialog",
  form: "form",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "img",
  li: "listitem",
  main: "main",
  nav: "navigation",
  ol: "list",
  option: "option",
  progress: "progressbar",
  select: "combobox",
  table: "table",
  textarea: "textbox",
  ul: "list",
};

function rolesOf(element: Element): Set<string> {
  const explicit = getAttribute(element, "role");
  if (explicit) {
    return new Set(
      explicit
        .split(/\s+/)
        .filter(Boolean)
        .map((role) => role.toLocaleLowerCase()),
    );
  }

  const roles = new Set<string>();
  const tag = element.localName.toLocaleLowerCase();
  const type = (getAttribute(element, "type") ?? "").toLocaleLowerCase();

  if (tag === "a") {
    if (getAttribute(element, "href") !== null) roles.add("link");
  } else if (tag === "input") {
    if (type === "button" || type === "submit" || type === "reset") {
      roles.add("button");
    } else if (type === "checkbox") {
      roles.add("checkbox");
    } else if (type === "radio") {
      roles.add("radio");
    } else if (type === "range") {
      roles.add("slider");
    } else if (type === "search") {
      roles.add("searchbox");
    } else {
      roles.add("textbox");
    }
  } else {
    const implicit = IMPLICIT_ROLES[tag];
    if (implicit) roles.add(implicit);
  }

  return roles;
}

function isSlotElement(element: Element): boolean {
  return element.localName.toLocaleLowerCase() === "slot";
}

function isIframeElement(element: Element): boolean {
  return element.localName.toLocaleLowerCase() === "iframe";
}

function openShadowRoot(element: Element): ShadowRoot | null {
  const shadowRoot = element.shadowRoot;
  if (!shadowRoot) return null;
  if (shadowRoot.mode === "closed") return null;
  return shadowRoot;
}

function assignedNodesOf(slot: Element, flatten: boolean): Node[] {
  try {
    const assigned = (slot as HTMLSlotElement).assignedNodes({ flatten });
    if (assigned && assigned.length > 0) return Array.from(assigned);
  } catch {
    // Older slot implementations may not accept options.
  }

  try {
    const assigned = (slot as HTMLSlotElement).assignedNodes();
    if (assigned && assigned.length > 0) return Array.from(assigned);
  } catch {
    // Fall back to assignedElements.
  }

  try {
    const assigned = (slot as HTMLSlotElement).assignedElements({ flatten });
    if (assigned && assigned.length > 0) return Array.from(assigned);
  } catch {
    // No slot API available.
  }

  return [];
}

export function getFrameDocument(frame: Element): Document | null {
  try {
    const contentDocument = (frame as HTMLIFrameElement).contentDocument;
    if (contentDocument) return contentDocument;
  } catch {
    return null;
  }

  try {
    return (frame as HTMLIFrameElement).contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

function makeRootStep(
  root: QueryRoot,
  document: Document,
  generation: DocumentGeneration,
): TraversalStep {
  return {
    kind: "root",
    document,
    generation,
    host: isElement(root) ? root : undefined,
    shadowRoot: isShadowRoot(root) ? root : undefined,
  };
}

function makeShadowStep(host: Element, shadowRoot: ShadowRoot): TraversalStep {
  const document = ownerDocumentOf(shadowRoot);
  return {
    kind: "shadow-root",
    document,
    generation: getDocumentGeneration(document),
    host,
    shadowRoot,
  };
}

function makeSlotStep(
  slot: Element,
  assignedNodes: readonly Node[],
): TraversalStep {
  const document = slot.ownerDocument;
  return {
    kind: "slot",
    document,
    generation: getDocumentGeneration(document),
    host: slot,
    slot,
    assignedNodes,
  };
}

function makeIframeStep(
  frame: Element,
  frameDocument: Document,
): TraversalStep {
  return {
    kind: "iframe",
    document: frameDocument,
    generation: getDocumentGeneration(frameDocument),
    host: frame,
    frame,
  };
}

function documentRootChildren(document: Document): Element[] {
  try {
    if (document.documentElement) return [document.documentElement];
  } catch {
    // Fall through.
  }
  return elementChildrenOf(document);
}

function walkComposed(
  root: QueryRoot,
  options: ResolvedLocateOptions,
): WalkItem[] {
  const rootDocument = ownerDocumentOf(root);
  const rootGeneration = getDocumentGeneration(rootDocument);
  const rootStep = makeRootStep(root, rootDocument, rootGeneration);
  const visited = new Set<Element>();
  const items: WalkItem[] = [];
  let order = 0;

  const visit = (element: Element, steps: readonly TraversalStep[]): void => {
    if (visited.has(element)) return;
    visited.add(element);

    if (items.length >= options.maxCandidates) return;

    if (isElement(root) && element === root && !options.includeRoot) {
      // querySelector() semantics: the search root itself is not returned.
    } else {
      items.push({ element, steps, order: order++ });
    }

    if (items.length >= options.maxCandidates) return;

    if (options.includeShadowRoots) {
      const shadowRoot = openShadowRoot(element);
      if (shadowRoot) {
        const shadowStep = makeShadowStep(element, shadowRoot);
        for (const child of elementChildrenOf(shadowRoot)) {
          visit(child, [...steps, shadowStep]);
        }
      }
    }

    if (options.includeSlots && isSlotElement(element)) {
      const assigned = assignedNodesOf(element, true);
      const slotStep = makeSlotStep(element, assigned);
      if (assigned.length > 0) {
        for (const assignedNode of assigned) {
          if (isElement(assignedNode)) {
            visit(assignedNode, [...steps, slotStep]);
          }
        }
        // Fallback content is not rendered while the slot has assignments.
        return;
      }
      for (const child of elementChildrenOf(element)) {
        visit(child, [...steps, slotStep]);
      }
      return;
    }

    if (options.includeIframes && isIframeElement(element)) {
      const frameDocument = getFrameDocument(element);
      if (frameDocument) {
        const frameStep = makeIframeStep(element, frameDocument);
        for (const child of documentRootChildren(frameDocument)) {
          visit(child, [...steps, frameStep]);
        }
      }
    }

    for (const child of elementChildrenOf(element)) {
      visit(child, steps);
    }
  };

  if (isDocument(root) || isShadowRoot(root) || isDocumentFragment(root)) {
    for (const child of elementChildrenOf(root)) visit(child, [rootStep]);
  } else {
    const shadowRoot = options.includeShadowRoots
      ? openShadowRoot(root)
      : null;
    if (shadowRoot) {
      const shadowStep = makeShadowStep(root, shadowRoot);
      for (const child of elementChildrenOf(shadowRoot)) {
        visit(child, [rootStep, shadowStep]);
      }
    }
    if (options.includeIframes && isIframeElement(root)) {
      const frameDocument = getFrameDocument(root);
      if (frameDocument) {
        const frameStep = makeIframeStep(root, frameDocument);
        for (const child of documentRootChildren(frameDocument)) {
          visit(child, [rootStep, frameStep]);
        }
      }
    }
    for (const child of elementChildrenOf(root)) {
      visit(child, [rootStep]);
    }
    if (options.includeRoot) {
      items.unshift({ element: root, steps: [rootStep], order: order++ });
    }
  }

  return items;
}

function normalizeQuery(query: string | ElementQuery): NormalizedQuery {
  if (typeof query === "string") {
    if (!query.trim()) {
      throw new LocatorError("INVALID_QUERY", "Selector cannot be empty");
    }
    return {
      selector: query.trim(),
      tagName: null,
      id: null,
      type: null,
      roles: [],
      name: null,
      ariaLabel: null,
      ariaDescription: null,
      text: null,
      exactText: null,
      title: null,
      alt: null,
      placeholder: null,
      attributes: [],
      caseSensitive: false,
      visibleOnly: null,
    };
  }

  if (!query || typeof query !== "object") {
    throw new LocatorError(
      "INVALID_QUERY",
      "Query must be a selector string or an ElementQuery object",
    );
  }

  const roles =
    query.role === undefined
      ? []
      : (Array.isArray(query.role) ? query.role : [query.role]).map((role) =>
          String(role).toLocaleLowerCase(),
        );

  const attributes = Object.entries(query.attributes ?? {}).map(
    ([name, value]) => ({ name, value }),
  );

  const selector =
    query.selector === undefined || query.selector === null
      ? null
      : String(query.selector).trim();
  if (selector === "") {
    throw new LocatorError("INVALID_QUERY", "Selector cannot be empty");
  }

  const normalized: NormalizedQuery = {
    selector,
    tagName:
      query.tagName === undefined
        ? null
        : String(query.tagName).toLocaleLowerCase(),
    id: query.id === undefined ? null : String(query.id),
    type: query.type === undefined ? null : String(query.type),
    roles,
    name: query.name ?? null,
    ariaLabel: query.ariaLabel ?? null,
    ariaDescription: query.ariaDescription ?? null,
    text: query.text ?? null,
    exactText: query.exactText === undefined ? null : String(query.exactText),
    title: query.title ?? null,
    alt: query.alt ?? null,
    placeholder: query.placeholder ?? null,
    attributes,
    caseSensitive: query.caseSensitive === true,
    visibleOnly:
      query.visibleOnly === undefined ? null : query.visibleOnly === true,
  };

  const hasCriterion =
    normalized.selector !== null ||
    normalized.tagName !== null ||
    normalized.id !== null ||
    normalized.type !== null ||
    normalized.roles.length > 0 ||
    normalized.name !== null ||
    normalized.ariaLabel !== null ||
    normalized.ariaDescription !== null ||
    normalized.text !== null ||
    normalized.exactText !== null ||
    normalized.title !== null ||
    normalized.alt !== null ||
    normalized.placeholder !== null ||
    normalized.attributes.length > 0;

  if (!hasCriterion) {
    throw new LocatorError(
      "INVALID_QUERY",
      "ElementQuery must contain at least one matching criterion",
    );
  }

  return normalized;
}

function selectorMatches(element: Element, selector: string | null): boolean {
  if (!selector || selector === "*") return true;
  try {
    return element.matches(selector);
  } catch (error) {
    throw new LocatorError(
      "INVALID_SELECTOR",
      `Invalid CSS selector "${selector}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function attributeMatches(
  element: Element,
  name: string,
  expected: string | RegExp | boolean | null,
): boolean {
  const actual = getAttribute(element, name);
  if (expected === false || expected === null) return actual === null;
  if (expected === true) return actual !== null;
  if (actual === null) return false;
  if (expected instanceof RegExp) return regexTest(expected, actual);
  return actual === expected;
}

function matchesQuery(element: Element, query: NormalizedQuery): boolean {
  if (!selectorMatches(element, query.selector)) return false;

  if (
    query.tagName !== null &&
    element.localName.toLocaleLowerCase() !== query.tagName
  ) {
    return false;
  }

  if (query.id !== null && element.id !== query.id) return false;

  const type = getAttribute(element, "type");
  if (query.type !== null) {
    if (
      type === null ||
      type.toLocaleLowerCase() !== query.type.toLocaleLowerCase()
    ) {
      return false;
    }
  }

  if (query.roles.length > 0) {
    const roles = rolesOf(element);
    if (!query.roles.some((role) => roles.has(role))) return false;
  }

  if (
    query.name !== null &&
    !matchText(
      accessibleName(element),
      query.name,
      "exact",
      query.caseSensitive,
    )
  ) {
    return false;
  }

  const ariaLabel = getAttribute(element, "aria-label") ?? "";
  if (
    query.ariaLabel !== null &&
    !matchText(ariaLabel, query.ariaLabel, "exact", query.caseSensitive)
  ) {
    return false;
  }

  const ariaDescription = getAttribute(element, "aria-description") ?? "";
  if (
    query.ariaDescription !== null &&
    !matchText(
      ariaDescription,
      query.ariaDescription,
      "exact",
      query.caseSensitive,
    )
  ) {
    return false;
  }

  if (
    query.text !== null &&
    !matchText(
      composedText(element),
      query.text,
      "contains",
      query.caseSensitive,
    )
  ) {
    return false;
  }

  if (
    query.exactText !== null &&
    !matchText(
      composedText(element),
      query.exactText,
      "exact",
      query.caseSensitive,
    )
  ) {
    return false;
  }

  const title = getAttribute(element, "title") ?? "";
  if (
    query.title !== null &&
    !matchText(title, query.title, "exact", query.caseSensitive)
  ) {
    return false;
  }

  const alt = getAttribute(element, "alt") ?? "";
  if (
    query.alt !== null &&
    !matchText(alt, query.alt, "exact", query.caseSensitive)
  ) {
    return false;
  }

  const placeholder = getAttribute(element, "placeholder") ?? "";
  if (
    query.placeholder !== null &&
    !matchText(
      placeholder,
      query.placeholder,
      "exact",
      query.caseSensitive,
    )
  ) {
    return false;
  }

  for (const attribute of query.attributes) {
    if (!attributeMatches(element, attribute.name, attribute.value)) {
      return false;
    }
  }

  return true;
}

function semanticScoreOf(element: Element, query: NormalizedQuery): number {
  let score = 0;

  if (query.selector !== null) score += 5;
  if (query.tagName !== null) score += 12;
  if (query.id !== null) score += 35;
  if (query.type !== null) score += 12;

  if (query.roles.length > 0) {
    const explicit = getAttribute(element, "role");
    score += explicit ? 45 : 32;
  }

  if (query.name !== null) score += 42;
  if (query.ariaLabel !== null) score += 38;
  if (query.ariaDescription !== null) score += 24;
  if (query.exactText !== null) score += 42;
  else if (query.text !== null) score += 28;
  if (query.title !== null) score += 24;
  if (query.alt !== null) score += 24;
  if (query.placeholder !== null) score += 28;
  score += query.attributes.length * 22;

  // Stable semantic identity is useful when a query is selector-only.
  let intrinsic = 0;
  if (getAttribute(element, "role")) intrinsic += 5;
  if (getAttribute(element, "aria-label")) intrinsic += 5;
  for (const name of ["data-testid", "data-test", "data-qa", "data-cy"]) {
    if (getAttribute(element, name)) intrinsic += 5;
  }
  if (getAttribute(element, "name")) intrinsic += 2;
  score += Math.min(intrinsic, 15);

  return score;
}

function box(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}): RectSnapshot {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

function rectsOf(element: Element): RectSnapshot[] {
  const rects: RectSnapshot[] = [];
  try {
    const clientRects = element.getClientRects();
    if (clientRects && clientRects.length > 0) {
      for (const rect of Array.from(clientRects)) rects.push(box(rect));
    }
  } catch {
    // Fall back to getBoundingClientRect.
  }

  if (rects.length === 0) {
    try {
      const rect = element.getBoundingClientRect();
      if (
        rect &&
        [rect.width, rect.height, rect.top, rect.left].every((value) =>
          Number.isFinite(value),
        )
      ) {
        rects.push(box(rect));
      }
    } catch {
      return [];
    }
  }

  return rects.filter((rect) => rect.width > 0 && rect.height > 0);
}

function computedStyle(element: Element): {
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
} | null {
  try {
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return null;
    const style = view.getComputedStyle(element);
    return {
      display: style.display ?? "",
      visibility: style.visibility ?? "",
      opacity: style.opacity ?? "",
      pointerEvents: style.pointerEvents ?? "",
    };
  } catch {
    return null;
  }
}

const layoutAvailability = new WeakMap<Document, boolean>();

function documentHasLayout(document: Document): boolean {
  const cached = layoutAvailability.get(document);
  if (cached !== undefined) return cached;

  let hasLayout = false;
  for (const element of [document.documentElement, document.body]) {
    if (!element) continue;
    try {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        hasLayout = true;
        break;
      }
    } catch {
      // A test double may not implement layout at all.
    }
  }

  layoutAvailability.set(document, hasLayout);
  return hasLayout;
}

function isRendered(element: Element): boolean {
  if (!element.isConnected) return false;
  if (getAttribute(element, "hidden") !== null) return false;

  const seen = new Set<Element>();
  let current: Element | null = element;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (getAttribute(current, "hidden") !== null) return false;

    const style = computedStyle(current);
    if (style) {
      if (style.display === "none") return false;
      if (style.visibility === "hidden" || style.visibility === "collapse") {
        return false;
      }
      if (style.opacity !== "" && Number(style.opacity) === 0) return false;
    }
    current = parentForVisibility(current);
  }

  const rects = rectsOf(element);
  if (rects.length > 0) return true;
  return !documentHasLayout(element.ownerDocument);
}

function viewportOf(element: Element): { width: number; height: number } {
  const view = element.ownerDocument.defaultView;
  if (view && view.innerWidth > 0 && view.innerHeight > 0) {
    return { width: view.innerWidth, height: view.innerHeight };
  }
  const documentElement = element.ownerDocument.documentElement;
  if (documentElement) {
    return {
      width: documentElement.clientWidth || 0,
      height: documentElement.clientHeight || 0,
    };
  }
  return { width: 0, height: 0 };
}

function intersectionArea(
  rect: RectSnapshot,
  width: number,
  height: number,
): number {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(width, rect.right);
  const bottom = Math.min(height, rect.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function geometryOf(element: Element): GeometryInfo {
  const rects = rectsOf(element);
  if (rects.length === 0) {
    const rendered = isRendered(element);
    return {
      rect: null,
      rendered,
      visibleArea: 0,
      visibleInViewport: false,
      viewportWidth: 0,
      viewportHeight: 0,
      viewportIntersectionRatio: 0,
      centerDistanceRatio: 1,
      score: 0,
    };
  }

  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));
  const union: RectSnapshot = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    top,
    right,
    bottom,
    left,
  };

  const viewport = viewportOf(element);
  const hasViewport = viewport.width > 0 && viewport.height > 0;
  const totalArea = rects.reduce(
    (sum, rect) => sum + rect.width * rect.height,
    0,
  );
  const visibleArea = hasViewport
    ? rects.reduce(
        (sum, rect) =>
          sum + intersectionArea(rect, viewport.width, viewport.height),
        0,
      )
    : totalArea;
  const visibleInViewport = visibleArea > 0;
  const viewportIntersectionRatio =
    totalArea > 0 ? Math.min(1, visibleArea / totalArea) : 0;

  let centerDistanceRatio = 0;
  if (hasViewport) {
    const centerX = union.left + union.width / 2;
    const centerY = union.top + union.height / 2;
    const dx = centerX - viewport.width / 2;
    const dy = centerY - viewport.height / 2;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const diagonal = Math.sqrt(
      viewport.width * viewport.width + viewport.height * viewport.height,
    );
    centerDistanceRatio = diagonal > 0 ? Math.min(1, distance / diagonal) : 1;
  }

  const rendered = isRendered(element);
  if (!rendered) {
    return {
      rect: union,
      rendered: false,
      visibleArea,
      visibleInViewport,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      viewportIntersectionRatio,
      centerDistanceRatio,
      score: 0,
    };
  }

  const area = union.width * union.height;
  const areaScore = Math.min(
    24,
    Math.max(0, Math.round(Math.log2(area + 1) * 2)),
  );
  const intersectionScore = Math.round(viewportIntersectionRatio * 20);
  const viewportBonus = visibleInViewport ? 10 : 0;
  const proximityScore = Math.round((1 - centerDistanceRatio) * 10);

  return {
    rect: union,
    rendered,
    visibleArea,
    visibleInViewport,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    viewportIntersectionRatio,
    centerDistanceRatio,
    score: areaScore + intersectionScore + viewportBonus + proximityScore,
  };
}

export function scoreElement(
  element: Element,
  query: string | ElementQuery,
): {
  score: number;
  semanticScore: number;
  geometryScore: number;
  visible: boolean;
  matches: boolean;
  rect: RectSnapshot | null;
} {
  const normalized = normalizeQuery(query);
  const matches = matchesQuery(element, normalized);
  const semanticScore = matches ? semanticScoreOf(element, normalized) : 0;
  const geometry = geometryOf(element);
  return {
    score: semanticScore + geometry.score,
    semanticScore,
    geometryScore: geometry.score,
    visible: geometry.rendered,
    matches,
    rect: geometry.rect,
  };
}

function buildCssPath(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  const seen = new Set<Element>();

  while (current && !seen.has(current) && current.nodeType === 1) {
    seen.add(current);
    let part = current.localName;
    const id = current.id;
    if (id) {
      part += `#${id}`;
      parts.unshift(part);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      let index = 1;
      for (const sibling of elementChildrenOf(parent)) {
        if (sibling === current) break;
        if (
          sibling.localName.toLocaleLowerCase() ===
          current.localName.toLocaleLowerCase()
        ) {
          index += 1;
        }
      }
      part += `:nth-of-type(${index})`;
    }
    parts.unshift(part);
    current = parent;
  }

  return parts.join(" > ");
}

function fingerprintOf(element: Element): string {
  const parts = [element.localName];
  if (element.id) parts.push(`#${element.id}`);
  for (const name of [
    "role",
    "name",
    "aria-label",
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "type",
  ]) {
    const value = getAttribute(element, name);
    if (value !== null) parts.push(`[${name}="${value}"]`);
  }
  const classes = (getAttribute(element, "class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  if (classes.length > 0) parts.push(`.${classes.join(".")}`);
  parts.push(`path=${buildCssPath(element)}`);
  return parts.join("");
}

function createRootAnchor(root: QueryRoot): RootAnchor {
  const document = ownerDocumentOf(root);
  let kind: RootAnchor["kind"] = "fragment";
  let path: string | null = null;
  let hostPath: string | null = null;

  if (isDocument(root)) kind = "document";
  else if (isShadowRoot(root)) {
    kind = "shadow-root";
    hostPath = buildCssPath(root.host);
  } else if (isElement(root)) {
    kind = "element";
    path = buildCssPath(root);
  }

  return {
    kind,
    document,
    window: document.defaultView ?? null,
    path,
    hostPath,
  };
}

function findByPath(document: Document, path: string | null): Element | null {
  if (!path) return null;
  try {
    return document.querySelector(path);
  } catch {
    return null;
  }
}

function anchorDocument(anchor: RootAnchor): Document {
  return anchor.window?.document ?? anchor.document;
}

function anchorFrameDetached(anchor: RootAnchor): boolean {
  try {
    const frame = anchor.window?.frameElement;
    return !!frame && !frame.isConnected;
  } catch {
    return true;
  }
}

function recoverRoot(anchor: RootAnchor, original: QueryRoot): QueryRoot | null {
  if (anchorFrameDetached(anchor)) return null;
  const document = anchorDocument(anchor);

  if (isDocument(original)) {
    return document;
  }

  if (isShadowRoot(original)) {
    const host = original.host;
    if (host && host.isConnected && host.ownerDocument === document) {
      const shadowRoot = openShadowRoot(host);
      if (shadowRoot) return shadowRoot;
    }
    const replacementHost = findByPath(document, anchor.hostPath);
    return replacementHost ? openShadowRoot(replacementHost) : null;
  }

  if (isElement(original)) {
    if (original.isConnected && original.ownerDocument === document) {
      return original;
    }
    return findByPath(document, anchor.path);
  }

  if (isDocumentFragment(original) && original.isConnected) return original;
  return null;
}

function copyQuery(query: string | ElementQuery): string | ElementQuery {
  if (typeof query === "string") return query;
  return {
    ...query,
    role: Array.isArray(query.role) ? [...query.role] : query.role,
    attributes: query.attributes ? { ...query.attributes } : undefined,
  };
}

function resolveOptions(
  options: LocateOptions | undefined,
): ResolvedLocateOptions {
  return { ...DEFAULT_OPTIONS, ...options };
}

function createHandle(
  query: string | ElementQuery,
  normalizedQuery: NormalizedQuery,
  root: QueryRoot,
  candidate: CandidateMatch,
  options: ResolvedLocateOptions,
  revision: number,
): ElementHandle {
  handleSequence += 1;
  const generation =
    candidate.steps[candidate.steps.length - 1]?.generation ??
    getDocumentGeneration(ownerDocumentOf(root));
  const handle: ElementHandle = {
    id: `element-handle-${handleSequence}`,
    query: copyQuery(query),
    normalizedQuery,
    root,
    rootDocument: ownerDocumentOf(root),
    rootAnchor: createRootAnchor(root),
    element: candidate.element,
    steps: candidate.steps,
    generation,
    fingerprint: candidate.fingerprint,
    score: candidate.score,
    semanticScore: candidate.semanticScore,
    geometryScore: candidate.geometryScore,
    locateOptions: options,
    revision,
    createdAt: Date.now(),
  };
  handlesByElement.set(candidate.element, handle);
  return handle;
}

function locateInternal(
  root: QueryRoot,
  query: string | ElementQuery,
  options: LocateOptions | undefined,
): LocationResult {
  if (
    !root ||
    (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)
  ) {
    throw new LocatorError(
      "INVALID_ROOT",
      "Query root must be a Document, ShadowRoot/DocumentFragment, or Element",
    );
  }

  const resolvedOptions = resolveOptions(options);
  const normalizedQuery = normalizeQuery(query);
  const rootDocument = ownerDocumentOf(root);
  const rootGeneration = getDocumentGeneration(rootDocument);
  const candidates: CandidateMatch[] = [];

  for (const item of walkComposed(root, resolvedOptions)) {
    if (!matchesQuery(item.element, normalizedQuery)) continue;

    const requireVisible =
      normalizedQuery.visibleOnly ?? resolvedOptions.requireVisible;
    const geometry = geometryOf(item.element);
    if (!geometry.rendered && requireVisible) continue;
    if (resolvedOptions.inViewportOnly && !geometry.visibleInViewport) continue;

    const semanticScore = semanticScoreOf(item.element, normalizedQuery);
    const score = semanticScore + geometry.score;

    candidates.push({
      element: item.element,
      score,
      semanticScore,
      geometryScore: geometry.score,
      visible: geometry.rendered,
      rect: geometry.rect,
      fingerprint: fingerprintOf(item.element),
      order: item.order,
      steps: item.steps,
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.order - right.order;
  });

  if (candidates.length === 0) {
    return {
      status: "not-found",
      query: copyQuery(query),
      root,
      rootDocument,
      generation: rootGeneration,
      element: null,
      handle: null,
      score: 0,
      semanticScore: 0,
      geometryScore: 0,
      candidates: [],
      ties: [],
      steps: [],
      reason: "no-candidates",
    };
  }

  const topScore = candidates[0].score;
  const ties = candidates.filter((candidate) => candidate.score === topScore);

  if (ties.length > 1) {
    return {
      status: "ambiguous",
      query: copyQuery(query),
      root,
      rootDocument,
      generation: rootGeneration,
      element: null,
      handle: null,
      score: topScore,
      semanticScore: ties[0].semanticScore,
      geometryScore: ties[0].geometryScore,
      candidates,
      ties,
      steps: ties[0].steps,
      reason: "top-score-tie",
    };
  }

  const winner = ties[0];
  const handle = createHandle(
    query,
    normalizedQuery,
    root,
    winner,
    resolvedOptions,
    0,
  );
  return {
    status: "unique",
    query: copyQuery(query),
    root,
    rootDocument,
    generation: rootGeneration,
    element: winner.element,
    handle,
    score: winner.score,
    semanticScore: winner.semanticScore,
    geometryScore: winner.geometryScore,
    candidates,
    ties,
    steps: winner.steps,
  };
}

function validateSteps(
  steps: readonly TraversalStep[],
  element: Element,
): HandleValidation {
  for (const step of steps) {
    if (!isDocumentGenerationCurrent(step.generation)) {
      return {
        valid: false,
        reason: `document-generation-stale:${step.kind}`,
      };
    }

    if (step.kind === "shadow-root") {
      if (!step.host || !step.host.isConnected) {
        return { valid: false, reason: "shadow-host-detached" };
      }
      if (openShadowRoot(step.host) !== step.shadowRoot) {
        return { valid: false, reason: "shadow-root-replaced" };
      }
    }

    if (step.kind === "slot") {
      if (!step.slot || !step.slot.isConnected) {
        return { valid: false, reason: "slot-detached" };
      }
      const expectedAssigned = step.assignedNodes ?? [];
      const currentAssigned = assignedNodesOf(step.slot, true);
      if (expectedAssigned.length > 0) {
        if (
          !currentAssigned.some((assigned) =>
            isInclusiveAncestor(assigned, element),
          )
        ) {
          return { valid: false, reason: "slot-assignment-changed" };
        }
      }
      if (expectedAssigned.length === 0) {
        if (currentAssigned.length > 0) {
          return { valid: false, reason: "slot-assignment-appeared" };
        }
        if (!isInclusiveAncestor(step.slot, element)) {
          return { valid: false, reason: "slot-fallback-changed" };
        }
      }
    }

    if (step.kind === "iframe") {
      if (!step.frame || !step.frame.isConnected) {
        return { valid: false, reason: "iframe-detached" };
      }
      if (getFrameDocument(step.frame) !== step.document) {
        return { valid: false, reason: "iframe-document-replaced" };
      }
    }
  }
  return { valid: true };
}

export function isHandleCurrent(handle: ElementHandle): boolean {
  const validation = validateHandle(handle);
  return validation.valid;
}

function validateHandle(handle: ElementHandle): HandleValidation {
  const element = handle.element;
  if (!element.isConnected) {
    return { valid: false, reason: "element-detached" };
  }

  if (anchorDocument(handle.rootAnchor) !== handle.rootAnchor.document) {
    return { valid: false, reason: "root-document-replaced" };
  }
  if (anchorFrameDetached(handle.rootAnchor)) {
    return { valid: false, reason: "root-frame-detached" };
  }

  const stepValidation = validateSteps(handle.steps, element);
  if (!stepValidation.valid) return stepValidation;

  const lastStep = handle.steps[handle.steps.length - 1];
  if (lastStep && element.ownerDocument !== lastStep.document) {
    return { valid: false, reason: "element-document-changed" };
  }

  if (!matchesQuery(element, handle.normalizedQuery as NormalizedQuery)) {
    return { valid: false, reason: "query-no-longer-matches" };
  }

  const requireVisible =
    handle.normalizedQuery.visibleOnly ?? handle.locateOptions.requireVisible;
  if (requireVisible && !isRendered(element)) {
    return { valid: false, reason: "element-no-longer-visible" };
  }

  return { valid: true };
}

function syntheticResultFromHandle(handle: ElementHandle): LocationResult {
  const candidate: CandidateMatch = {
    element: handle.element,
    score: handle.score,
    semanticScore: handle.semanticScore,
    geometryScore: handle.geometryScore,
    visible: true,
    rect: geometryOf(handle.element).rect,
    fingerprint: handle.fingerprint,
    order: 0,
    steps: handle.steps,
  };
  return {
    status: "unique",
    query: handle.query,
    root: handle.root,
    rootDocument: handle.rootDocument,
    generation: handle.generation,
    element: handle.element,
    handle,
    score: handle.score,
    semanticScore: handle.semanticScore,
    geometryScore: handle.geometryScore,
    candidates: [candidate],
    ties: [candidate],
    steps: handle.steps,
  };
}

/**
 * Resolves a handle, re-locating from its original root when any part of the
 * boundary chain, document generation, or target is stale. The returned
 * handle (when any) is always a fresh object after re-location.
 */
export function resolveElement(handle: ElementHandle): ResolutionResult {
  const validation = validateHandle(handle);
  if (validation.valid) {
    return {
      status: "current",
      element: handle.element,
      handle,
      previous: handle,
      result: syntheticResultFromHandle(handle),
    };
  }

  const root = recoverRoot(handle.rootAnchor, handle.root);
  if (!root) {
    return {
      status: "stale",
      element: null,
      handle: null,
      previous: handle,
      result: {
        ...syntheticResultFromHandle(handle),
        status: "not-found",
        element: null,
        handle: null,
        reason: validation.reason ?? "root-stale",
      },
      reason: validation.reason ?? "root-stale",
    };
  }

  const result = locateInternal(root, handle.query, handle.locateOptions);
  if (result.status !== "unique" || !result.handle) {
    return {
      status: result.status === "ambiguous" ? "ambiguous" : "not-found",
      element: null,
      handle: null,
      previous: handle,
      result,
      reason: result.reason,
    };
  }

  const candidate: CandidateMatch = {
    element: result.element as Element,
    score: result.score,
    semanticScore: result.semanticScore,
    geometryScore: result.geometryScore,
    visible: true,
    rect: result.candidates[0]?.rect ?? null,
    fingerprint: result.candidates[0]?.fingerprint ?? "",
    order: 0,
    steps: result.steps,
  };
  const fresh = createHandle(
    handle.query,
    handle.normalizedQuery as NormalizedQuery,
    root,
    candidate,
    handle.locateOptions,
    handle.revision + 1,
  );
  const relocated = result.element !== handle.element;
  return {
    status: relocated ? "relocated" : "refreshed",
    element: result.element,
    handle: fresh,
    previous: handle,
    result: { ...result, handle: fresh },
    reason: validation.reason,
  };
}

function isDisabled(element: Element): boolean {
  if (getAttribute(element, "disabled") !== null) return true;
  if (getAttribute(element, "aria-disabled")?.toLocaleLowerCase() === "true") {
    return true;
  }
  try {
    return (element as HTMLButtonElement).disabled === true;
  } catch {
    return false;
  }
}

function isPointerEventsNone(element: Element): boolean {
  const style = computedStyle(element);
  return style?.pointerEvents === "none";
}

function dispatchClick(element: Element): void {
  const click = (element as HTMLElement).click;
  if (typeof click === "function") {
    click.call(element);
    return;
  }

  const document = element.ownerDocument;
  const view = document.defaultView;
  try {
    if (view && typeof view.MouseEvent === "function") {
      element.dispatchEvent(
        new view.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view,
        }),
      );
      return;
    }
    const event = document.createEvent("MouseEvents");
    event.initMouseEvent(
      "click",
      true,
      true,
      view as Window,
      0,
      0,
      0,
      0,
      0,
      false,
      false,
      false,
      false,
      0,
      null,
    );
    element.dispatchEvent(event);
  } catch (error) {
    throw new LocatorError(
      "CLICK_DISPATCH_FAILED",
      `Unable to dispatch click: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Clicks only a uniquely resolved, actionability-checked element. Ambiguous
 * top-score ties always refuse, even with force: true.
 */
function looksLikeHandle(value: object): value is ElementHandle {
  return (
    "element" in value &&
    "rootAnchor" in value &&
    "steps" in value &&
    "query" in value
  );
}

export function safeClick(
  target: ClickTarget,
  options: ClickOptions = {},
): ClickResult {
  if (!target || typeof target !== "object") {
    return {
      clicked: false,
      reason: "unsafe-target",
      element: null,
      handle: null,
      resolution: null,
    };
  }
  if ("status" in target && target.status === "ambiguous") {
    return {
      clicked: false,
      reason: "ambiguous",
      element: null,
      handle: null,
      resolution: null,
    };
  }
  if ("status" in target && target.status === "not-found") {
    return {
      clicked: false,
      reason: "not-found",
      element: null,
      handle: null,
      resolution: null,
    };
  }

  let handle: ElementHandle | null = null;
  if ("status" in target) {
    handle = target.handle;
  } else if (looksLikeHandle(target)) {
    handle = target;
  } else if ((target as Element).nodeType === 1) {
    handle = handlesByElement.get(target as Element) ?? null;
  }
  if (
    !handle ||
    typeof (handle as ElementHandle).element !== "object" ||
    !(handle as ElementHandle).rootAnchor
  ) {
    return {
      clicked: false,
      reason: "unsafe-target",
      element: null,
      handle: null,
      resolution: null,
    };
  }

  // Automatic clicks always re-rank the current composed tree so a newly
  // appeared duplicate cannot make an otherwise valid handle win silently.
  const root = recoverRoot(handle.rootAnchor, handle.root);
  if (!root) {
    return {
      clicked: false,
      reason: "stale",
      element: null,
      handle: null,
      resolution: {
        status: "stale",
        element: null,
        handle: null,
        previous: handle,
        result: {
          ...syntheticResultFromHandle(handle),
          status: "not-found",
          element: null,
          handle: null,
          reason: "root-stale",
        },
        reason: "root-stale",
      },
    };
  }

  const ranking = locateInternal(root, handle.query, handle.locateOptions);
  if (ranking.status === "ambiguous") {
    return {
      clicked: false,
      reason: "ambiguous",
      element: null,
      handle: null,
      resolution: {
        status: "ambiguous",
        element: null,
        handle: null,
        previous: handle,
        result: ranking,
        reason: ranking.reason,
      },
    };
  }
  if (ranking.status === "not-found" || !ranking.handle || !ranking.element) {
    return {
      clicked: false,
      reason: "not-found",
      element: null,
      handle: null,
      resolution: {
        status: "not-found",
        element: null,
        handle: null,
        previous: handle,
        result: ranking,
        reason: ranking.reason,
      },
    };
  }

  const freshHandle = ranking.handle;
  const element = ranking.element;
  const resolution: ResolutionResult = {
    status:
      ranking.element === handle.element
        ? isHandleCurrent(handle)
          ? "current"
          : "refreshed"
        : "relocated",
    element,
    handle: freshHandle,
    previous: handle,
    result: ranking,
    reason: "click-rerank",
  };

  // A second validation closes the gap between resolve and click.
  if (!isHandleCurrent(freshHandle)) {
    return {
      clicked: false,
      reason: "stale",
      element: null,
      handle: freshHandle,
      resolution,
    };
  }

  const requireVisible =
    options.requireVisible ?? freshHandle.locateOptions.requireVisible;
  if (!options.force && requireVisible && !isRendered(element)) {
    return {
      clicked: false,
      reason: "hidden",
      element,
      handle: freshHandle,
      resolution,
    };
  }

  if (!options.force && isDisabled(element)) {
    return {
      clicked: false,
      reason: "disabled",
      element,
      handle: freshHandle,
      resolution,
    };
  }

  if (!options.force && isPointerEventsNone(element)) {
    return {
      clicked: false,
      reason: "pointer-events-none",
      element,
      handle: freshHandle,
      resolution,
    };
  }

  if (options.beforeClick) {
    let proceed: boolean | void = true;
    try {
      proceed = options.beforeClick(element);
    } catch (error) {
      return {
        clicked: false,
        reason: "exception",
        element,
        handle: freshHandle,
        resolution,
        error,
      };
    }
    if (proceed === false) {
      return {
        clicked: false,
        reason: "blocked",
        element,
        handle: freshHandle,
        resolution,
      };
    }
  }

  try {
    if (options.scrollIntoView !== false) {
      const scrollIntoView = (element as HTMLElement).scrollIntoView;
      if (typeof scrollIntoView === "function") {
        scrollIntoView.call(element, {
          block: "center",
          inline: "center",
          behavior: "instant" as ScrollBehavior,
        });
      }
    }
    dispatchClick(element);
    return {
      clicked: true,
      reason: null,
      element,
      handle: freshHandle,
      resolution,
    };
  } catch (error) {
    return {
      clicked: false,
      reason: "exception",
      element,
      handle: freshHandle,
      resolution,
      error,
    };
  }
}

export function requireUnique(result: LocationResult): Element {
  if (result.status === "ambiguous") throw new AmbiguousMatchError(result.ties);
  if (result.status === "not-found" || !result.element) {
    throw new LocatorError(
      "NOT_FOUND",
      "No element matched the query in the current composed tree",
    );
  }
  return result.element;
}

export class Locator {
  readonly options: ResolvedLocateOptions;

  constructor(options: LocatorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  locate(
    root: QueryRoot,
    query: string | ElementQuery,
    options: LocateOptions = {},
  ): LocationResult {
    return locateInternal(root, query, { ...this.options, ...options });
  }

  locateInDocument(
    document: Document,
    query: string | ElementQuery,
    options: LocateOptions = {},
  ): LocationResult {
    return this.locate(document, query, options);
  }

  resolve(handle: ElementHandle): ResolutionResult {
    return resolveElement(handle);
  }

  click(
    target: ClickTarget,
    options: ClickOptions = {},
  ): ClickResult {
    return safeClick(target, options);
  }
}

export function locate(
  root: QueryRoot,
  query: string | ElementQuery,
  options: LocateOptions = {},
): LocationResult {
  return locateInternal(root, query, options);
}

export function locateInDocument(
  document: Document,
  query: string | ElementQuery,
  options: LocateOptions = {},
): LocationResult {
  return locateInternal(document, query, options);
}

/** Alias with an explicit verb for callers that prefer findElement(). */
export function findElement(
  root: QueryRoot,
  query: string | ElementQuery,
  options: LocateOptions = {},
): LocationResult {
  return locateInternal(root, query, options);
}

/** Convenience wrapper that refuses ambiguous or missing matches. */
export function locateUnique(
  root: QueryRoot,
  query: string | ElementQuery,
  options: LocateOptions = {},
): Element {
  return requireUnique(locateInternal(root, query, options));
}

export function clickElement(
  target: ClickTarget,
  options: ClickOptions = {},
): ClickResult {
  return safeClick(target, options);
}

export function isElementVisible(element: Element): boolean {
  return isRendered(element);
}

export function getVisibleGeometry(element: Element): RectSnapshot | null {
  return geometryOf(element).rect;
}

export function getComposedPath(element: Element): string {
  return buildCssPath(element);
}

export function createLocator(options: LocatorOptions = {}): Locator {
  return new Locator(options);
}

export function queryAll(
  root: QueryRoot,
  query: string | ElementQuery,
  options: LocateOptions = {},
): Element[] {
  return locateInternal(root, query, options).candidates.map(
    (candidate) => candidate.element,
  );
}

export const locateElement = locate;
export const queryElements = locate;
export const query = locate;
export const locateAll = queryAll;
export const findElements = queryAll;
export const resolveHandle = resolveElement;
export const resolve = resolveElement;
export const click = safeClick;
export const clickHandle = safeClick;
export { Locator as ElementLocator };
