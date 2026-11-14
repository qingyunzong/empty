import type { ProtoSyntax, ReservedRange } from "./types.ts";

interface Token {
  kind: "ident" | "string" | "number" | "punct";
  text: string;
  line: number;
}

export interface ParsedField {
  name: string;
  number: number;
  type: string;
  label: "optional" | "required" | "repeated";
  oneof?: string;
  mapKey?: string;
  mapValue?: string;
  proto3Optional: boolean;
  packed?: boolean;
  jsonName?: string;
  defaultValue?: unknown;
  deprecated?: boolean;
  options: Record<string, unknown>;
  deleted?: boolean;
  group?: boolean;
}

export interface ParsedMessage {
  name: string;
  fields: ParsedField[];
  messages: ParsedMessage[];
  enums: ParsedEnum[];
  oneofs: string[];
  reservedRanges: ReservedRange[];
  reservedNames: string[];
  deletedFields: Array<number | string>;
  mapEntry: boolean;
}

export interface ParsedEnumValue {
  name: string;
  number: number;
  deprecated?: boolean;
}

export interface ParsedEnum {
  name: string;
  values: ParsedEnumValue[];
  reservedRanges: ReservedRange[];
  reservedNames: string[];
  deletedValues: Array<number | string>;
  allowAlias: boolean;
  open?: boolean;
}

export interface ParsedProto {
  syntax: ProtoSyntax;
  edition?: string;
  package: string;
  enumOpen?: boolean;
  messages: ParsedMessage[];
  enums: ParsedEnum[];
  deletedMessages: string[];
  deletedEnums: string[];
  history?: import("./types.ts").SchemaHistory;
}

class Lexer {
  private index = 0;
  private line = 1;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  next(): Token | null {
    this.skipTrivia();
    if (this.index >= this.source.length) return null;

    const startLine = this.line;
    const char = this.source[this.index];

    if (char === '"' || char === "'") {
      return { kind: "string", text: this.readString(char), line: startLine };
    }

    if (/[A-Za-z_]/.test(char)) {
      let text = "";
      while (this.index < this.source.length && /[A-Za-z0-9_]/.test(this.source[this.index])) {
        text += this.source[this.index++];
      }
      return { kind: "ident", text, line: startLine };
    }

    if (/[0-9]/.test(char)) {
      return { kind: "number", text: this.readNumber(), line: startLine };
    }

    this.index++;
    return { kind: "punct", text: char, line: startLine };
  }

  private skipTrivia(): void {
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === "\n") {
        this.line++;
        this.index++;
        continue;
      }
      if (char === " " || char === "\r" || char === "\t" || char === "\f" || char === "\v") {
        this.index++;
        continue;
      }
      if (char === "/" && this.source[this.index + 1] === "/") {
        this.index += 2;
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index++;
        continue;
      }
      if (char === "/" && this.source[this.index + 1] === "*") {
        this.index += 2;
        while (this.index < this.source.length) {
          if (this.source[this.index] === "\n") this.line++;
          if (this.source[this.index] === "*" && this.source[this.index + 1] === "/") {
            this.index += 2;
            break;
          }
          this.index++;
        }
        continue;
      }
      break;
    }
  }

  private readString(quote: string): string {
    this.index++;
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return value;
      if (char === "\\") {
        if (this.index >= this.source.length) break;
        const escaped = this.source[this.index++];
        switch (escaped) {
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "\\":
          case "'":
          case '"':
            value += escaped;
            break;
          case "x": {
            let hex = "";
            while (hex.length < 2 && /[0-9a-fA-F]/.test(this.source[this.index] ?? "")) {
              hex += this.source[this.index++];
            }
            value += String.fromCharCode(Number.parseInt(hex || "0", 16));
            break;
          }
          default:
            value += escaped;
        }
        continue;
      }
      if (char === "\n") this.line++;
      value += char;
    }
    return value;
  }

  private readNumber(): string {
    let value = "";
    if (this.source[this.index] === "0" && /[xX]/.test(this.source[this.index + 1] ?? "")) {
      value += this.source[this.index++];
      value += this.source[this.index++];
      while (/[0-9a-fA-F]/.test(this.source[this.index] ?? "")) value += this.source[this.index++];
      return value;
    }
    while (/[0-9]/.test(this.source[this.index] ?? "")) value += this.source[this.index++];
    if (this.source[this.index] === "." && /[0-9]/.test(this.source[this.index + 1] ?? "")) {
      value += this.source[this.index++];
      while (/[0-9]/.test(this.source[this.index] ?? "")) value += this.source[this.index++];
    }
    if (/[eE]/.test(this.source[this.index] ?? "")) {
      value += this.source[this.index++];
      if (/[+-]/.test(this.source[this.index] ?? "")) value += this.source[this.index++];
      while (/[0-9]/.test(this.source[this.index] ?? "")) value += this.source[this.index++];
    }
    return value;
  }
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;
  private syntax: ProtoSyntax = "proto3";

  constructor(source: string) {
    const lexer = new Lexer(source);
    const tokens: Token[] = [];
    for (let token = lexer.next(); token; token = lexer.next()) tokens.push(token);
    this.tokens = tokens;
  }

  parse(): ParsedProto {
    const result: ParsedProto = {
      syntax: "proto3",
      package: "",
      messages: [],
      enums: [],
      deletedMessages: [],
      deletedEnums: [],
    };

    while (true) {
      const token = this.peek();
      if (!token) break;

      if (token.kind !== "ident") {
        this.next();
        continue;
      }

      switch (token.text) {
        case "syntax": {
          this.next();
          this.expect("=");
          const value = this.expectKind("string");
          this.expect(";");
          result.syntax = value.text === "proto2" ? "proto2" : "proto3";
          this.syntax = result.syntax;
          break;
        }
        case "edition": {
          this.next();
          this.expect("=");
          result.edition = this.expectKind("string").text;
          result.syntax = "editions";
          this.syntax = result.syntax;
          this.expect(";");
          break;
        }
        case "package": {
          this.next();
          result.package = this.parseQualifiedName();
          this.expect(";");
          break;
        }
        case "message":
          result.messages.push(this.parseMessage());
          break;
        case "enum":
          result.enums.push(this.parseEnum());
          break;
        case "service":
        case "extend":
          this.next();
          this.skipToBlockOrSemicolon();
          break;
        case "import": {
          this.next();
          this.skipToSemicolon();
          break;
        }
        case "option": {
          const options = this.parseOptionStatement();
          const enumOpen = enumOpennessFromOptions(options);
          if (enumOpen !== undefined) result.enumOpen = enumOpen;
          break;
        }
        default:
          this.next();
          this.skipToSemicolon();
      }
    }

    return result;
  }

  private parseMessage(): ParsedMessage {
    this.expectIdent("message");
    const name = this.expectKind("ident").text;
    this.expect("{");

    const message: ParsedMessage = {
      name,
      fields: [],
      messages: [],
      enums: [],
      oneofs: [],
      reservedRanges: [],
      reservedNames: [],
      deletedFields: [],
      mapEntry: false,
    };
    this.parseMessageBody(message);
    return message;
  }

  private parseMessageBody(message: ParsedMessage): void {
    while (true) {
      const token = this.peek();
      if (!token) throw this.error("unexpected end of input while parsing message");
      if (token.text === "}") {
        this.next();
        break;
      }
      if (token.kind !== "ident") {
        this.next();
        continue;
      }

      switch (token.text) {
        case "message":
          message.messages.push(this.parseMessage());
          continue;
        case "enum":
          message.enums.push(this.parseEnum());
          continue;
        case "oneof":
          this.parseOneof(message);
          continue;
        case "reserved":
          this.parseReserved(message.reservedRanges, message.reservedNames);
          continue;
        case "extensions":
          this.next();
          this.skipToSemicolon();
          continue;
        case "option": {
          const options = this.parseOptionStatement();
          if (options.map_entry === true || options.mapEntry === true) message.mapEntry = true;
          continue;
        }
        case "extend":
          this.next();
          this.skipToBlockOrSemicolon();
          continue;
        case "deleted":
          this.parseDeleted(message);
          continue;
        default:
          message.fields.push(this.parseField(undefined, message));
      }
    }
  }

  private parseOneof(message: ParsedMessage): void {
    this.expectIdent("oneof");
    const name = this.expectKind("ident").text;
    message.oneofs.push(name);
    this.expect("{");

    while (true) {
      const token = this.peek();
      if (!token) throw this.error("unexpected end of input while parsing oneof");
      if (token.text === "}") {
        this.next();
        break;
      }
      if (token.kind === "ident" && token.text === "option") {
        this.next();
        this.skipToSemicolon();
        continue;
      }
      if (token.kind === "ident" && token.text === "deleted") {
        this.parseDeleted(message);
        continue;
      }
      message.fields.push(this.parseField(name, message));
    }
  }

  private parseField(oneof?: string, parent?: ParsedMessage): ParsedField {
    let label: ParsedField["label"] = "optional";
    let explicitOptional = false;
    let token = this.peek();
    if (
      token?.kind === "ident" &&
      (token.text === "optional" || token.text === "required" || token.text === "repeated")
    ) {
      label = token.text as ParsedField["label"];
      explicitOptional = token.text === "optional";
      this.next();
    }

    let mapKey: string | undefined;
    let mapValue: string | undefined;
    let type: string;

    if (this.peek()?.kind === "ident" && this.peek()?.text === "map" && this.peekAfter().text === "<") {
      this.next();
      this.expect("<");
      mapKey = this.parseQualifiedName();
      this.expect(",");
      mapValue = this.parseQualifiedName();
      this.expect(">");
      type = `map<${mapKey}, ${mapValue}>`;
      label = "repeated";
    } else if (this.peek()?.kind === "ident" && this.peek()?.text === "group") {
      this.next();
      const groupName = this.expectKind("ident").text;
      type = groupName;
      const fieldName = groupName.length > 0 ? groupName[0].toLowerCase() + groupName.slice(1) : groupName;
      this.expect("=");
      const number = this.parseFieldNumber();
      const options = this.peek()?.text === "[" ? this.parseFieldOptions() : {};
      this.expect("{");
      const groupMessage: ParsedMessage = {
        name: groupName,
        fields: [],
        messages: [],
        enums: [],
        oneofs: [],
        reservedRanges: [],
        reservedNames: [],
        deletedFields: [],
        mapEntry: false,
      };
      this.parseMessageBody(groupMessage);
      if (parent) parent.messages.push(groupMessage);
      const field: ParsedField = {
        name: fieldName,
        number,
        type,
        label,
        proto3Optional: explicitOptional && this.syntax === "proto3",
        options,
        group: true,
      };
      if (oneof) field.oneof = oneof;
      if (typeof options.packed === "boolean") field.packed = options.packed;
      if (typeof options.json_name === "string") field.jsonName = options.json_name;
      if (typeof options.default === "string") field.defaultValue = options.default;
      if (typeof options.deprecated === "boolean") field.deprecated = options.deprecated;
      return field;
    } else {
      type = this.parseQualifiedName();
    }

    const name = this.expectKind("ident").text;
    this.expect("=");
    const number = this.parseFieldNumber();
    const options = this.peek()?.text === "[" ? this.parseFieldOptions() : {};

    if (this.peek()?.kind === "ident" && this.peek()?.text === "deleted") {
      this.next();
    }
    this.expect(";");

    const field: ParsedField = {
      name,
      number,
      type,
      label,
      proto3Optional: explicitOptional && this.syntax === "proto3",
      options,
    };
    if (oneof) field.oneof = oneof;
    if (mapKey && mapValue) {
      field.mapKey = mapKey;
      field.mapValue = mapValue;
    }
    if (typeof options.packed === "boolean") field.packed = options.packed;
    if (typeof options.json_name === "string") field.jsonName = options.json_name;
    if (typeof options.default === "string") field.defaultValue = options.default;
    if (typeof options.deprecated === "boolean") field.deprecated = options.deprecated;
    return field;
  }

  private parseEnum(): ParsedEnum {
    this.expectIdent("enum");
    const name = this.expectKind("ident").text;
    this.expect("{");

    const result: ParsedEnum = {
      name,
      values: [],
      reservedRanges: [],
      reservedNames: [],
      deletedValues: [],
      allowAlias: false,
    };

    while (true) {
      const token = this.peek();
      if (!token) throw this.error("unexpected end of input while parsing enum");
      if (token.text === "}") {
        this.next();
        break;
      }
      if (token.kind !== "ident") {
        this.next();
        continue;
      }
      if (token.text === "option") {
        const options = this.parseOptionStatement();
        for (const [key, value] of Object.entries(options)) {
          if (key === "allow_alias" || key === "allowAlias") {
            if (value === true) result.allowAlias = true;
          }
        }
        const enumOpen = enumOpennessFromOptions(options);
        if (enumOpen !== undefined) result.open = enumOpen;
        continue;
      }
      if (token.text === "reserved") {
        this.parseReserved(result.reservedRanges, result.reservedNames);
        continue;
      }
      if (token.text === "deleted") {
        this.parseDeletedEnum(result);
        continue;
      }

      const valueName = this.expectKind("ident").text;
      this.expect("=");
      const number = this.parseSignedInteger();
      const options = this.peek()?.text === "[" ? this.parseFieldOptions() : {};
      this.expect(";");
      result.values.push({
        name: valueName,
        number,
        deprecated: typeof options.deprecated === "boolean" ? options.deprecated : undefined,
      });
    }

    return result;
  }

  private parseOptionStatement(): Record<string, unknown> {
    this.expectIdent("option");
    const keyParts: string[] = [];
    let depth = 0;
    while (true) {
      const token = this.peek();
      if (!token || (token.text === "=" && depth === 0)) break;
      token.text === "(" ? depth++ : token.text === ")" ? depth-- : undefined;
      keyParts.push(this.next()!.text);
    }
    this.expect("=");
    const valueTokens: Token[] = [];
    while (true) {
      const token = this.peek();
      if (!token || token.text === ";") break;
      valueTokens.push(this.next()!);
    }
    this.expect(";");
    return { [normalizeOptionKey(keyParts.join(""))]: tokenValue(valueTokens) };
  }

  private parseFieldOptions(): Record<string, unknown> {
    this.expect("[");
    const options: Record<string, unknown> = {};
    let depth = 0;
    while (true) {
      const token = this.peek();
      if (!token) throw this.error("unexpected end of input while parsing field options");
      if (token.text === "]" && depth === 0) {
        this.next();
        break;
      }
      if (token.text === "[" || token.text === "(" || token.text === "{") depth++;
      if (token.text === "]" || token.text === ")" || token.text === "}") depth--;
      if (token.text === "," && depth === 0) {
        this.next();
        continue;
      }

      const keyTokens: string[] = [];
      while (true) {
        const current = this.peek();
        if (!current || current.text === "=" || current.text === "," || current.text === "]") break;
        current.text === "[" || current.text === "(" ? depth++ : undefined;
        current.text === "]" || current.text === ")" ? depth-- : undefined;
        keyTokens.push(this.next()!.text);
      }
      if (!this.peek() || this.peek()?.text !== "=") {
        this.skipToBracketEnd();
        break;
      }
      this.expect("=");
      const valueTokens: Token[] = [];
      const startDepth = depth;
      while (true) {
        const current = this.peek();
        if (!current) break;
        if (current.text === "," && depth === startDepth) break;
        if (current.text === "]" && depth === startDepth) break;
        if (current.text === "[" || current.text === "(" || current.text === "{") depth++;
        if (current.text === "]" || current.text === ")" || current.text === "}") depth--;
        valueTokens.push(this.next()!);
      }
      options[normalizeOptionKey(keyTokens.join(""))] = tokenValue(valueTokens);
    }
    return options;
  }

  private parseReserved(ranges: ReservedRange[], names: string[]): void {
    this.expectIdent("reserved");
    while (true) {
      const token = this.peek();
      if (!token || token.text === ";") {
        this.expect(";");
        break;
      }
      if (token.kind === "string") {
        names.push(this.next()!.text);
      } else if (token.kind === "number" || token.text === "-") {
        const start = this.parseSignedInteger();
        if (this.peek()?.kind === "ident" && this.peek()?.text === "to") {
          this.next();
          let end: number;
          if (this.peek()?.kind === "ident" && this.peek()?.text === "max") {
            this.next();
            end = 536_870_911;
          } else {
            end = this.parseSignedInteger();
          }
          ranges.push({ start: Math.min(start, end), end: Math.max(start, end) });
        } else {
          ranges.push({ start, end: start });
        }
      } else {
        this.next();
      }
      if (this.peek()?.text === ",") this.next();
    }
  }

  private parseDeleted(message: ParsedMessage): void {
    this.expectIdent("deleted");
    while (true) {
      const token = this.peek();
      if (!token || token.text === ";") {
        this.expect(";");
        break;
      }
      if (token.kind === "number") {
        message.deletedFields.push(this.parseFieldNumber());
      } else if (token.kind === "string" || token.kind === "ident") {
        message.deletedFields.push(this.next()!.text);
      } else {
        this.next();
      }
      if (this.peek()?.text === ",") this.next();
    }
  }

  private parseDeletedEnum(enumDef: ParsedEnum): void {
    this.expectIdent("deleted");
    while (true) {
      const token = this.peek();
      if (!token || token.text === ";") {
        this.expect(";");
        break;
      }
      if (token.kind === "number") {
        enumDef.deletedValues.push(this.parseSignedInteger());
      } else if (token.kind === "string" || token.kind === "ident") {
        enumDef.deletedValues.push(this.next()!.text);
      } else {
        this.next();
      }
      if (this.peek()?.text === ",") this.next();
    }
  }

  private parseQualifiedName(): string {
    let name = "";
    let token = this.peek();
    if (token?.text === ".") {
      name = ".";
      this.next();
      token = this.peek();
    }
    if (!token || token.kind !== "ident") throw this.error("expected type name");
    name += this.next()!.text;
    while (true) {
      token = this.peek();
      if (!token || token.text !== ".") break;
      const after = this.peekAfter();
      if (after.kind !== "ident") break;
      this.next();
      name += "." + this.next()!.text;
    }
    return name;
  }

  private parseFieldNumber(): number {
    const token = this.peek();
    if (!token) throw this.error("expected field number");
    if (token.text === "-") throw this.error("field numbers cannot be negative");
    if (token.kind !== "number") throw this.error("expected field number");
    this.next();
    return Number.parseInt(token.text, token.text.toLowerCase().startsWith("0x") ? 16 : 10);
  }

  private parseSignedInteger(): number {
    let sign = 1;
    if (this.peek()?.text === "-") {
      sign = -1;
      this.next();
    } else if (this.peek()?.text === "+") {
      this.next();
    }
    const token = this.peek();
    if (!token || token.kind !== "number") throw this.error("expected integer");
    this.next();
    return sign * Number.parseInt(token.text, token.text.toLowerCase().startsWith("0x") ? 16 : 10);
  }

  private skipToSemicolon(): void {
    while (true) {
      const token = this.next();
      if (!token || token.text === ";") return;
    }
  }

  private skipToBlockOrSemicolon(): void {
    while (true) {
      const token = this.next();
      if (!token) return;
      if (token.text === ";") return;
      if (token.text === "{") {
        this.skipBalanced("{", "}");
        return;
      }
    }
  }

  private skipBalanced(open: string, close: string): void {
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (!token) return;
      if (token.text === open) depth++;
      if (token.text === close) depth--;
    }
  }

  private skipToBracketEnd(): void {
    let depth = 0;
    while (true) {
      const token = this.next();
      if (!token) return;
      if (token.text === "[") depth++;
      if (token.text === "]") {
        if (depth === 0) return;
        depth--;
      }
    }
  }

  private peek(offset = 0): Token | null {
    return this.tokens[this.index + offset] ?? null;
  }

  private peekAfter(): Token {
    const after = this.peek(1);
    return after ?? { kind: "punct", text: "", line: 0 };
  }

  private next(): Token | null {
    return this.tokens[this.index++] ?? null;
  }

  private expect(text: string): Token {
    const token = this.next();
    if (!token || token.text !== text) throw this.error(`expected '${text}'`);
    return token;
  }

  private expectIdent(text: string): Token {
    const token = this.next();
    if (!token || token.kind !== "ident" || token.text !== text) {
      throw this.error(`expected '${text}'`);
    }
    return token;
  }

  private expectKind(kind: Token["kind"]): Token {
    const token = this.next();
    if (!token || token.kind !== kind) throw this.error(`expected ${kind}`);
    return token;
  }

  private error(message: string): Error {
    const token = this.peek();
    return new Error(`protobuf parse error at line ${token?.line ?? 0}: ${message}`);
  }
}

function normalizeOptionKey(key: string): string {
  return key
    .replace(/[()]/g, "")
    .replace(/^\./, "")
    .replace(/\./g, "_");
}

function enumOpennessFromOptions(options: Record<string, unknown>): boolean | undefined {
  let open: boolean | undefined;
  for (const [key, value] of Object.entries(options)) {
    if (key === "open" && typeof value === "boolean") open = value;
    if (key === "closed" && typeof value === "boolean") open = !value;
    if (key.includes("enum_type") || key.includes("enumType")) {
      if (value === "OPEN" || value === "open" || value === 1) open = true;
      if (value === "CLOSED" || value === "closed" || value === 2) open = false;
    }
  }
  return open;
}

function tokenValue(tokens: Token[]): unknown {
  if (tokens.length === 0) return true;
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.kind === "string") return token.text;
    if (token.kind === "number") {
      return Number(token.text.startsWith("0x") ? Number.parseInt(token.text, 16) : Number(token.text));
    }
    if (token.text === "true") return true;
    if (token.text === "false") return false;
    return token.text;
  }
  return tokens.map((token) => token.text).join("");
}

export function parseProto(source: string): ParsedProto {
  return new Parser(source).parse();
}

export function looksLikeProtoSource(value: unknown): boolean {
  return typeof value === "string" && /(?:^|\n)\s*(?:syntax|edition|package|message|enum|import|option)\b/.test(value);
}
