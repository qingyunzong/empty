import {
  DependencyCycleError,
  TemplateRenderError,
  UnknownDependencyError,
  UnknownHelperError,
  UnknownTemplateError,
  type DependencyReason,
  type SourceLocation,
} from "./errors.js";
import {
  helperId,
  resolveDependencyOrder,
  templateId,
  type DependencyReference,
  type DependencyResolution,
} from "./graph.js";
import {
  cloneValue,
  deepMerge,
  isPlainObject,
  mergePackageValues,
  type MergeRecord,
} from "./merge.js";
import {
  parseTemplate,
  type ParsedTemplate,
  type TemplateArgument,
  type TemplateNode,
} from "./template.js";

export type RenderValues = Readonly<Record<string, unknown>>;

export interface HelperContext {
  readonly name: string;
  readonly values: RenderValues;
  lookup(path: string): unknown;
  has(path: string): boolean;
  render(templateName: string): string;
  invoke(helperName: string, ...args: readonly unknown[]): unknown;
}

export type HelperFunction = (
  context: HelperContext,
  ...args: readonly unknown[]
) => unknown;

export interface HelperDefinition {
  readonly dependencies?: readonly string[];
  readonly render: HelperFunction;
}

export type HelperRegistration = HelperFunction | HelperDefinition;

export type TemplateTable =
  | Readonly<Record<string, string>>
  | ReadonlyMap<string, string>;

export type HelperTable =
  | Readonly<Record<string, HelperRegistration>>
  | ReadonlyMap<string, HelperRegistration>;

export interface RenderEngineOptions {
  readonly defaults?: unknown;
  readonly packageValues?: unknown;
  readonly overrides?: unknown;
  readonly templates?: TemplateTable;
  readonly helpers?: HelperTable;
}

export interface RenderResult {
  readonly template: string;
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly version: number;
  readonly values: RenderValues;
}

export interface RenderBatch {
  readonly version: number;
  readonly values: RenderValues;
  readonly order: readonly string[];
  readonly results: ReadonlyMap<string, RenderResult>;
}

interface NormalizedHelper {
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly render: HelperFunction;
}

interface EngineState {
  readonly defaults: unknown;
  readonly packageValues: unknown;
  readonly overrides: unknown;
  readonly templates: ReadonlyMap<string, string>;
  readonly helpers: ReadonlyMap<string, NormalizedHelper>;
  readonly version: number;
}

interface PreparedRegistry {
  readonly templates: ReadonlyMap<string, ParsedTemplate>;
  readonly helpers: ReadonlyMap<string, NormalizedHelper>;
  readonly resolution: DependencyResolution;
  readonly templateNames: readonly string[];
}

interface CallFrame {
  readonly id: string;
  readonly reason: DependencyReason;
  readonly location?: SourceLocation;
}

const textEncoder = new TextEncoder();

function tableEntries<T>(
  table: Readonly<Record<string, T>> | ReadonlyMap<string, T> | undefined,
): Array<[string, T]> {
  if (table === undefined) return [];
  if (table instanceof Map) return [...table.entries()];
  return Object.entries(table as Readonly<Record<string, T>>);
}

function normalizeHelper(
  name: string,
  registration: HelperRegistration,
): NormalizedHelper {
  if (typeof registration === "function") {
    return Object.freeze({
      name,
      dependencies: Object.freeze([]),
      render: registration,
    });
  }

  if (
    registration === null ||
    typeof registration !== "object" ||
    typeof registration.render !== "function"
  ) {
    throw new TypeError(`Helper ${JSON.stringify(name)} must be a function or definition`);
  }

  const dependencies = registration.dependencies ?? [];
  if (!Array.isArray(dependencies) || dependencies.some((item) => typeof item !== "string")) {
    throw new TypeError(
      `Helper ${JSON.stringify(name)} dependencies must be strings`,
    );
  }

  return Object.freeze({
    name,
    dependencies: Object.freeze([...dependencies]),
    render: registration.render,
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry, seen);
    Object.freeze(value);
    return value;
  }

  if (isPlainObject(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (Object.prototype.propertyIsEnumerable.call(value, key)) {
        deepFreeze(value[key], seen);
      }
    }
    Object.freeze(value);
  }

  return value;
}

export function lookupPath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of path.split(".")) {
    if (current instanceof Map) {
      if (!current.has(segment)) return undefined;
      current = current.get(segment);
      continue;
    }
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as MergeRecord)[segment];
  }
  return current;
}

export function hasPath(root: unknown, path: string): boolean {
  let current = root;
  for (const segment of path.split(".")) {
    if (current instanceof Map) {
      if (!current.has(segment)) return false;
      current = current.get(segment);
      continue;
    }
    if (current === null || typeof current !== "object") return false;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return false;
    current = (current as MergeRecord)[segment];
  }
  return true;
}

export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "function":
    case "symbol":
      return "";
    default:
      return JSON.stringify(value, (_key, entry) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ) ?? "";
  }
}

function resolveHelperDependency(
  name: string,
  helpers: ReadonlyMap<string, NormalizedHelper>,
  templates: ReadonlyMap<string, ParsedTemplate>,
): string {
  if (name.startsWith("template:")) return templateId(name.slice(9));
  if (name.startsWith("helper:")) return helperId(name.slice(7));
  if (helpers.has(name)) return helperId(name);
  if (templates.has(name)) return templateId(name);
  return templateId(name);
}

function prepareRegistry(state: EngineState): PreparedRegistry {
  const helperNames = new Set(state.helpers.keys());
  const templates = new Map<string, ParsedTemplate>();
  const templateNames: string[] = [];

  for (const [name, source] of state.templates) {
    templates.set(name, parseTemplate(source, { name, helpers: helperNames }));
    templateNames.push(name);
  }

  const adjacency = new Map<string, DependencyReference[]>();
  for (const [name, template] of templates) {
    adjacency.set(templateId(name), [...template.dependencies]);
  }

  for (const [name, helper] of state.helpers) {
    adjacency.set(
      helperId(name),
      helper.dependencies.map((dependency) => ({
        target: resolveHelperDependency(dependency, state.helpers, templates),
        reason: "declared" as const,
      })),
    );
  }

  const nodeIds = [
    ...templateNames.map((name) => templateId(name)),
    ...[...state.helpers.keys()].map((name) => helperId(name)),
  ];
  const resolution = resolveDependencyOrder(nodeIds, adjacency);

  return {
    templates,
    helpers: state.helpers,
    resolution,
    templateNames: Object.freeze(templateNames),
  };
}

function pathSegments(path: string | readonly string[]): string[] {
  const segments = typeof path === "string" ? path.split(".") : [...path];
  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new TypeError("Override path must contain at least one non-empty segment");
  }
  return segments;
}

function defineOwn(target: MergeRecord, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function nestedOverride(path: readonly string[], value: unknown): MergeRecord {
  let result: unknown = value;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const parent: MergeRecord = {};
    defineOwn(parent, path[index], result);
    result = parent;
  }
  return result as MergeRecord;
}

function deleteNested(
  value: unknown,
  path: readonly string[],
  index: number,
): unknown {
  if (!isPlainObject(value)) return value;
  const clone = cloneValue(value);
  if (index === path.length - 1) {
    Reflect.deleteProperty(clone, path[index]);
    return clone;
  }
  if (!Object.prototype.hasOwnProperty.call(clone, path[index])) return clone;
  defineOwn(
    clone,
    path[index],
    deleteNested(clone[path[index]], path, index + 1),
  );
  return clone;
}

class RenderSession {
  readonly #registry: PreparedRegistry;
  readonly #values: RenderValues;
  readonly #stack: CallFrame[] = [];

  constructor(registry: PreparedRegistry, values: RenderValues) {
    this.#registry = registry;
    this.#values = values;
  }

  enter(
    id: string,
    reason: DependencyReason,
    location?: SourceLocation,
  ): void {
    const cycleStart = this.#stack.findIndex((frame) => frame.id === id);
    if (cycleStart !== -1) {
      const frames = this.#stack.slice(cycleStart);
      const cycle = frames.map((frame) => frame.id).concat(id);
      const edges = [];
      for (let index = 1; index < frames.length; index += 1) {
        edges.push({
          from: frames[index - 1].id,
          to: frames[index].id,
          reason: frames[index].reason,
          ...(frames[index].location === undefined
            ? {}
            : { location: frames[index].location }),
        });
      }
      const last = frames[frames.length - 1];
      edges.push({
        from: last.id,
        to: id,
        reason,
        ...(location === undefined ? {} : { location }),
      });
      throw new DependencyCycleError(cycle, edges);
    }

    this.#stack.push({
      id,
      reason,
      ...(location === undefined ? {} : { location }),
    });
  }

  leave(id: string): void {
    const frame = this.#stack.pop();
    if (frame === undefined || frame.id !== id) {
      throw new Error("Render dependency stack corruption");
    }
  }

  context(name: string): HelperContext {
    return Object.freeze({
      name,
      values: this.#values,
      lookup: (path: string) => lookupPath(this.#values, path),
      has: (path: string) => hasPath(this.#values, path),
      render: (templateName: string) => this.renderTemplate(templateName),
      invoke: (helperName: string, ...args: readonly unknown[]) =>
        this.invokeHelper(helperName, args),
    });
  }

  renderTemplate(
    name: string,
    reason: DependencyReason = "dynamic",
    location?: SourceLocation,
  ): string {
    const template = this.#registry.templates.get(name);
    if (template === undefined) throw new UnknownTemplateError(name);

    const id = templateId(name);
    this.enter(id, reason, location);
    try {
      const parts: string[] = [];
      for (const node of template.nodes) {
        parts.push(this.#renderNode(node));
      }
      return parts.join("");
    } finally {
      this.leave(id);
    }
  }

  #renderNode(node: TemplateNode): string {
    switch (node.type) {
      case "text":
        return node.value;
      case "value":
        try {
          return stringifyValue(lookupPath(this.#values, node.path));
        } catch (error) {
          throw new TemplateRenderError(
            `Failed to read value ${JSON.stringify(node.path)}`,
            node.location,
            error,
          );
        }
      case "include":
        return this.renderTemplate(node.name, "include", node.location);
      case "helper": {
        const args = node.args.map((argument) =>
          this.#resolveArgument(argument),
        );
        const result = this.invokeHelper(
          node.name,
          args,
          node.location,
        );
        try {
          return stringifyValue(result);
        } catch (error) {
          throw new TemplateRenderError(
            `Helper ${JSON.stringify(node.name)} returned an unserializable value`,
            node.location,
            error,
          );
        }
      }
    }
  }

  #resolveArgument(argument: TemplateArgument): unknown {
    if (argument.type === "literal") return argument.value;
    return lookupPath(this.#values, argument.path);
  }

  invokeHelper(
    name: string,
    args: readonly unknown[],
    location?: SourceLocation,
  ): unknown {
    const helper = this.#registry.helpers.get(name);
    if (helper === undefined) throw new UnknownHelperError(name);

    const id = helperId(name);
    this.enter(id, location === undefined ? "dynamic" : "helper", location);
    try {
      const result = helper.render(this.context(name), ...args);
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("Template helpers must return synchronously");
      }
      return result;
    } catch (error) {
      if (
        error instanceof DependencyCycleError ||
        error instanceof TemplateRenderError ||
        error instanceof UnknownHelperError ||
        error instanceof UnknownTemplateError ||
        location === undefined
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new TemplateRenderError(
        `Helper ${JSON.stringify(name)} failed: ${message}`,
        location,
        error,
      );
    } finally {
      this.leave(id);
    }
  }
}

export class RenderSnapshot {
  readonly version: number;
  readonly values: RenderValues;
  readonly #registry: PreparedRegistry;

  constructor(version: number, values: RenderValues, registry: PreparedRegistry) {
    this.version = version;
    this.values = values;
    this.#registry = registry;
    Object.freeze(this);
  }

  get dependencyOrder(): readonly string[] {
    return this.#registry.resolution.order;
  }

  templateNames(): readonly string[] {
    return this.#registry.templateNames;
  }

  helperNames(): readonly string[] {
    return [...this.#registry.helpers.keys()];
  }

  #renderText(name: string): string {
    if (!this.#registry.templates.has(name)) {
      throw new UnknownTemplateError(name);
    }
    return new RenderSession(this.#registry, this.values).renderTemplate(name);
  }

  #result(name: string, text: string): RenderResult {
    return Object.freeze({
      template: name,
      text,
      bytes: textEncoder.encode(text),
      version: this.version,
      values: this.values,
    });
  }

  render(name: string): string {
    return this.#renderText(name);
  }

  renderBytes(name: string): Uint8Array {
    return textEncoder.encode(this.#renderText(name));
  }

  renderResult(name: string): RenderResult {
    return this.#result(name, this.#renderText(name));
  }

  renderBatch(names: readonly string[] = this.templateNames()): RenderBatch {
    const results = new Map<string, RenderResult>();
    for (const name of names) {
      results.set(name, this.renderResult(name));
    }
    return Object.freeze({
      version: this.version,
      values: this.values,
      order: this.dependencyOrder,
      results,
    });
  }

  renderAll(): RenderBatch {
    return this.renderBatch(this.templateNames());
  }
}

export class RenderEngine {
  #state: EngineState;

  constructor(options: RenderEngineOptions = {}) {
    const templates = new Map<string, string>();
    for (const [name, source] of tableEntries(options.templates)) {
      if (typeof source !== "string") {
        throw new TypeError(`Template ${JSON.stringify(name)} must be a string`);
      }
      templates.set(name, source);
    }

    const helpers = new Map<string, NormalizedHelper>();
    for (const [name, helper] of tableEntries(options.helpers)) {
      helpers.set(name, normalizeHelper(name, helper));
    }

    this.#state = {
      defaults: cloneValue(options.defaults ?? {}),
      packageValues:
        options.packageValues === undefined
          ? undefined
          : cloneValue(options.packageValues),
      overrides:
        options.overrides === undefined
          ? undefined
          : cloneValue(options.overrides),
      templates,
      helpers,
      version: 0,
    };
  }

  get version(): number {
    return this.#state.version;
  }

  #next(changes: Partial<Omit<EngineState, "version">>): void {
    this.#state = Object.freeze({
      ...this.#state,
      ...changes,
      version: this.#state.version + 1,
    });
  }

  setDefaults(value: unknown): this {
    this.#next({
      defaults: value === undefined ? {} : cloneValue(value),
    });
    return this;
  }

  setPackageValues(value: unknown): this {
    this.#next({
      packageValues: value === undefined ? undefined : cloneValue(value),
    });
    return this;
  }

  setOverrides(value: unknown): this {
    this.#next({
      overrides: value === undefined ? undefined : cloneValue(value),
    });
    return this;
  }

  replaceOverrides(value: unknown): this {
    return this.setOverrides(value);
  }

  patchOverrides(value: unknown): this {
    if (value === undefined) return this;
    this.#next({
      overrides: deepMerge(
        this.#state.overrides === undefined ? {} : this.#state.overrides,
        value,
      ),
    });
    return this;
  }

  setOverride(path: string | readonly string[], value: unknown): this {
    return this.patchOverrides(nestedOverride(pathSegments(path), value));
  }

  unsetOverride(path: string | readonly string[]): this {
    if (this.#state.overrides === undefined) return this;
    this.#next({
      overrides: deleteNested(
        this.#state.overrides,
        pathSegments(path),
        0,
      ),
    });
    return this;
  }

  clearOverrides(): this {
    this.#next({ overrides: undefined });
    return this;
  }

  setTemplate(name: string, source: string): this {
    if (typeof source !== "string") {
      throw new TypeError(`Template ${JSON.stringify(name)} must be a string`);
    }
    const templates = new Map(this.#state.templates);
    templates.set(name, source);
    this.#next({ templates });
    return this;
  }

  removeTemplate(name: string): this {
    const templates = new Map(this.#state.templates);
    templates.delete(name);
    this.#next({ templates });
    return this;
  }

  setHelper(name: string, helper: HelperRegistration): this {
    const helpers = new Map(this.#state.helpers);
    helpers.set(name, normalizeHelper(name, helper));
    this.#next({ helpers });
    return this;
  }

  removeHelper(name: string): this {
    const helpers = new Map(this.#state.helpers);
    helpers.delete(name);
    this.#next({ helpers });
    return this;
  }

  templateNames(): readonly string[] {
    return [...this.#state.templates.keys()];
  }

  helperNames(): readonly string[] {
    return [...this.#state.helpers.keys()];
  }

  mergedValues(): unknown {
    return mergePackageValues(
      this.#state.defaults,
      this.#state.packageValues,
      this.#state.overrides,
    );
  }

  snapshot(): RenderSnapshot {
    const state = this.#state;
    const values = deepFreeze(
      mergePackageValues(state.defaults, state.packageValues, state.overrides),
    ) as RenderValues;
    return new RenderSnapshot(
      state.version,
      values,
      prepareRegistry(state),
    );
  }

  render(name: string): string {
    return this.snapshot().render(name);
  }

  renderBytes(name: string): Uint8Array {
    return this.snapshot().renderBytes(name);
  }

  renderResult(name: string): RenderResult {
    return this.snapshot().renderResult(name);
  }

  renderBatch(names?: readonly string[]): RenderBatch {
    return this.snapshot().renderBatch(names);
  }

  renderAll(): RenderBatch {
    return this.snapshot().renderAll();
  }

  dependencyOrder(): readonly string[] {
    return this.snapshot().dependencyOrder;
  }
}

export function createRenderEngine(options: RenderEngineOptions = {}): RenderEngine {
  return new RenderEngine(options);
}

export interface RenderSourceOptions {
  readonly name?: string;
  readonly helpers?: HelperTable;
}

export function renderTemplate(
  source: string,
  values: unknown = {},
  options: RenderSourceOptions = {},
): string {
  const name = options.name ?? "main";
  const engine = new RenderEngine({
    overrides: values,
    templates: new Map([[name, source]]),
    ...(options.helpers === undefined ? {} : { helpers: options.helpers }),
  });
  return engine.render(name);
}
