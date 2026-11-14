export type ProtoSyntax = "proto2" | "proto3" | "editions";

export type CompatibilityDirection = "backward" | "forward" | "full" | "bidirectional" | "both";

export type CompatibilityLevel = "full" | "backward" | "forward" | "none";

export type BreakingDirection = "backward" | "forward";

export type FieldLabel = "optional" | "required" | "repeated";

export type ScalarType =
  | "double"
  | "float"
  | "int32"
  | "int64"
  | "uint32"
  | "uint64"
  | "sint32"
  | "sint64"
  | "fixed32"
  | "fixed64"
  | "sfixed32"
  | "sfixed64"
  | "bool"
  | "string"
  | "bytes";

export const PROTOBUF_MAX_FIELD_NUMBER = 536_870_911;

export interface FieldDefinition {
  name: string;
  number?: number;
  id?: number;
  tag?: number;
  type?: string;
  typeName?: string;
  label?: FieldLabel | "optional" | "required" | "repeated";
  repeated?: boolean;
  optional?: boolean;
  required?: boolean;
  oneof?: string;
  oneofName?: string;
  map?: boolean | MapDefinition;
  mapKey?: string;
  mapValue?: string;
  proto3Optional?: boolean;
  proto3_optional?: boolean;
  packed?: boolean;
  jsonName?: string;
  json_name?: string;
  defaultValue?: unknown;
  default?: unknown;
  deprecated?: boolean;
  deleted?: boolean;
  removed?: boolean;
  options?: Record<string, unknown>;
}

export interface MapDefinition {
  keyType?: string;
  valueType?: string;
  key?: string;
  value?: string;
}

export interface ReservedRange {
  start: number;
  end: number;
}

export interface OneofDefinition {
  name: string;
  fields?: Array<string | Partial<FieldDefinition>>;
}

export interface MessageDefinition {
  name: string;
  fields?: FieldDefinition[] | Record<string, Partial<FieldDefinition>>;
  oneofs?: Array<string | OneofDefinition>;
  nested?: MessageDefinition[];
  messages?: MessageDefinition[];
  enums?: EnumDefinition[];
  reserved?: Array<number | string | ReservedRange | [number, number]>;
  reservedNumbers?: number[];
  reservedNums?: number[];
  reservedRanges?: Array<ReservedRange | [number, number]>;
  reservedNames?: string[];
  mapEntry?: boolean;
  map_entry?: boolean;
  deletedFields?: Array<number | string | Partial<FieldDefinition>>;
  removedFields?: Array<number | string | Partial<FieldDefinition>>;
  options?: Record<string, unknown>;
}

export interface EnumValueDefinition {
  name: string;
  number: number;
  id?: number;
  value?: number;
  alias?: boolean;
  deprecated?: boolean;
  deleted?: boolean;
  options?: Record<string, unknown>;
}

export interface EnumDefinition {
  name: string;
  values?: EnumValueDefinition[] | Record<string, number | Partial<EnumValueDefinition>>;
  reserved?: Array<number | string | ReservedRange | [number, number]>;
  reservedNumbers?: number[];
  reservedRanges?: Array<ReservedRange | [number, number]>;
  reservedNames?: string[];
  open?: boolean;
  isOpen?: boolean;
  closed?: boolean;
  enumType?: "OPEN" | "CLOSED" | "open" | "closed";
  deletedValues?: Array<number | string | Partial<EnumValueDefinition>>;
  removedValues?: Array<number | string | Partial<EnumValueDefinition>>;
  options?: Record<string, unknown>;
  valuesRaw?: unknown;
}

export interface SchemaDefinition {
  syntax?: ProtoSyntax | string;
  edition?: string;
  package?: string;
  messages?: MessageDefinition[];
  messageType?: Array<Record<string, unknown>>;
  enums?: EnumDefinition[];
  enumType?: Array<Record<string, unknown>>;
  history?: SchemaHistory;
  previous?: unknown;
}

export interface SchemaHistory {
  messages?: Record<string, MessageHistory>;
  enums?: Record<string, MessageHistory>;
  deletedFields?: Record<string, Array<number | string>>;
  deletedMessages?: string[];
  deletedEnums?: string[];
}

export interface MessageHistory {
  deletedFields?: Array<number | string>;
  deletedValues?: Array<number | string>;
  deletedNumbers?: number[];
  reservedNumbers?: number[];
  reservedNames?: string[];
}

export type SchemaInput = string | SchemaDefinition | MessageDefinition[] | EnumDefinition[] | unknown;

export interface NormalizedField {
  name: string;
  jsonName: string;
  number: number;
  label: FieldLabel;
  typeKind: "scalar" | "message" | "enum" | "map" | "group" | "unknown";
  declaredType: string;
  typeName?: string;
  scalar?: ScalarType;
  wireType: number;
  oneof?: string;
  proto3Optional: boolean;
  packed: boolean;
  packable: boolean;
  map?: NormalizedMap;
  defaultValue?: unknown;
  deprecated: boolean;
}

export interface NormalizedMap {
  keyType: ScalarType;
  keyWireType: number;
  valueType: string;
  valueKind: "scalar" | "message" | "enum" | "unknown";
  valueWireType: number;
  valueTypeName?: string;
}

export interface NormalizedMessage {
  name: string;
  fullName: string;
  fields: NormalizedField[];
  fieldsByNumber: Map<number, NormalizedField>;
  oneofs: Map<string, string[]>;
  reservedRanges: ReservedRange[];
  reservedNames: Set<string>;
  deletedNumbers: Set<number>;
  deletedNames: Set<string>;
  mapEntry: boolean;
}

export interface NormalizedEnumValue {
  name: string;
  number: number;
  deprecated: boolean;
}

export interface NormalizedEnum {
  name: string;
  fullName: string;
  open: boolean;
  values: NormalizedEnumValue[];
  valuesByNumber: Map<number, NormalizedEnumValue[]>;
  valuesByName: Map<string, NormalizedEnumValue>;
  reservedRanges: ReservedRange[];
  reservedNames: Set<string>;
  deletedNumbers: Set<number>;
  deletedNames: Set<string>;
  allowAlias: boolean;
}

export interface ProtoSchema {
  syntax: ProtoSyntax;
  edition?: string;
  package: string;
  messages: NormalizedMessage[];
  messageMap: Map<string, NormalizedMessage>;
  enums: NormalizedEnum[];
  enumMap: Map<string, NormalizedEnum>;
  deletedMessages: Set<string>;
  deletedEnums: Set<string>;
}

export interface SchemaChange {
  code: string;
  kind: "added" | "removed" | "modified" | "renamed" | "reused" | "reserved";
  message: string;
  path: string;
  directions: BreakingDirection[];
  breaking: boolean;
  severity: "error" | "warning" | "info";
  description: string;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface EvolutionOptions {
  direction?: CompatibilityDirection;
  strict?: boolean;
  /**
   * Treat a JSON/name change as a compatibility failure. By default names are
   * reported as warnings because protobuf's binary wire format does not carry
   * field names.
   */
  strictJson?: boolean;
  /**
   * Extra history may be supplied independently of either schema. This is
   * useful when the "old" schema no longer contains a field that was deleted
   * before it was captured.
   */
  history?: SchemaHistory;
}

export interface EvolutionReport {
  oldSchema: ProtoSchema;
  newSchema: ProtoSchema;
  direction: CompatibilityDirection;
  compatible: boolean;
  result: boolean;
  isCompatible: boolean;
  backwardCompatible: boolean;
  forwardCompatible: boolean;
  bidirectionalCompatible: boolean;
  fullyCompatible: boolean;
  isBackwardCompatible: boolean;
  isForwardCompatible: boolean;
  isBidirectionalCompatible: boolean;
  backward: boolean;
  forward: boolean;
  bidirectional: boolean;
  wireCompatible: boolean;
  jsonCompatible: boolean;
  compatibility: CompatibilityLevel;
  breakingChanges: SchemaChange[];
  warnings: SchemaChange[];
  changes: SchemaChange[];
  minimalBreakingPath: string | null;
  breakingPath: string | null;
  minimalBreakingPathDetails: SchemaChange | null;
  minimalBreakingChange: SchemaChange | null;
  minimalBreakingPaths: string[];
  breakingPaths: string[];
  minimalBackwardBreakingPath: string | null;
  minimalForwardBreakingPath: string | null;
  backwardBreakingPath: string | null;
  forwardBreakingPath: string | null;
  minimalBackwardBreakingPathDetails: SchemaChange | null;
  minimalForwardBreakingPathDetails: SchemaChange | null;
}

export interface CompatibilityCheck extends EvolutionReport {
  result: boolean;
  isCompatible: boolean;
}

export type Schema = ProtoSchema;
export type Message = NormalizedMessage;
export type Field = NormalizedField;
export type Enum = NormalizedEnum;
export type CompatibilityReport = EvolutionReport;
export type CompatibilityResult = EvolutionReport;
export type BreakingChange = SchemaChange;
export type SchemaDiff = SchemaChange;
