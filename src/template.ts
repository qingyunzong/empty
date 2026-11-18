import { TemplateSyntaxError, type SourceLocation } from "./errors.js";
import {
  helperId,
  templateId,
  type DependencyReference,
} from "./graph.js";

export interface TextNode {
  readonly type: "text";
  readonly value: string;
}

export interface ValueNode {
  readonly type: "value";
  readonly path: string;
  readonly location: SourceLocation;
}

export interface IncludeNode {
  readonly type: "include";
  readonly name: string;
  readonly location: SourceLocation;
}

export interface LiteralArgument {
  readonly type: "literal";
  readonly value: string | number | boolean | null | undefined;
}

export interface PathArgument {
  readonly type: "path";
  readonly path: string;
}

export type TemplateArgument = LiteralArgument | PathArgument;

export interface HelperNode {
  readonly type: "helper";
  readonly name: string;
  readonly args: readonly TemplateArgument[];
  readonly location: SourceLocation;
}

export type TemplateNode = TextNode | ValueNode | IncludeNode | HelperNode;

export interface ParsedTemplate {
  readonly name: string;
  readonly source: string;
  readonly nodes: readonly TemplateNode[];
  readonly dependencies: readonly DependencyReference[];
}

export interface ParseTemplateOptions {
  readonly name: string;
  readonly helpers?: ReadonlySet<string>;
}

interface Token {
  readonly text: string;
  readonly quoted: boolean;
  readonly offset: number;
}

const NAME_PATTERN =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:[./-][A-Za-z0-9_$]+)*$/;
const NUMBER_PATTERN =
  /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function locate(
  name: string,
  starts: readonly number[],
  offset: number,
): SourceLocation {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const lineIndex = Math.max(0, high);
  return {
    template: name,
    offset,
    line: lineIndex + 1,
    column: offset - starts[lineIndex] + 1,
  };
}

function tokenize(
  source: string,
  baseOffset: number,
  locationAt: (offset: number) => SourceLocation,
): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length) break;

    const start = index;
    const quote = source[index];
    if (quote === '"' || quote === "'") {
      index += 1;
      let text = "";
      let closed = false;
      while (index < source.length) {
        const character = source[index];
        if (character === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (character !== "\\") {
          text += character;
          index += 1;
          continue;
        }

        index += 1;
        if (index >= source.length) break;
        const escaped = source[index];
        index += 1;
        switch (escaped) {
          case "n":
            text += "\n";
            break;
          case "r":
            text += "\r";
            break;
          case "t":
            text += "\t";
            break;
          case "b":
            text += "\b";
            break;
          case "f":
            text += "\f";
            break;
          case "v":
            text += "\v";
            break;
          case "0":
            text += "\0";
            break;
          case "u": {
            const hex = source.slice(index, index + 4);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
              throw new TemplateSyntaxError(
                "Invalid unicode escape",
                locationAt(baseOffset + index - 2),
              );
            }
            text += String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            text += escaped;
        }
      }
      if (!closed) {
        throw new TemplateSyntaxError(
          "Unclosed string literal",
          locationAt(baseOffset + start),
        );
      }
      tokens.push({ text, quoted: true, offset: baseOffset + start });
      continue;
    }

    while (index < source.length && !/\s/.test(source[index])) index += 1;
    tokens.push({
      text: source.slice(start, index),
      quoted: false,
      offset: baseOffset + start,
    });
  }

  return tokens;
}

function argumentFrom(token: Token, location: SourceLocation): TemplateArgument {
  if (token.quoted) return { type: "literal", value: token.text };
  if (token.text === "true") return { type: "literal", value: true };
  if (token.text === "false") return { type: "literal", value: false };
  if (token.text === "null") return { type: "literal", value: null };
  if (token.text === "undefined") return { type: "literal", value: undefined };
  if (NUMBER_PATTERN.test(token.text)) {
    return { type: "literal", value: Number(token.text) };
  }
  if (!NAME_PATTERN.test(token.text)) {
    throw new TemplateSyntaxError(
      `Invalid argument ${JSON.stringify(token.text)}`,
      location,
    );
  }
  return { type: "path", path: token.text };
}

export function parseTemplate(
  source: string,
  options: ParseTemplateOptions,
): ParsedTemplate {
  const starts = lineStarts(source);
  const helpers = options.helpers ?? new Set<string>();
  const nodes: TemplateNode[] = [];
  const dependencies: DependencyReference[] = [];
  let cursor = 0;

  const locationAt = (offset: number): SourceLocation =>
    locate(options.name, starts, offset);

  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open === -1) {
      nodes.push({ type: "text", value: source.slice(cursor) });
      break;
    }

    if (open > cursor) {
      nodes.push({ type: "text", value: source.slice(cursor, open) });
    }

    const triple = source.startsWith("{{{", open);
    const bodyStartOffset = open + (triple ? 3 : 2);
    const closeToken = triple ? "}}}" : "}}";
    const close = source.indexOf(closeToken, bodyStartOffset);
    if (close === -1) {
      throw new TemplateSyntaxError(
        "Unclosed template tag",
        locationAt(open),
      );
    }

    const rawBody = source.slice(bodyStartOffset, close);
    const bodyOffset =
      bodyStartOffset + (rawBody.length - rawBody.trimStart().length);
    const body = rawBody.trim();
    const tagLocation = locationAt(open);

    cursor = close + closeToken.length;

    if (body.length === 0) {
      throw new TemplateSyntaxError("Empty template tag", tagLocation);
    }

    if (body.startsWith("!")) continue;

    if (body.startsWith("#") || body.startsWith("/")) {
      throw new TemplateSyntaxError(
        "Block helpers are not supported; use an inline helper",
        tagLocation,
      );
    }

    if (body.startsWith(">")) {
      const includeSource = body.slice(1).trim();
      const includeOffset =
        bodyOffset + 1 + (body.slice(1).length - body.slice(1).trimStart().length);
      if (includeSource.length === 0) {
        throw new TemplateSyntaxError(
          "Template include requires a name",
          tagLocation,
        );
      }
      const includeTokens = tokenize(
        includeSource,
        includeOffset,
        locationAt,
      );
      if (
        includeTokens.length !== 1 ||
        includeTokens[0].quoted ||
        !NAME_PATTERN.test(includeTokens[0].text)
      ) {
        throw new TemplateSyntaxError(
          "Template include requires one unquoted name",
          locationAt(includeOffset),
        );
      }
      const includeName = includeTokens[0].text;
      nodes.push({
        type: "include",
        name: includeName,
        location: tagLocation,
      });
      dependencies.push({
        target: templateId(includeName),
        reason: "include",
        location: tagLocation,
      });
      continue;
    }

    const tokens = tokenize(body, bodyOffset, locationAt);
    if (tokens.length === 0) {
      throw new TemplateSyntaxError("Empty template tag", tagLocation);
    }
    const first = tokens[0];
    if (first.quoted) {
      throw new TemplateSyntaxError(
        "A template expression must begin with a path or helper name",
        locationAt(first.offset),
      );
    }

    if (helpers.has(first.text)) {
      if (!NAME_PATTERN.test(first.text)) {
        throw new TemplateSyntaxError(
          `Invalid helper name ${JSON.stringify(first.text)}`,
          locationAt(first.offset),
        );
      }
      const args = tokens
        .slice(1)
        .map((token) => argumentFrom(token, locationAt(token.offset)));
      nodes.push({
        type: "helper",
        name: first.text,
        args,
        location: tagLocation,
      });
      dependencies.push({
        target: helperId(first.text),
        reason: "helper",
        location: tagLocation,
      });
      continue;
    }

    if (tokens.length > 1) {
      throw new TemplateSyntaxError(
        `Unknown helper ${JSON.stringify(first.text)}`,
        locationAt(first.offset),
      );
    }

    if (!NAME_PATTERN.test(first.text)) {
      throw new TemplateSyntaxError(
        `Invalid value path ${JSON.stringify(first.text)}`,
        locationAt(first.offset),
      );
    }

    nodes.push({
      type: "value",
      path: first.text,
      location: tagLocation,
    });
  }

  return {
    name: options.name,
    source,
    nodes,
    dependencies,
  };
}
