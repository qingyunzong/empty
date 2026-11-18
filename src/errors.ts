export interface SourceLocation {
  readonly template: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export type DependencyReason = "include" | "helper" | "declared" | "dynamic";

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly reason: DependencyReason;
  readonly location?: SourceLocation;
}

export function formatLocation(location: SourceLocation): string {
  return `${location.template}:${location.line}:${location.column}`;
}

export class TemplateSyntaxError extends Error {
  readonly template: string;
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  readonly location: SourceLocation;

  constructor(message: string, location: SourceLocation) {
    super(`${message} at ${formatLocation(location)}`);
    this.name = "TemplateSyntaxError";
    this.template = location.template;
    this.offset = location.offset;
    this.line = location.line;
    this.column = location.column;
    this.location = location;
  }
}

export class UnknownDependencyError extends Error {
  readonly from: string;
  readonly dependency: string;
  readonly reason: DependencyReason;
  readonly location: SourceLocation | undefined;

  constructor(
    from: string,
    dependency: string,
    reason: DependencyReason,
    location?: SourceLocation,
  ) {
    const where = location === undefined ? "" : ` at ${formatLocation(location)}`;
    super(`${from} references missing ${dependency}${where}`);
    this.name = "UnknownDependencyError";
    this.from = from;
    this.dependency = dependency;
    this.reason = reason;
    this.location = location;
  }
}

export class DependencyCycleError extends Error {
  readonly cycle: readonly string[];
  readonly edges: readonly DependencyEdge[];
  readonly locations: readonly SourceLocation[];

  constructor(cycle: readonly string[], edges: readonly DependencyEdge[]) {
    const route = cycle.length === 0 ? [] : cycle;
    const details = edges.map((edge) => {
      const location =
        edge.location === undefined ? "" : ` at ${formatLocation(edge.location)}`;
      return `${edge.from} -> ${edge.to} (${edge.reason})${location}`;
    });
    super(
      `Dependency cycle detected: ${route.join(" -> ")}${
        details.length === 0 ? "" : `; ${details.join("; ")}`
      }`,
    );
    this.name = "DependencyCycleError";
    this.cycle = [...route];
    this.edges = [...edges];
    this.locations = edges
      .map((edge) => edge.location)
      .filter((location): location is SourceLocation => location !== undefined);
  }
}

export class UnknownTemplateError extends Error {
  readonly template: string;

  constructor(template: string) {
    super(`Unknown template ${JSON.stringify(template)}`);
    this.name = "UnknownTemplateError";
    this.template = template;
  }
}

export class UnknownHelperError extends Error {
  readonly helper: string;

  constructor(helper: string) {
    super(`Unknown helper ${JSON.stringify(helper)}`);
    this.name = "UnknownHelperError";
    this.helper = helper;
  }
}

export class TemplateRenderError extends Error {
  readonly template: string;
  readonly location: SourceLocation;
  readonly cause?: unknown;

  constructor(message: string, location: SourceLocation, cause?: unknown) {
    super(`${message} at ${formatLocation(location)}`);
    this.name = "TemplateRenderError";
    this.template = location.template;
    this.location = location;
    this.cause = cause;
  }
}
