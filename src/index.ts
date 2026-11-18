export {
  cloneValue,
  deepMerge,
  hasOwn,
  isPlainObject,
  merge,
  mergeLayers,
  mergePackageValues,
  type MergeRecord,
} from "./merge.js";

export {
  DependencyCycleError,
  TemplateRenderError,
  TemplateSyntaxError,
  UnknownDependencyError,
  UnknownHelperError,
  UnknownTemplateError,
  formatLocation,
  type DependencyEdge,
  type DependencyReason,
  type SourceLocation,
} from "./errors.js";

export {
  helperId,
  resolveDependencyOrder,
  templateId,
  type DependencyReference,
  type DependencyResolution,
} from "./graph.js";

export {
  parseTemplate,
  type HelperNode,
  type IncludeNode,
  type LiteralArgument,
  type ParseTemplateOptions,
  type ParsedTemplate,
  type PathArgument,
  type TemplateArgument,
  type TemplateNode,
  type TextNode,
  type ValueNode,
} from "./template.js";

export {
  RenderEngine,
  RenderSnapshot,
  createRenderEngine,
  hasPath,
  lookupPath,
  renderTemplate,
  stringifyValue,
  type HelperContext,
  type HelperDefinition,
  type HelperFunction,
  type HelperRegistration,
  type HelperTable,
  type RenderBatch,
  type RenderEngineOptions,
  type RenderResult,
  type RenderSourceOptions,
  type RenderValues,
  type TemplateTable,
} from "./engine.js";
