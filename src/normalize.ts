import {
  parseProto,
  type ParsedEnum,
  type ParsedField,
  type ParsedMessage,
  type ParsedProto,
} from "./proto-parser.ts";
import type {
  EnumDefinition,
  MessageDefinition,
  NormalizedEnum,
  NormalizedEnumValue,
  NormalizedField,
  NormalizedMap,
  NormalizedMessage,
  ProtoSchema,
  ProtoSyntax,
  ReservedRange,
  ScalarType,
  SchemaHistory,
  SchemaInput,
} from "./types.ts";
import { PROTOBUF_MAX_FIELD_NUMBER } from "./types.ts";
import {
  defaultJsonName,
  isPackable,
  isScalarType,
  normalizeLabel,
  wireTypeOfScalar,
} from "./wire.ts";

type AnyRecord = Record<string, any>;

const DESCRIPTOR_TYPES: Record<number, string> = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  10: "group",
  11: "message",
  12: "bytes",
  13: "uint32",
  14: "enum",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

const DESCRIPTOR_TYPE_NAMES: Record<string, string> = {
  TYPE_DOUBLE: "double",
  TYPE_FLOAT: "float",
  TYPE_INT64: "int64",
  TYPE_UINT64: "uint64",
  TYPE_INT32: "int32",
  TYPE_FIXED64: "fixed64",
  TYPE_FIXED32: "fixed32",
  TYPE_BOOL: "bool",
  TYPE_STRING: "string",
  TYPE_GROUP: "group",
  TYPE_MESSAGE: "message",
  TYPE_BYTES: "bytes",
  TYPE_UINT32: "uint32",
  TYPE_ENUM: "enum",
  TYPE_SFIXED32: "sfixed32",
  TYPE_SFIXED64: "sfixed64",
  TYPE_SINT32: "sint32",
  TYPE_SINT64: "sint64",
};

interface MessageContext {
  raw: ParsedMessage;
  fullName: string;
  parentFullName: string;
  packageName: string;
  syntax: ProtoSyntax;
  history?: SchemaHistory;
}

interface EnumContext {
  raw: ParsedEnum;
  fullName: string;
  packageName: string;
  syntax: ProtoSyntax;
  defaultOpen?: boolean;
  history?: SchemaHistory;
}

export function normalizeSchema(input: SchemaInput): ProtoSchema {
  if (isNormalizedSchema(input)) return input;
  const parsed = inputToParsedSchemas(input);
  return buildSchema(parsed);
}

export function isNormalizedSchema(value: unknown): value is ProtoSchema {
  if (!isRecord(value)) return false;
  return (
    value.messageMap instanceof Map &&
    value.enumMap instanceof Map &&
    Array.isArray(value.messages) &&
    Array.isArray(value.enums)
  );
}

export function inputToParsedSchemas(input: SchemaInput): ParsedProto[] {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return inputToParsedSchemas(JSON.parse(trimmed));
      } catch {
        // Fall through to the .proto parser. A JSON-looking string may still
        // be a legitimate (if unusual) proto comment/option value.
      }
    }
    return [parseProto(input)];
  }

  if (Array.isArray(input)) {
    if (input.length > 0 && input.every((item) => isDescriptorFile(item))) {
      return input.map((file) => descriptorFileToParsed(file as AnyRecord));
    }
    if (input.every((item) => isRecord(item) && ("messages" in item || "package" in item))) {
      return input.map((item) => irSchemaToParsed(item as AnyRecord));
    }
    if (
      input.length > 0 &&
      input.every(
        (item) =>
          isRecord(item) &&
          ("values" in item || "value" in item) &&
          !("fields" in item || "field" in item),
      )
    ) {
      return [irSchemaToParsed({ messages: [], enums: input })];
    }
    return [irSchemaToParsed({ messages: input })];
  }

  if (!isRecord(input)) {
    throw new TypeError("Schema input must be a .proto string, an object, or an array");
  }

  if (typeof input.proto === "string") return [parseProto(input.proto)];
  if (typeof input.protoSource === "string") return [parseProto(input.protoSource)];
  if (typeof input.protoText === "string") return [parseProto(input.protoText)];

  if (Array.isArray(input.file)) return input.file.map((file) => descriptorFileToParsed(asRecord(file)));
  if (Array.isArray(input.files)) return input.files.map((file) => descriptorFileToParsed(asRecord(file)));

  if (isDescriptorFile(input)) {
    return [descriptorFileToParsed(input)];
  }

  if (Array.isArray(input.messages) || isRecord(input.messages)) return [irSchemaToParsed(input)];
  if (Array.isArray(input.message)) {
    return [irSchemaToParsed({ ...input, messages: input.message })];
  }
  if ((Array.isArray(input.enums) || isRecord(input.enums)) && !input.messages) {
    return [irSchemaToParsed({ ...input, messages: [] })];
  }

  // A shorthand object whose keys are message names is convenient for tests
  // and small data-contract integrations.
  const knownKeys = new Set([
    "syntax",
    "edition",
    "package",
    "messages",
    "message",
    "enums",
    "messageType",
    "enumType",
    "history",
    "previous",
  ]);
  const shorthandMessages: AnyRecord[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (!knownKeys.has(key) && isRecord(value) && ("fields" in value || "field" in value || "name" in value)) {
      shorthandMessages.push({ ...value, name: typeof value.name === "string" ? value.name : key });
    }
  }
  if (shorthandMessages.length > 0) {
    return [irSchemaToParsed({ ...input, messages: shorthandMessages })];
  }

  if ("schema" in input) return inputToParsedSchemas(input.schema as SchemaInput);
  if ("descriptor" in input) return inputToParsedSchemas(input.descriptor as SchemaInput);
  throw new TypeError("Unable to recognise schema input");
}

function descriptorFileToParsed(file: AnyRecord): ParsedProto {
  const syntax: ProtoSyntax =
    file.syntax === "proto2" ? "proto2" : file.edition ? "editions" : file.syntax === "editions" ? "editions" : "proto3";
  const result: ParsedProto = {
    syntax,
    edition: typeof file.edition === "string" ? file.edition : undefined,
    package: typeof file.package === "string" ? file.package : "",
    messages: [],
    enums: [],
    deletedMessages: [],
    deletedEnums: [],
  };
  const fileOptions = asRecord(file.options);
  const fileFeatures = asRecord(fileOptions?.features);
  const fileEnumType = fileFeatures?.enumType ?? fileOptions?.enumType;
  if (fileEnumType === "OPEN" || fileEnumType === 1) result.enumOpen = true;
  if (fileEnumType === "CLOSED" || fileEnumType === 2) result.enumOpen = false;
  const histories = file.history as SchemaHistory | undefined;
  if (histories) result.history = histories;
  for (const message of arrayOf(file.messageType)) {
    result.messages.push(descriptorMessageToParsed(asRecord(message)));
  }
  for (const enumDef of arrayOf(file.enumType)) {
    result.enums.push(descriptorEnumToParsed(asRecord(enumDef)));
  }
  return result;
}

function descriptorMessageToParsed(message: AnyRecord): ParsedMessage {
  const result: ParsedMessage = {
    name: String(message.name ?? ""),
    fields: [],
    messages: [],
    enums: [],
    oneofs: [],
    reservedRanges: [],
    reservedNames: [],
    deletedFields: [],
    mapEntry: Boolean(asRecord(message.options)?.mapEntry ?? message.mapEntry ?? false),
  };

  const oneofNames = arrayOf(message.oneofDecl).map((item) => String(asRecord(item).name ?? ""));
  result.oneofs.push(...oneofNames.filter(Boolean));

  for (const rawField of arrayOf(message.field)) {
    const field = asRecord(rawField);
    const descriptorType =
      typeof field.type === "number"
        ? DESCRIPTOR_TYPES[field.type] ?? "message"
        : DESCRIPTOR_TYPE_NAMES[String(field.type ?? "")] ?? String(field.type ?? "");
    const typeName = typeof field.typeName === "string" ? field.typeName : undefined;
    const proto3Optional = Boolean(field.proto3Optional);
    const oneofIndex = typeof field.oneofIndex === "number" ? field.oneofIndex : undefined;
    const oneof =
      !proto3Optional && oneofIndex !== undefined && oneofNames[oneofIndex] ? oneofNames[oneofIndex] : undefined;
    const options = asRecord(field.options);
    const jsonName = typeof field.jsonName === "string" ? field.jsonName : undefined;
    const label =
      field.label === 3 || field.label === "LABEL_REPEATED"
        ? "repeated"
        : field.label === 2 || field.label === "LABEL_REQUIRED"
          ? "required"
          : "optional";

    result.fields.push({
      name: String(field.name ?? ""),
      number: Number(field.number ?? 0),
      type: descriptorType === "message" || descriptorType === "enum" || descriptorType === "group" ? typeName ?? descriptorType : descriptorType,
      label,
      oneof,
      proto3Optional,
      packed: typeof options?.packed === "boolean" ? options.packed : undefined,
      jsonName,
      deprecated: typeof options?.deprecated === "boolean" ? options.deprecated : undefined,
      options: options ?? {},
      group: descriptorType === "group",
    });
  }

  for (const range of arrayOf(message.reservedRange)) {
    const item = asRecord(range);
    const start = Number(item.start ?? 0);
    const endExclusive = Number(item.end ?? start + 1);
    result.reservedRanges.push({ start, end: Math.max(start, endExclusive - 1) });
  }
  result.reservedNames.push(...arrayOf(message.reservedName).map((name) => String(name)));

  for (const nested of arrayOf(message.nestedType)) {
    result.messages.push(descriptorMessageToParsed(asRecord(nested)));
  }
  for (const enumDef of arrayOf(message.enumType)) {
    result.enums.push(descriptorEnumToParsed(asRecord(enumDef)));
  }

  return result;
}

function descriptorEnumToParsed(enumDef: AnyRecord): ParsedEnum {
  const options = asRecord(enumDef.options);
  const features = asRecord(options?.features);
  const enumType = features?.enumType ?? options?.enumType ?? enumDef.enumType;
  let open: boolean | undefined;
  if (enumType === "OPEN" || enumType === 1) open = true;
  if (enumType === "CLOSED" || enumType === 2) open = false;
  if (typeof enumDef.open === "boolean") open = enumDef.open;

  const result: ParsedEnum = {
    name: String(enumDef.name ?? ""),
    values: [],
    reservedRanges: [],
    reservedNames: [],
    deletedValues: [],
    allowAlias: Boolean(options?.allowAlias ?? false),
    open,
  };

  for (const value of arrayOf(enumDef.value)) {
    const item = asRecord(value);
    result.values.push({
      name: String(item.name ?? ""),
      number: Number(item.number ?? 0),
      deprecated: Boolean(asRecord(item.options)?.deprecated ?? false),
    });
  }
  for (const range of arrayOf(enumDef.reservedRange)) {
    const item = asRecord(range);
    const start = Number(item.start ?? 0);
    const endExclusive = Number(item.end ?? start + 1);
    result.reservedRanges.push({ start, end: Math.max(start, endExclusive - 1) });
  }
  result.reservedNames.push(...arrayOf(enumDef.reservedName).map((name) => String(name)));
  if (Array.isArray(enumDef.deletedValues)) {
    result.deletedValues.push(...enumDef.deletedValues);
  }
  return result;
}

function irSchemaToParsed(schema: AnyRecord): ParsedProto {
  const syntax = normalizeSyntax(schema.syntax ?? schema.edition);
  const result: ParsedProto = {
    syntax,
    edition: typeof schema.edition === "string" ? schema.edition : undefined,
    package: typeof schema.package === "string" ? schema.package : "",
    messages: [],
    enums: [],
    deletedMessages: arrayOf(schema.deletedMessages).map(String),
    deletedEnums: arrayOf(schema.deletedEnums).map(String),
  };
  if (isRecord(schema.history)) result.history = schema.history as SchemaHistory;
  if (typeof schema.enumOpen === "boolean") result.enumOpen = schema.enumOpen;
  result.messages = definitionEntries(schema.messages).map((item) => irMessageToParsed(asRecord(item)));
  result.enums = definitionEntries(schema.enums).map((item) => irEnumToParsed(asRecord(item)));
  return result;
}

function irMessageToParsed(message: MessageDefinition | AnyRecord): ParsedMessage {
  const raw = message as AnyRecord;
  const result: ParsedMessage = {
    name: String(raw.name ?? ""),
    fields: [],
    messages: [],
    enums: [],
    oneofs: [],
    reservedRanges: [],
    reservedNames: [],
    deletedFields: [],
    mapEntry: Boolean(raw.mapEntry ?? raw.map_entry ?? raw.options?.mapEntry ?? false),
  };

  for (const oneof of arrayOf(raw.oneofs)) {
    if (typeof oneof === "string") {
      result.oneofs.push(oneof);
    } else if (isRecord(oneof)) {
      const name = String(oneof.name ?? "");
      if (name) result.oneofs.push(name);
      for (const field of arrayOf(oneof.fields)) {
        if (typeof field === "string") {
          result.fields.push({
            name: field,
            number: 0,
            type: "bytes",
            label: "optional",
            oneof: name,
            proto3Optional: false,
            options: {},
          });
        } else {
          const parsed = irFieldToParsed(asRecord(field), undefined);
          parsed.oneof = name;
          result.fields.push(parsed);
        }
      }
    }
  }

  const fields = raw.fields ?? raw.field;
  if (Array.isArray(fields)) {
    for (const field of fields) result.fields.push(irFieldToParsed(asRecord(field)));
  } else if (isRecord(fields)) {
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === "number") {
        result.fields.push({
          name: key,
          number: value,
          type: "bytes",
          label: "optional",
          proto3Optional: false,
          options: {},
        });
      } else if (typeof value === "string") {
        const numericKey = /^\d+$/.test(key) ? Number(key) : undefined;
        result.fields.push({
          name: numericKey === undefined ? key : key,
          number: numericKey ?? result.fields.length + 1,
          type: value,
          label: "optional",
          proto3Optional: false,
          options: {},
        });
      } else if (isRecord(value)) {
        result.fields.push(irFieldToParsed(value, key));
      }
    }
  }

  for (const nested of definitionEntries(raw.nested ?? raw.nestedMessages ?? raw.messages)) {
    result.messages.push(irMessageToParsed(asRecord(nested)));
  }
  for (const enumDef of definitionEntries(raw.enums)) {
    result.enums.push(irEnumToParsed(asRecord(enumDef)));
  }

  const reserved = collectReserved(raw);
  result.reservedRanges.push(...reserved.ranges);
  result.reservedNames.push(...reserved.names);

  for (const deleted of arrayOf(raw.deletedFields ?? raw.removedFields)) {
    if (typeof deleted === "number") result.deletedFields.push(deleted);
    else if (typeof deleted === "string") result.deletedFields.push(deleted);
    else if (isRecord(deleted)) {
      if (typeof deleted.number === "number") result.deletedFields.push(deleted.number);
      if (typeof deleted.name === "string") result.deletedFields.push(deleted.name);
    }
  }

  return result;
}

function irFieldToParsed(field: AnyRecord, fallbackName?: string): ParsedField {
  let number = Number(field.number ?? field.id ?? field.tag ?? field.fieldNumber ?? 0);
  let name = String(field.name ?? fallbackName ?? "");
  if ((!number || !name) && fallbackName && /^\d+$/.test(fallbackName)) {
    number = number || Number(fallbackName);
    name = String(field.name ?? "");
  }

  let type = field.type ?? field.declaredType ?? field.typeName;
  if (type === undefined && typeof field.wireType === "number") {
    type =
      field.wireType === 0
        ? "int32"
        : field.wireType === 1
          ? "fixed64"
          : field.wireType === 5
            ? "fixed32"
            : field.wireType === 3
              ? "group"
              : "bytes";
  }
  if (type === undefined) type = "bytes";
  if (
    typeof field.typeName === "string" &&
    (field.type === 10 ||
      field.type === 11 ||
      field.type === 14 ||
      field.type === "message" ||
      field.type === "enum" ||
      field.type === "group" ||
      field.type === "TYPE_MESSAGE" ||
      field.type === "TYPE_ENUM" ||
      field.type === "TYPE_GROUP")
  ) {
    type = field.typeName;
  }
  if (typeof type === "number") type = DESCRIPTOR_TYPES[type] ?? String(type);
  if (typeof type === "string") {
    const descriptorType = DESCRIPTOR_TYPE_NAMES[type];
    if (descriptorType) type = descriptorType;
  }
  let mapKey: string | undefined;
  let mapValue: string | undefined;
  if (isRecord(field.map)) {
    mapKey = String(field.map.keyType ?? field.map.key ?? "string");
    mapValue = String(field.map.valueType ?? field.map.value ?? "bytes");
    type = `map<${mapKey}, ${mapValue}>`;
  } else if (field.map === true || field.mapKey || field.mapValue) {
    mapKey = String(field.mapKey ?? "string");
    mapValue = String(field.mapValue ?? "bytes");
    type = `map<${mapKey}, ${mapValue}>`;
  } else if (typeof type === "string" && type.startsWith("map")) {
    const parsedMap = parseMapType(type);
    if (parsedMap) {
      mapKey = parsedMap.key;
      mapValue = parsedMap.value;
    }
  }

  if (mapKey && mapValue && !String(type).startsWith("map")) type = `map<${mapKey}, ${mapValue}>`;

  const label = normalizeLabel(field.label, Boolean(field.repeated), Boolean(field.required));
  const options = isRecord(field.options) ? field.options : {};
  return {
    name,
    number,
    type: String(type),
    label: mapKey ? "repeated" : label,
    oneof: typeof field.oneof === "string" ? field.oneof : typeof field.oneofName === "string" ? field.oneofName : undefined,
    mapKey,
    mapValue,
    proto3Optional: Boolean(field.proto3Optional ?? field.proto3_optional ?? false),
    packed: typeof field.packed === "boolean" ? field.packed : typeof options.packed === "boolean" ? options.packed : undefined,
    jsonName: typeof field.jsonName === "string" ? field.jsonName : typeof field.json_name === "string" ? field.json_name : undefined,
    defaultValue: field.defaultValue ?? field.default,
    deprecated: typeof field.deprecated === "boolean" ? field.deprecated : undefined,
    options,
    deleted: Boolean(field.deleted ?? field.removed ?? false),
    group:
      field.type === 10 ||
      field.type === "group" ||
      field.type === "TYPE_GROUP",
  };
}

function irEnumToParsed(enumDef: EnumDefinition | AnyRecord): ParsedEnum {
  const raw = enumDef as AnyRecord;
  const options = isRecord(raw.options) ? raw.options : {};
  let open: boolean | undefined;
  if (typeof raw.open === "boolean") open = raw.open;
  if (typeof raw.isOpen === "boolean") open = raw.isOpen;
  if (typeof raw.closed === "boolean") open = !raw.closed;
  if (raw.enumType === "OPEN" || raw.enumType === "open") open = true;
  if (raw.enumType === "CLOSED" || raw.enumType === "closed") open = false;
  if (raw.enumType === 1) open = true;
  if (raw.enumType === 2) open = false;

  const result: ParsedEnum = {
    name: String(raw.name ?? ""),
    values: [],
    reservedRanges: [],
    reservedNames: [],
    deletedValues: [],
    allowAlias: Boolean(raw.allowAlias ?? options.allow_alias ?? false),
    open,
  };

  const values = raw.values ?? raw.value;
  if (Array.isArray(values)) {
    for (const value of values) {
      const item = asRecord(value);
      result.values.push({
        name: String(item.name ?? ""),
        number: Number(item.number ?? item.id ?? item.value ?? 0),
        deprecated: Boolean(item.deprecated),
      });
    }
  } else if (isRecord(values)) {
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === "number") {
        result.values.push({ name, number: value });
      } else if (isRecord(value)) {
        result.values.push({
          name: String(value.name ?? name),
          number: Number(value.number ?? value.id ?? value.value ?? 0),
          deprecated: Boolean(value.deprecated),
        });
      }
    }
  }

  const reserved = collectReserved(raw);
  result.reservedRanges.push(...reserved.ranges);
  result.reservedNames.push(...reserved.names);

  for (const deleted of arrayOf(raw.deletedValues ?? raw.removedValues)) {
    if (typeof deleted === "number" || typeof deleted === "string") result.deletedValues.push(deleted);
    else if (isRecord(deleted)) {
      if (typeof deleted.number === "number") result.deletedValues.push(deleted.number);
      if (typeof deleted.name === "string") result.deletedValues.push(deleted.name);
    }
  }
  return result;
}

function buildSchema(parsedSchemas: ParsedProto[]): ProtoSchema {
  const messageContexts: MessageContext[] = [];
  const enumContexts: EnumContext[] = [];
  const deletedMessages = new Set<string>();
  const deletedEnums = new Set<string>();
  const schema: ProtoSchema = {
    syntax: parsedSchemas[0]?.syntax ?? "proto3",
    edition: parsedSchemas.find((item) => item.edition)?.edition,
    package: parsedSchemas[0]?.package ?? "",
    messages: [],
    messageMap: new Map(),
    enums: [],
    enumMap: new Map(),
    deletedMessages,
    deletedEnums,
  };

  for (const parsed of parsedSchemas) {
    const packageName = parsed.package.replace(/^\.+|\.+$/g, "");
    for (const deleted of parsed.deletedMessages) deletedMessages.add(deleted);
    for (const deleted of parsed.deletedEnums) deletedEnums.add(deleted);
    for (const message of parsed.messages) {
      visitMessage(message, "", packageName, parsed.syntax, parsed.enumOpen, parsed.history);
    }
    for (const enumDef of parsed.enums) {
      enumContexts.push({
        raw: enumDef,
        fullName: joinName(packageName, enumDef.name),
        packageName,
        syntax: parsed.syntax,
        defaultOpen: parsed.enumOpen,
        history: parsed.history,
      });
    }
  }

  function visitMessage(
    raw: ParsedMessage,
    parentFullName: string,
    packageName: string,
    syntax: ProtoSyntax,
    defaultOpen?: boolean,
    history?: SchemaHistory,
  ): void {
    const fullName = joinName(parentFullName || packageName, raw.name);
    messageContexts.push({ raw, fullName, parentFullName, packageName, syntax, history });
    for (const nested of raw.messages) {
      visitMessage(nested, fullName, packageName, syntax, defaultOpen, history);
    }
    for (const enumDef of raw.enums) {
      enumContexts.push({
        raw: enumDef,
        fullName: joinName(fullName, enumDef.name),
        packageName,
        syntax,
        defaultOpen,
        history,
      });
    }
  }

  for (const context of enumContexts) {
    const normalized = normalizeEnum(context);
    schema.enums.push(normalized);
    schema.enumMap.set(normalized.fullName, normalized);
  }

  for (const context of messageContexts) {
    const normalized = normalizeMessageShell(context);
    schema.messages.push(normalized);
    schema.messageMap.set(normalized.fullName, normalized);
  }

  for (const context of messageContexts) {
    const normalized = schema.messageMap.get(context.fullName);
    if (!normalized) continue;
    for (const rawField of context.raw.fields) {
      if (rawField.deleted) {
        normalized.deletedNumbers.add(rawField.number);
        normalized.deletedNames.add(rawField.name);
        continue;
      }
      const field = normalizeField(rawField, context, schema);
      if (!field) continue;
      if (!normalized.fieldsByNumber.has(field.number)) {
        normalized.fields.push(field);
        normalized.fieldsByNumber.set(field.number, field);
        if (field.oneof) {
          const members = normalized.oneofs.get(field.oneof) ?? [];
          members.push(field.name);
          normalized.oneofs.set(field.oneof, members);
        }
      }
    }
  }

  // Descriptor-style map fields point at a synthetic nested message. Resolve
  // those references after every entry message has been normalized.
  for (const message of schema.messages) {
    for (const field of message.fields) {
      if (field.typeKind !== "message" || !field.typeName) continue;
      const entry = schema.messageMap.get(field.typeName);
      if (!entry?.mapEntry) continue;
      const key = entry.fieldsByNumber.get(1);
      const value = entry.fieldsByNumber.get(2);
      if (!key || !value) continue;
      const keyScalar = key.scalar ?? "string";
      field.typeKind = "map";
      field.label = "repeated";
      field.wireType = 2;
      field.packable = false;
      field.scalar = undefined;
      field.declaredType = `map<${keyScalar}, ${value.declaredType}>`;
      field.map = {
        keyType: keyScalar,
        keyWireType: wireTypeOfScalar(keyScalar),
        valueType: value.declaredType,
        valueKind:
          value.typeKind === "map"
            ? "unknown"
            : value.typeKind === "group"
              ? "message"
              : value.typeKind,
        valueWireType: value.wireType,
        valueTypeName: value.typeName,
      };
    }
  }

  for (const message of schema.messages) {
    for (const [name, members] of message.oneofs) {
      if (members.length === 0) message.oneofs.delete(name);
    }
  }

  return schema;
}

function normalizeMessageShell(context: MessageContext): NormalizedMessage {
  const reserved = normalizeReserved(context.raw.reservedRanges, context.raw.reservedNames);
  const deletedNumbers = new Set<number>();
  const deletedNames = new Set<string>();
  for (const deleted of context.raw.deletedFields) {
    if (typeof deleted === "number") deletedNumbers.add(deleted);
    else {
      deletedNames.add(deleted);
      const field = context.raw.fields.find((item) => item.name === deleted);
      if (field) deletedNumbers.add(field.number);
    }
  }
  applyHistoryToMessage(context, deletedNumbers, deletedNames);

  return {
    name: context.raw.name,
    fullName: context.fullName,
    fields: [],
    fieldsByNumber: new Map(),
    oneofs: new Map(context.raw.oneofs.map((name) => [name, []])),
    reservedRanges: reserved.ranges,
    reservedNames: reserved.names,
    deletedNumbers,
    deletedNames,
    mapEntry: context.raw.mapEntry,
  };
}

function normalizeEnum(context: EnumContext): NormalizedEnum {
  const values: NormalizedEnumValue[] = [];
  const valuesByNumber = new Map<number, NormalizedEnumValue[]>();
  const valuesByName = new Map<string, NormalizedEnumValue>();
  const deletedNumbers = new Set<number>();
  const deletedNames = new Set<string>();

  for (const rawValue of context.raw.values) {
    const value: NormalizedEnumValue = {
      name: rawValue.name,
      number: rawValue.number,
      deprecated: Boolean(rawValue.deprecated),
    };
    values.push(value);
    const existing = valuesByNumber.get(value.number) ?? [];
    existing.push(value);
    valuesByNumber.set(value.number, existing);
    valuesByName.set(value.name, value);
  }

  for (const deleted of context.raw.deletedValues) {
    if (typeof deleted === "number") deletedNumbers.add(deleted);
    else {
      deletedNames.add(deleted);
      const value = valuesByName.get(deleted);
      if (value) deletedNumbers.add(value.number);
    }
  }

  applyHistoryToEnum(context, deletedNumbers, deletedNames);
  const reserved = normalizeReserved(context.raw.reservedRanges, context.raw.reservedNames);
  const open =
    context.raw.open !== undefined
      ? context.raw.open
      : context.defaultOpen !== undefined
        ? context.defaultOpen
        : context.syntax === "proto2"
          ? false
          : true;

  return {
    name: context.raw.name,
    fullName: context.fullName,
    open,
    values,
    valuesByNumber,
    valuesByName,
    reservedRanges: reserved.ranges,
    reservedNames: reserved.names,
    deletedNumbers,
    deletedNames,
    allowAlias: context.raw.allowAlias,
  };
}

function normalizeField(rawField: ParsedField, context: MessageContext, schema: ProtoSchema): NormalizedField | null {
  if (!Number.isFinite(rawField.number) || rawField.number <= 0 || rawField.number > PROTOBUF_MAX_FIELD_NUMBER) {
    const name = rawField.name || "<unnamed>";
    throw new Error(`Invalid field number for ${context.fullName}.${name}: ${rawField.number}`);
  }
  const label = rawField.label;
  const proto3Optional = rawField.proto3Optional;
  const oneof = proto3Optional ? undefined : rawField.oneof;
  const jsonName = rawField.jsonName || defaultJsonName(rawField.name);
  const declaredType = rawField.type.trim();
  const base: NormalizedField = {
    name: rawField.name,
    jsonName,
    number: rawField.number,
    label,
    typeKind: "unknown",
    declaredType: declaredType.replace(/^\./, ""),
    wireType: 2,
    oneof,
    proto3Optional,
    packed: false,
    packable: false,
    defaultValue: rawField.defaultValue,
    deprecated: Boolean(rawField.deprecated),
  };

  let mapKey = rawField.mapKey;
  let mapValue = rawField.mapValue;
  if (!mapKey && declaredType.startsWith("map")) {
    const parsedMap = parseMapType(declaredType);
    if (parsedMap) {
      mapKey = parsedMap.key;
      mapValue = parsedMap.value;
    }
  }
  if (mapKey && mapValue) {
    base.typeKind = "map";
    base.label = "repeated";
    base.wireType = 2;
    base.map = normalizeMap(mapKey, mapValue, context, schema);
    base.declaredType = `map<${mapKey}, ${mapValue}>`;
    return base;
  }

  if (rawField.group) {
    const resolved = resolveType(declaredType, context, schema);
    base.typeKind = "group";
    base.typeName = resolved?.fullName ?? declaredType.replace(/^\./, "");
    base.wireType = 3;
    return base;
  }

  if (isScalarType(declaredType)) {
    base.typeKind = "scalar";
    base.scalar = declaredType;
    base.wireType = wireTypeOfScalar(declaredType);
    base.packable = isPackable("scalar", declaredType);
    base.packed =
      rawField.packed ??
      (label === "repeated" && base.packable && context.syntax !== "proto2");
    if (label === "repeated" && oneof) base.label = "optional";
    return base;
  }

  const resolved = resolveType(declaredType, context, schema);
  if (resolved?.kind === "enum") {
    base.typeKind = "enum";
    base.typeName = resolved.fullName;
    base.wireType = 0;
    base.packable = true;
    base.packed =
      rawField.packed ??
      (label === "repeated" && base.packable && context.syntax !== "proto2");
    return base;
  }
  if (resolved?.kind === "message") {
    base.typeKind = "message";
    base.typeName = resolved.fullName;
    base.wireType = 2;
    return base;
  }

  // Group fields use the deprecated start-group wire type. The parser cannot
  // distinguish every proto2 group spelling, so only an explicit group type
  // is treated as a group here.
  if (declaredType.toLowerCase() === "group") {
    base.typeKind = "group";
    base.wireType = 3;
    return base;
  }

  base.typeKind = "unknown";
  base.typeName = declaredType.replace(/^\./, "");
  base.wireType = 2;
  base.packable = false;
  return base;
}

function normalizeMap(keyType: string, valueType: string, context: MessageContext, schema: ProtoSchema): NormalizedMap {
  const key = isScalarType(keyType) && isMapKeyType(keyType) ? keyType : "string";
  const scalarValue = isScalarType(valueType) ? valueType : undefined;
  if (scalarValue) {
    return {
      keyType: key,
      keyWireType: wireTypeOfScalar(key),
      valueType: scalarValue,
      valueKind: "scalar",
      valueWireType: wireTypeOfScalar(scalarValue),
    };
  }
  const resolved = resolveType(valueType, context, schema);
  if (resolved?.kind === "enum") {
    return {
      keyType: key,
      keyWireType: wireTypeOfScalar(key),
      valueType: resolved.fullName,
      valueKind: "enum",
      valueWireType: 0,
      valueTypeName: resolved.fullName,
    };
  }
  if (resolved?.kind === "message") {
    return {
      keyType: key,
      keyWireType: wireTypeOfScalar(key),
      valueType: resolved.fullName,
      valueKind: "message",
      valueWireType: 2,
      valueTypeName: resolved.fullName,
    };
  }
  return {
    keyType: key,
    keyWireType: wireTypeOfScalar(key),
    valueType: valueType.replace(/^\./, ""),
    valueKind: "unknown",
    valueWireType: 2,
    valueTypeName: valueType.replace(/^\./, ""),
  };
}

function isMapKeyType(type: ScalarType): boolean {
  return type !== "double" && type !== "float" && type !== "bytes";
}

function resolveType(
  name: string,
  context: MessageContext,
  schema: ProtoSchema,
): { kind: "message" | "enum"; fullName: string } | null {
  const clean = name.replace(/^\./, "");
  if (!clean) return null;
  const candidates: string[] = [];
  const scopeParts = context.fullName.split(".").filter(Boolean);

  if (name.startsWith(".")) {
    candidates.push(clean);
  } else {
    for (let length = scopeParts.length; length >= 1; length--) {
      candidates.push(`${scopeParts.slice(0, length).join(".")}.${clean}`);
    }
    const packageParts = context.packageName.split(".").filter(Boolean);
    for (let length = packageParts.length; length >= 1; length--) {
      candidates.push(`${packageParts.slice(0, length).join(".")}.${clean}`);
    }
    candidates.push(clean);
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (schema.messageMap.has(candidate)) return { kind: "message", fullName: candidate };
    if (schema.enumMap.has(candidate)) return { kind: "enum", fullName: candidate };
  }
  return null;
}

function normalizeReserved(ranges: ReservedRange[], names: string[]): { ranges: ReservedRange[]; names: Set<string> } {
  return {
    ranges: mergeRanges(ranges),
    names: new Set(names),
  };
}

function mergeRanges(ranges: ReservedRange[]): ReservedRange[] {
  const sorted = ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end))
    .map((range) => ({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const result: ReservedRange[] = [];
  for (const range of sorted) {
    const previous = result[result.length - 1];
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      result.push({ ...range });
    }
  }
  return result;
}

function applyHistoryToMessage(
  context: MessageContext,
  deletedNumbers: Set<number>,
  deletedNames: Set<string>,
): void {
  const history = context.history;
  if (!history) return;
  const shortName = context.fullName.split(".").pop() ?? context.fullName;
  const entries = [
    history.messages?.[context.fullName],
    history.messages?.[shortName],
    history.deletedFields?.[context.fullName],
    history.deletedFields?.[shortName],
  ];
  for (const entry of entries) {
    if (!entry) continue;
    if (Array.isArray(entry)) {
      for (const value of entry) {
        if (typeof value === "number") deletedNumbers.add(value);
        else if (typeof value === "string") deletedNames.add(value);
      }
    } else if (isRecord(entry)) {
      for (const value of arrayOf(entry.deletedFields ?? entry.deletedNumbers)) {
        if (typeof value === "number") deletedNumbers.add(value);
        else if (typeof value === "string") deletedNames.add(value);
      }
      for (const value of arrayOf(entry.reservedNumbers)) {
        if (typeof value === "number") deletedNumbers.add(value);
      }
      for (const value of arrayOf(entry.reservedNames)) deletedNames.add(String(value));
    }
  }

  for (const name of deletedNames) {
    const field = context.raw.fields.find((item) => item.name === name);
    if (field) deletedNumbers.add(field.number);
  }
}

function applyHistoryToEnum(context: EnumContext, deletedNumbers: Set<number>, deletedNames: Set<string>): void {
  const history = context.history;
  if (!history) return;
  const shortName = context.fullName.split(".").pop() ?? context.fullName;
  const entry =
    (history.enums as AnyRecord | undefined)?.[context.fullName] ??
    (history.enums as AnyRecord | undefined)?.[shortName];
  if (!entry) return;
  for (const value of arrayOf(entry.deletedValues ?? entry.deletedNumbers)) {
    if (typeof value === "number") deletedNumbers.add(value);
    else if (typeof value === "string") deletedNames.add(value);
  }
}

function collectReserved(raw: AnyRecord): { ranges: ReservedRange[]; names: string[] } {
  const ranges: ReservedRange[] = [];
  const names: string[] = [];
  const pushEntry = (entry: unknown): void => {
    if (typeof entry === "string") names.push(entry);
    else if (typeof entry === "number") ranges.push({ start: entry, end: entry });
    else if (Array.isArray(entry) && entry.length >= 2) {
      ranges.push({ start: Number(entry[0]), end: Number(entry[1]) });
    } else if (isRecord(entry)) {
      if (typeof entry.name === "string") names.push(entry.name);
      if (typeof entry.start === "number" || typeof entry.end === "number") {
        const start = Number(entry.start ?? 0);
        const end = Number(entry.end ?? start);
        // Descriptor JSON uses end-exclusive ranges. A plain IR range with
        // equal start/end is treated as one number.
        const inclusiveEnd = entry.endExclusive === true ? end - 1 : end;
        ranges.push({ start, end: inclusiveEnd });
      }
    }
  };

  const reserved = raw.reserved;
  if (Array.isArray(reserved)) reserved.forEach(pushEntry);
  else if (isRecord(reserved)) {
    for (const entry of arrayOf(reserved.numbers ?? reserved.ranges)) pushEntry(entry);
    for (const name of arrayOf(reserved.names)) names.push(String(name));
  }
  for (const entry of arrayOf(raw.reservedNumbers ?? raw.reservedNums)) pushEntry(entry);
  for (const entry of arrayOf(raw.reservedRanges)) pushEntry(entry);
  for (const name of arrayOf(raw.reservedNames)) names.push(String(name));
  return { ranges, names };
}

function parseMapType(type: string): { key: string; value: string } | null {
  const match = /^map\s*<\s*([^,>]+)\s*,\s*([^>]+)\s*>$/.exec(type.trim());
  if (!match) return null;
  return { key: match[1].trim(), value: match[2].trim() };
}

function normalizeSyntax(value: unknown): ProtoSyntax {
  if (value === "proto2") return "proto2";
  if (value === "editions" || (typeof value === "string" && /^\d{4}$/.test(value))) return "editions";
  return "proto3";
}

function joinName(parent: string, name: string): string {
  return parent ? `${parent}.${name}` : name;
}

function asRecord(value: unknown): AnyRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDescriptorFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Array.isArray(value.messageType) || Array.isArray(value.enumType)) return true;
  if ("messages" in value || "enums" in value || "fields" in value || "field" in value) return false;
  return "syntax" in value || "edition" in value;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function definitionEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    return Object.entries(value).map(([name, definition]) => {
      if (isRecord(definition)) return { ...definition, name: definition.name ?? name };
      return { name, ...(typeof definition === "string" ? { type: definition } : {}) };
    });
  }
  return [];
}
