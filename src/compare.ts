import { normalizeSchema } from "./normalize.ts";
import type {
  BreakingDirection,
  CompatibilityDirection,
  CompatibilityLevel,
  EvolutionOptions,
  EvolutionReport,
  NormalizedEnum,
  NormalizedEnumValue,
  NormalizedField,
  NormalizedMap,
  NormalizedMessage,
  ProtoSchema,
  ScalarType,
  SchemaChange,
  SchemaHistory,
} from "./types.ts";
import { scalarInfo, wireFamilyOf, wireTypeName } from "./wire.ts";

const BOTH: BreakingDirection[] = ["backward", "forward"];

interface ChangeInput {
  code: string;
  kind: SchemaChange["kind"];
  message: string;
  path: string;
  directions?: BreakingDirection[];
  severity?: SchemaChange["severity"];
  description: string;
  oldValue?: unknown;
  newValue?: unknown;
}

interface ScalarComparison {
  compatible: boolean;
  directions: BreakingDirection[];
  code?: string;
  description?: string;
}

const JSON_NAME_CODES = new Set([
  "FIELD_RENAMED_SAME_NUMBER",
  "FIELD_JSON_NAME_CHANGED",
  "FIELD_NAME_REUSED_AFTER_DELETE",
  "FIELD_NAME_REUSES_RESERVED_NAME",
  "ENUM_VALUE_RENAMED_SAME_NUMBER",
  "ENUM_VALUE_NAME_REUSED_AFTER_DELETE",
  "ENUM_VALUE_NAME_REUSES_RESERVED_NAME",
]);

export function compareSchemas(
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: EvolutionOptions | CompatibilityDirection,
): EvolutionReport {
  const options = normalizeOptions(optionsOrDirection);
  let oldSchema = normalizeSchema(oldInput);
  const newSchema = normalizeSchema(newInput);
  if (options.history) oldSchema = schemaWithHistory(oldSchema, options.history);

  const changes: SchemaChange[] = [];
  const add = (change: ChangeInput): void => {
    const directions = change.directions ?? [];
    const breaking = directions.length > 0;
    changes.push({
      code: change.code,
      kind: change.kind,
      message: change.message,
      path: change.path,
      directions,
      breaking,
      severity: change.severity ?? (breaking ? "error" : "info"),
      description: change.description,
      oldValue: change.oldValue,
      newValue: change.newValue,
    });
  };

  if (oldSchema.package !== newSchema.package) {
    add({
      code: "PACKAGE_CHANGED",
      kind: "modified",
      message: "package",
      path: "package",
      directions: BOTH,
      description: `Package changed from '${oldSchema.package || "<empty>"}' to '${newSchema.package || "<empty>"}'`,
      oldValue: oldSchema.package,
      newValue: newSchema.package,
    });
  }
  if (oldSchema.syntax !== newSchema.syntax) {
    add({
      code: "SYNTAX_CHANGED",
      kind: "modified",
      message: "file",
      path: "syntax",
      severity: "warning",
      description: `Syntax changed from ${oldSchema.syntax} to ${newSchema.syntax}`,
      oldValue: oldSchema.syntax,
      newValue: newSchema.syntax,
    });
  }

  compareEnums(oldSchema, newSchema, add);
  compareMessages(oldSchema, newSchema, add);

  let finalChanges = changes;
  if (options.strict || options.strictJson) {
    finalChanges = changes.map((change) => {
      const shouldStrict =
        options.strict ||
        (options.strictJson && isJsonAffecting(change));
      if (!shouldStrict || change.breaking) return change;
      return {
        ...change,
        directions: [...BOTH],
        breaking: true,
        severity: "error" as const,
        description: `${change.description} (treated as breaking in strict mode)`,
      };
    });
  }

  const breakingChanges = finalChanges.filter((change) => change.breaking);
  const warnings = finalChanges.filter((change) => !change.breaking && change.severity === "warning");
  const backwardCompatible = !breakingChanges.some((change) => change.directions.includes("backward"));
  const forwardCompatible = !breakingChanges.some((change) => change.directions.includes("forward"));
  const bidirectionalCompatible = backwardCompatible && forwardCompatible;
  const wireCompatible = !breakingChanges.some(
    (change) =>
      !JSON_NAME_CODES.has(change.code) &&
      !change.code.startsWith("JSON_") &&
      !change.code.includes("RESERVED") &&
      !change.code.includes("REUSED"),
  );
  const jsonCompatible = !finalChanges.some(
    (change) =>
      isJsonAffecting(change) &&
      (change.breaking || change.severity === "warning"),
  );

  const minimal = chooseMinimalBreaking(breakingChanges);
  const minimalBackward = chooseMinimalBreaking(
    breakingChanges.filter((change) => change.directions.includes("backward")),
  );
  const minimalForward = chooseMinimalBreaking(
    breakingChanges.filter((change) => change.directions.includes("forward")),
  );

  const compatibility: CompatibilityLevel = bidirectionalCompatible
    ? "full"
    : backwardCompatible
      ? "backward"
      : forwardCompatible
        ? "forward"
        : "none";
  const compatible =
    options.direction === "backward"
      ? backwardCompatible
      : options.direction === "forward"
        ? forwardCompatible
        : bidirectionalCompatible;

  return {
    oldSchema,
    newSchema,
    direction: options.direction,
    compatible,
    result: compatible,
    isCompatible: compatible,
    backwardCompatible,
    forwardCompatible,
    bidirectionalCompatible,
    fullyCompatible: bidirectionalCompatible,
    isBackwardCompatible: backwardCompatible,
    isForwardCompatible: forwardCompatible,
    isBidirectionalCompatible: bidirectionalCompatible,
    backward: backwardCompatible,
    forward: forwardCompatible,
    bidirectional: bidirectionalCompatible,
    wireCompatible,
    jsonCompatible,
    compatibility,
    breakingChanges,
    warnings,
    changes: finalChanges,
    minimalBreakingPath: minimal?.path ?? null,
    breakingPath: minimal?.path ?? null,
    minimalBreakingPathDetails: minimal,
    minimalBreakingChange: minimal,
    minimalBreakingPaths: unique(breakingChanges.map((change) => change.path)),
    breakingPaths: unique(breakingChanges.map((change) => change.path)),
    minimalBackwardBreakingPath: minimalBackward?.path ?? null,
    minimalForwardBreakingPath: minimalForward?.path ?? null,
    backwardBreakingPath: minimalBackward?.path ?? null,
    forwardBreakingPath: minimalForward?.path ?? null,
    minimalBackwardBreakingPathDetails: minimalBackward,
    minimalForwardBreakingPathDetails: minimalForward,
  };
}

export function analyzeCompatibility(
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: EvolutionOptions | CompatibilityDirection,
): EvolutionReport {
  return compareSchemas(oldInput, newInput, optionsOrDirection);
}

export function checkCompatibility(
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: EvolutionOptions | CompatibilityDirection,
): EvolutionReport {
  return compareSchemas(oldInput, newInput, optionsOrDirection);
}

export function isCompatible(
  oldInput: unknown,
  newInput: unknown,
  optionsOrDirection?: EvolutionOptions | CompatibilityDirection,
): boolean {
  return compareSchemas(oldInput, newInput, optionsOrDirection).compatible;
}

export function isBackwardCompatible(oldInput: unknown, newInput: unknown): boolean {
  return compareSchemas(oldInput, newInput, "backward").backwardCompatible;
}

export function isForwardCompatible(oldInput: unknown, newInput: unknown): boolean {
  return compareSchemas(oldInput, newInput, "forward").forwardCompatible;
}

export function isFullyCompatible(oldInput: unknown, newInput: unknown): boolean {
  return compareSchemas(oldInput, newInput, "full").bidirectionalCompatible;
}

function normalizeOptions(
  optionsOrDirection?: EvolutionOptions | CompatibilityDirection,
): EvolutionOptions & { direction: CompatibilityDirection } {
  if (typeof optionsOrDirection === "string") {
    return { direction: normalizeDirection(optionsOrDirection) };
  }
  return {
    ...(optionsOrDirection ?? {}),
    direction: normalizeDirection(optionsOrDirection?.direction),
  };
}

function normalizeDirection(direction?: CompatibilityDirection): CompatibilityDirection {
  if (direction === "bidirectional" || direction === "both") return "full";
  return direction ?? "full";
}

function compareMessages(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  add: (change: ChangeInput) => void,
): void {
  for (const oldMessage of oldSchema.messages) {
    if (oldMessage.mapEntry) continue;
    const newMessage = newSchema.messageMap.get(oldMessage.fullName);
    if (!newMessage) {
      add({
        code: "MESSAGE_REMOVED",
        kind: "removed",
        message: oldMessage.fullName,
        path: oldMessage.fullName,
        severity: "warning",
        description: `Message '${oldMessage.fullName}' was removed`,
        oldValue: oldMessage.fullName,
      });
      continue;
    }
    compareMessage(oldSchema, newSchema, oldMessage, newMessage, add);
  }

  for (const newMessage of newSchema.messages) {
    if (newMessage.mapEntry) continue;
    if (oldSchema.messageMap.has(newMessage.fullName)) continue;
    if (oldSchema.deletedMessages.has(newMessage.fullName)) {
      add({
        code: "MESSAGE_NAME_REUSED_AFTER_DELETE",
        kind: "reused",
        message: newMessage.fullName,
        path: newMessage.fullName,
        directions: BOTH,
        description: `Message name '${newMessage.fullName}' was previously deleted and must not be reused`,
        oldValue: newMessage.fullName,
      });
    } else {
      add({
        code: "MESSAGE_ADDED",
        kind: "added",
        message: newMessage.fullName,
        path: newMessage.fullName,
        description: `Message '${newMessage.fullName}' was added`,
        newValue: newMessage.fullName,
      });
    }
  }
}

function compareMessage(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  oldMessage: NormalizedMessage,
  newMessage: NormalizedMessage,
  add: (change: ChangeInput) => void,
): void {
  const oneofRenames = detectOneofRenames(oldMessage, newMessage);
  for (const [oldName, newName] of oneofRenames) {
    if (oldName === newName) continue;
    add({
      code: "ONEOF_RENAMED",
      kind: "renamed",
      message: oldMessage.fullName,
      path: `${oldMessage.fullName}.${oldName}`,
      severity: "warning",
      description: `Oneof '${oldName}' was renamed to '${newName}' without changing its members`,
      oldValue: oldName,
      newValue: newName,
    });
  }

  compareReservations(oldMessage, newMessage, add);

  const oldByName = new Map(oldMessage.fields.map((field) => [field.name, field]));
  const newByName = new Map(newMessage.fields.map((field) => [field.name, field]));
  const pairedOldNumbers = new Set<number>();
  const pairedNewNumbers = new Set<number>();

  for (const oldField of oldMessage.fields) {
    if (newMessage.fieldsByNumber.has(oldField.number)) continue;
    const newField = newByName.get(oldField.name);
    if (newField && newField.number !== oldField.number) {
      pairedOldNumbers.add(oldField.number);
      pairedNewNumbers.add(newField.number);
      addFieldNumberChanged(oldMessage, oldField, newField, add);
    }
  }

  for (const oldField of oldMessage.fields) {
    if (pairedOldNumbers.has(oldField.number)) continue;
    const newField = newMessage.fieldsByNumber.get(oldField.number);
    if (!newField) {
      addFieldRemoved(oldMessage, oldField, newMessage, add);
      continue;
    }
    compareMatchedField(
      oldSchema,
      newSchema,
      oldMessage,
      oldField,
      newField,
      newMessage,
      oneofRenames,
      add,
    );
  }

  for (const newField of newMessage.fields) {
    if (pairedNewNumbers.has(newField.number)) continue;
    const oldAtNumber = oldMessage.fieldsByNumber.get(newField.number);
    if (oldAtNumber && !pairedOldNumbers.has(newField.number)) continue;
    addFieldAdded(
      oldMessage,
      newMessage,
      newField,
      add,
      Boolean(oldAtNumber && pairedOldNumbers.has(newField.number)),
    );
  }

  for (const [oldOneof, members] of oldMessage.oneofs) {
    if (newMessage.oneofs.has(oldOneof)) continue;
    const renamed = oneofRenames.get(oldOneof);
    if (renamed && renamed !== oldOneof) continue;
    const surviving = members.filter((name) => newMessage.fields.some((field) => field.name === name));
    if (surviving.length > 0) {
      // Field-level membership checks report the actual direction of loss.
      continue;
    }
    add({
      code: "ONEOF_REMOVED",
      kind: "removed",
      message: oldMessage.fullName,
      path: `${oldMessage.fullName}.${oldOneof}`,
      severity: "info",
      description: `Oneof '${oldOneof}' and its members were removed`,
      oldValue: oldOneof,
    });
  }

  for (const [newOneof] of newMessage.oneofs) {
    if (oldMessage.oneofs.has(newOneof)) continue;
    const renamedFrom = [...oneofRenames.entries()].find(([, value]) => value === newOneof)?.[0];
    if (renamedFrom) continue;
    add({
      code: "ONEOF_ADDED",
      kind: "added",
      message: oldMessage.fullName,
      path: `${oldMessage.fullName}.${newOneof}`,
      severity: "info",
      description: `Oneof '${newOneof}' was added`,
      newValue: newOneof,
    });
  }
}

function compareReservations(
  oldMessage: NormalizedMessage,
  newMessage: NormalizedMessage,
  add: (change: ChangeInput) => void,
): void {
  for (const range of oldMessage.reservedRanges) {
    if (!rangesCover(newMessage.reservedRanges, range)) {
      add({
        code: "RESERVED_RANGE_REMOVED",
        kind: "reserved",
        message: oldMessage.fullName,
        path: `${oldMessage.fullName}.reserved`,
        severity: "warning",
        description: `Reserved field-number range ${range.start}-${range.end} was removed; those numbers may be reused accidentally`,
        oldValue: range,
      });
    }
  }
  for (const name of oldMessage.reservedNames) {
    if (!newMessage.reservedNames.has(name)) {
      add({
        code: "RESERVED_NAME_REMOVED",
        kind: "reserved",
        message: oldMessage.fullName,
        path: `${oldMessage.fullName}.reserved.${name}`,
        severity: "warning",
        description: `Reserved field name '${name}' was removed; the name may be reused accidentally`,
        oldValue: name,
      });
    }
  }
  for (const range of newMessage.reservedRanges) {
    if (!rangesCover(oldMessage.reservedRanges, range)) {
      add({
        code: "RESERVED_RANGE_ADDED",
        kind: "reserved",
        message: oldMessage.fullName,
        path: `${oldMessage.fullName}.reserved`,
        severity: "info",
        description: `Reserved field-number range ${range.start}-${range.end} was added`,
        newValue: range,
      });
    }
  }
}

function addFieldNumberChanged(
  message: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  add: (change: ChangeInput) => void,
): void {
  add({
    code: "FIELD_NUMBER_CHANGED",
    kind: "modified",
    message: message.fullName,
    path: `${message.fullName}.${oldField.name}`,
    directions: BOTH,
    description: `Field '${oldField.name}' changed number from ${oldField.number} to ${newField.number}`,
    oldValue: { name: oldField.name, number: oldField.number, type: oldField.declaredType },
    newValue: { name: newField.name, number: newField.number, type: newField.declaredType },
  });
}

function addFieldRemoved(
  message: NormalizedMessage,
  field: NormalizedField,
  newMessage: NormalizedMessage,
  add: (change: ChangeInput) => void,
): void {
  const numberReserved = isNumberReserved(field.number, newMessage.reservedRanges);
  const nameReserved = newMessage.reservedNames.has(field.name);
  const safeRemoval = numberReserved && nameReserved;
  const directions: BreakingDirection[] = [];
  if (field.label === "required") directions.push("forward");
  add({
    code: safeRemoval
      ? "FIELD_REMOVED_RESERVED"
      : "FIELD_REMOVED_WITHOUT_RESERVATION",
    kind: "removed",
    message: message.fullName,
    path: `${message.fullName}.${field.name}`,
    directions,
    severity: safeRemoval ? "info" : "warning",
    description: safeRemoval
      ? `Field '${field.name}' (${field.number}) was removed and its number/name were reserved`
      : `Field '${field.name}' (${field.number}) was removed without reserving both its number and name`,
    oldValue: fieldSnapshot(field),
  });
}

function addFieldAdded(
  oldMessage: NormalizedMessage,
  newMessage: NormalizedMessage,
  field: NormalizedField,
  add: (change: ChangeInput) => void,
  numberVacatedByMovedField = false,
): void {
  const numberReused =
    numberVacatedByMovedField ||
    isNumberReserved(field.number, oldMessage.reservedRanges) ||
    oldMessage.deletedNumbers.has(field.number);
  const nameReused =
    oldMessage.reservedNames.has(field.name) ||
    oldMessage.deletedNames.has(field.name);

  if (numberReused || nameReused) {
    add({
      code: numberReused
        ? "FIELD_NUMBER_REUSED_AFTER_DELETE"
        : "FIELD_NAME_REUSES_RESERVED_NAME",
      kind: "reused",
      message: oldMessage.fullName,
      path: `${oldMessage.fullName}.${field.name}`,
      directions: BOTH,
      description: numberReused
        ? `Field '${field.name}' reuses number ${field.number}, which was deleted/reserved in the old schema`
        : `Field '${field.name}' reuses a name that was reserved/deleted in the old schema`,
      oldValue: {
        reservedRanges: oldMessage.reservedRanges,
        deletedNumbers: [...oldMessage.deletedNumbers],
        reservedNames: [...oldMessage.reservedNames],
        deletedNames: [...oldMessage.deletedNames],
      },
      newValue: fieldSnapshot(field),
    });
    return;
  }

  add({
    code: "FIELD_ADDED",
    kind: "added",
    message: oldMessage.fullName,
    path: `${oldMessage.fullName}.${field.name}`,
    directions: field.label === "required" ? ["backward"] : [],
    severity: field.label === "required" ? "error" : "info",
    description:
      field.label === "required"
        ? `Required field '${field.name}' (${field.number}) was added; old payloads do not contain it`
        : `Field '${field.name}' (${field.number}) was added`,
    newValue: fieldSnapshot(field),
  });
}

function compareMatchedField(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  oldMessage: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  newMessage: NormalizedMessage,
  oneofRenames: Map<string, string>,
  add: (change: ChangeInput) => void,
): void {
  const path = `${oldMessage.fullName}.${newField.name}`;
  const sameNumber = oldField.number === newField.number;
  const nameChanged = oldField.name !== newField.name;

  if (nameChanged) {
    const numberReused =
      oldMessage.reservedNames.has(newField.name) ||
      oldMessage.deletedNames.has(newField.name) ||
      newMessage.reservedNames.has(oldField.name) ||
      newMessage.deletedNames.has(oldField.name);
    if (numberReused) {
      add({
        code: "FIELD_NUMBER_REUSED_AFTER_DELETE",
        kind: "reused",
        message: oldMessage.fullName,
        path,
        directions: BOTH,
        description: `Field number ${oldField.number} appears to have been reused after '${oldField.name}' was deleted`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    } else {
      add({
        code: "FIELD_RENAMED_SAME_NUMBER",
        kind: "renamed",
        message: oldMessage.fullName,
        path,
        severity: "warning",
        description: `Field '${oldField.name}' was renamed to '${newField.name}' without changing number ${oldField.number}; binary wire format is unaffected`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    }
  } else if (sameNumber && oldField.jsonName !== newField.jsonName) {
    add({
      code: "FIELD_JSON_NAME_CHANGED",
      kind: "modified",
      message: oldMessage.fullName,
      path,
      severity: "warning",
      description: `Field '${oldField.name}' changed its JSON name from '${oldField.jsonName}' to '${newField.jsonName}'`,
      oldValue: oldField.jsonName,
      newValue: newField.jsonName,
    });
  }

  if (oldField.typeKind === "map" || newField.typeKind === "map") {
    compareMapField(oldSchema, newSchema, oldMessage, oldField, newField, add);
  } else {
    compareFieldType(oldSchema, newSchema, oldMessage, oldField, newField, add);
  }

  compareLabels(oldMessage, oldField, newField, add);
  compareOneofMembership(oldMessage, oldField, newField, oneofRenames, add);

  if (
    oldField.label === "repeated" &&
    newField.label === "repeated" &&
    (oldField.packable || newField.packable) &&
    oldField.packed !== newField.packed
  ) {
    add({
      code: "FIELD_PACKING_CHANGED",
      kind: "modified",
      message: oldMessage.fullName,
      path,
      severity: "info",
      description: `Repeated field '${newField.name}' changed packed encoding; protobuf decoders accept both forms`,
      oldValue: oldField.packed,
      newValue: newField.packed,
    });
  }

  if (
    oldField.defaultValue !== undefined &&
    newField.defaultValue !== undefined &&
    oldField.defaultValue !== newField.defaultValue
  ) {
    add({
      code: "FIELD_DEFAULT_CHANGED",
      kind: "modified",
      message: oldMessage.fullName,
      path,
      severity: "warning",
      description: `Field '${newField.name}' changed its default value`,
      oldValue: oldField.defaultValue,
      newValue: newField.defaultValue,
    });
  }
  void newMessage;
}

function compareFieldType(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  message: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  add: (change: ChangeInput) => void,
): void {
  const path = `${message.fullName}.${newField.name}`;
  if (oldField.wireType !== newField.wireType) {
    add({
      code: "FIELD_WIRE_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Field '${newField.name}' changed wire type from ${wireTypeName(oldField.wireType)} (${oldField.wireType}) to ${wireTypeName(newField.wireType)} (${newField.wireType})`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  const oldFamily = wireFamilyOf(oldField);
  const newFamily = wireFamilyOf(newField);
  if (oldFamily !== newFamily) {
    add({
      code: "FIELD_WIRE_ENCODING_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Field '${newField.name}' keeps wire type ${oldField.wireType} but changes encoding family from ${oldFamily} to ${newFamily}`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  if (oldField.typeKind === "scalar" && newField.typeKind === "scalar") {
    const comparison = compareScalars(oldField.scalar!, newField.scalar!);
    if (comparison.directions.length > 0) {
      add({
        code: comparison.code ?? "FIELD_TYPE_CHANGED",
        kind: "modified",
        message: message.fullName,
        path,
        directions: comparison.directions,
        description: comparison.description ?? `Field '${newField.name}' changed type`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    } else if (oldField.scalar !== newField.scalar) {
      add({
        code: "FIELD_TYPE_CHANGED_WIRE_COMPATIBLE",
        kind: "modified",
        message: message.fullName,
        path,
        severity: "warning",
        description: `Field '${newField.name}' changed type from ${oldField.scalar} to ${newField.scalar}; the types share wire type ${oldField.wireType} and are binary-compatible`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    }
    return;
  }

  if (oldField.typeKind === "enum" && newField.typeKind === "enum") {
    if (oldField.typeName !== newField.typeName) {
      add({
        code: "FIELD_ENUM_TYPE_CHANGED",
        kind: "modified",
        message: message.fullName,
        path,
        directions: BOTH,
        description: `Field '${newField.name}' changed enum type from ${oldField.typeName} to ${newField.typeName}`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    }
    return;
  }

  if (oldField.typeKind === "message" && newField.typeKind === "message") {
    if (oldField.typeName !== newField.typeName) {
      add({
        code: "FIELD_MESSAGE_TYPE_CHANGED",
        kind: "modified",
        message: message.fullName,
        path,
        directions: BOTH,
        description: `Field '${newField.name}' changed message type from ${oldField.typeName} to ${newField.typeName}`,
        oldValue: fieldSnapshot(oldField),
        newValue: fieldSnapshot(newField),
      });
    }
    return;
  }

  if (
    (oldField.typeKind === "message" && isLengthScalar(newField)) ||
    (newField.typeKind === "message" && isLengthScalar(oldField))
  ) {
    add({
      code: "FIELD_MESSAGE_SCALAR_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      severity: "warning",
      description: `Field '${newField.name}' changed between an embedded message and ${oldField.typeKind === "message" ? newField.declaredType : oldField.declaredType}; both use length-delimited wire type`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  if (oldField.typeKind === "enum" && isVarintScalar(newField)) {
    const oldEnum = enumForField(oldSchema, oldField);
    const directions: BreakingDirection[] = oldEnum && !oldEnum.open ? ["forward"] : [];
    add({
      code: "FIELD_ENUM_TO_SCALAR",
      kind: "modified",
      message: message.fullName,
      path,
      directions,
      severity: directions.length > 0 ? "error" : "warning",
      description: `Field '${newField.name}' changed from enum ${oldField.typeName} to scalar ${newField.declaredType}; enum values outside the old enum's domain may be lost`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  if (isVarintScalar(oldField) && newField.typeKind === "enum") {
    const newEnum = enumForField(newSchema, newField);
    const directions: BreakingDirection[] = newEnum && !newEnum.open ? ["backward"] : [];
    add({
      code: "FIELD_SCALAR_TO_ENUM",
      kind: "modified",
      message: message.fullName,
      path,
      directions,
      severity: directions.length > 0 ? "error" : "warning",
      description: `Field '${newField.name}' changed from scalar ${oldField.declaredType} to enum ${newField.typeName}; unknown numeric values are handled according to enum openness`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  if (oldField.declaredType !== newField.declaredType) {
    add({
      code: "FIELD_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Field '${newField.name}' changed type from ${oldField.declaredType} to ${newField.declaredType}`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
  }
}

function compareMapField(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  message: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  add: (change: ChangeInput) => void,
): void {
  const path = `${message.fullName}.${newField.name}`;
  if (!oldField.map || !newField.map) {
    add({
      code: "FIELD_MAP_KIND_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Field '${newField.name}' changed between a map and a non-map field`,
      oldValue: fieldSnapshot(oldField),
      newValue: fieldSnapshot(newField),
    });
    return;
  }

  const oldMap = oldField.map;
  const newMap = newField.map;
  if (oldMap.keyType !== newMap.keyType) {
    const keyComparison = compareScalars(oldMap.keyType, newMap.keyType);
    add({
      code: keyComparison.compatible ? "MAP_KEY_TYPE_CHANGED" : "MAP_KEY_WIRE_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: keyComparison.directions,
      severity: keyComparison.compatible ? "warning" : "error",
      description: `Map field '${newField.name}' changed key type from ${oldMap.keyType} to ${newMap.keyType}`,
      oldValue: oldMap.keyType,
      newValue: newMap.keyType,
    });
  }

  compareMapValue(oldSchema, newSchema, message, newField, oldMap, newMap, add);
}

function compareMapValue(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  message: NormalizedMessage,
  newField: NormalizedField,
  oldMap: NormalizedMap,
  newMap: NormalizedMap,
  add: (change: ChangeInput) => void,
): void {
  const path = `${message.fullName}.${newField.name}`;
  if (oldMap.valueWireType !== newMap.valueWireType) {
    add({
      code: "MAP_VALUE_WIRE_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Map field '${newField.name}' changed value wire type from ${wireTypeName(oldMap.valueWireType)} to ${wireTypeName(newMap.valueWireType)}`,
      oldValue: oldMap.valueType,
      newValue: newMap.valueType,
    });
    return;
  }

  if (oldMap.valueKind === "scalar" && newMap.valueKind === "scalar") {
    const oldScalar = oldMap.valueType as ScalarType;
    const newScalar = newMap.valueType as ScalarType;
    const comparison = compareScalars(oldScalar, newScalar);
    if (oldScalar !== newScalar) {
      add({
        code: comparison.compatible ? "MAP_VALUE_TYPE_CHANGED" : "MAP_VALUE_ENCODING_CHANGED",
        kind: "modified",
        message: message.fullName,
        path,
        directions: comparison.directions,
        severity: comparison.compatible ? "warning" : "error",
        description: `Map field '${newField.name}' changed value type from ${oldMap.valueType} to ${newMap.valueType}`,
        oldValue: oldMap.valueType,
        newValue: newMap.valueType,
      });
    }
    return;
  }

  if (oldMap.valueKind !== newMap.valueKind) {
    const directions: BreakingDirection[] =
      (oldMap.valueKind === "enum" && newMap.valueKind === "scalar" && isOpenEnum(oldSchema, oldMap.valueTypeName))
        ? []
        : (newMap.valueKind === "enum" && oldMap.valueKind === "scalar" && isOpenEnum(newSchema, newMap.valueTypeName))
          ? []
          : BOTH;
    add({
      code: "MAP_VALUE_KIND_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions,
      severity: directions.length > 0 ? "error" : "warning",
      description: `Map field '${newField.name}' changed value kind from ${oldMap.valueKind} to ${newMap.valueKind}`,
      oldValue: oldMap.valueType,
      newValue: newMap.valueType,
    });
    return;
  }

  if (oldMap.valueType !== newMap.valueType) {
    add({
      code:
        oldMap.valueKind === "message"
          ? "MAP_VALUE_MESSAGE_TYPE_CHANGED"
          : "MAP_VALUE_ENUM_TYPE_CHANGED",
      kind: "modified",
      message: message.fullName,
      path,
      directions: BOTH,
      description: `Map field '${newField.name}' changed ${oldMap.valueKind} value type from ${oldMap.valueType} to ${newMap.valueType}`,
      oldValue: oldMap.valueType,
      newValue: newMap.valueType,
    });
  }
}

function compareLabels(
  message: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  add: (change: ChangeInput) => void,
): void {
  if (oldField.label === newField.label) {
    if (
      oldField.label === "optional" &&
      oldField.proto3Optional !== newField.proto3Optional
    ) {
      add({
        code: "FIELD_PRESENCE_CHANGED",
        kind: "modified",
        message: message.fullName,
        path: `${message.fullName}.${newField.name}`,
        severity: "warning",
        description: `Field '${newField.name}' changed explicit presence without changing wire encoding`,
        oldValue: oldField.proto3Optional,
        newValue: newField.proto3Optional,
      });
    }
    return;
  }

  const oldLabel = oldField.label;
  const newLabel = newField.label;
  const path = `${message.fullName}.${newField.name}`;
  let directions: BreakingDirection[] = [];
  let description = `Field '${newField.name}' changed label from ${oldLabel} to ${newLabel}`;

  if (oldLabel === "optional" && newLabel === "required") {
    directions = ["backward"];
    description = `Field '${newField.name}' became required; old payloads may omit it`;
  } else if (oldLabel === "required" && newLabel === "optional") {
    directions = ["forward"];
    description = `Field '${newField.name}' stopped being required; old readers may reject new payloads that omit it`;
  } else if (oldLabel === "repeated" && newLabel === "optional") {
    directions = ["backward"];
    description = `Field '${newField.name}' changed from repeated to singular; old payloads may contain multiple values that the new reader collapses to one`;
  } else if (oldLabel === "optional" && newLabel === "repeated") {
    directions = ["forward"];
    description = `Field '${newField.name}' changed from singular to repeated; old readers may collapse multiple new values to one`;
  } else if (oldLabel === "required" && newLabel === "repeated") {
    directions = ["forward"];
    description = `Field '${newField.name}' changed from required to repeated; old readers may reject new payloads that omit it`;
  } else if (oldLabel === "repeated" && newLabel === "required") {
    directions = ["backward"];
    description = `Field '${newField.name}' became required; old payloads may be empty or repeated`;
  }

  add({
    code: "FIELD_LABEL_CHANGED",
    kind: "modified",
    message: message.fullName,
    path,
    directions,
    severity: directions.length > 0 ? "error" : "warning",
    description,
    oldValue: oldLabel,
    newValue: newLabel,
  });
}

function compareOneofMembership(
  message: NormalizedMessage,
  oldField: NormalizedField,
  newField: NormalizedField,
  oneofRenames: Map<string, string>,
  add: (change: ChangeInput) => void,
): void {
  const oldOneof = oldField.oneof;
  const newOneof = newField.oneof;
  if (oldOneof === newOneof) return;
  if (oldOneof && newOneof && oneofRenames.get(oldOneof) === newOneof) return;

  let directions: BreakingDirection[] = [];
  let code = "ONEOF_MEMBERSHIP_CHANGED";
  let description = `Field '${newField.name}' moved from oneof '${oldOneof}' to '${newOneof}'`;
  if (!oldOneof && newOneof) {
    directions = ["backward"];
    code = "FIELD_ENTERED_ONEOF";
    description = `Field '${newField.name}' moved into oneof '${newOneof}'; old payloads may contain several members of that oneof, so only the last is retained`;
  } else if (oldOneof && !newOneof) {
    directions = ["forward"];
    code = "FIELD_LEFT_ONEOF";
    description = `Field '${newField.name}' moved out of oneof '${oldOneof}'; new payloads may contain multiple formerly-exclusive members`;
  } else {
    directions = BOTH;
  }

  add({
    code,
    kind: "modified",
    message: message.fullName,
    path: `${message.fullName}.${newField.name}`,
    directions,
    description,
    oldValue: oldOneof ?? null,
    newValue: newOneof ?? null,
  });
}

function compareEnums(
  oldSchema: ProtoSchema,
  newSchema: ProtoSchema,
  add: (change: ChangeInput) => void,
): void {
  for (const oldEnum of oldSchema.enums) {
    const newEnum = newSchema.enumMap.get(oldEnum.fullName);
    if (!newEnum) {
      add({
        code: "ENUM_REMOVED",
        kind: "removed",
        message: oldEnum.fullName,
        path: oldEnum.fullName,
        severity: "warning",
        description: `Enum '${oldEnum.fullName}' was removed`,
        oldValue: oldEnum.fullName,
      });
      continue;
    }
    compareEnum(oldEnum, newEnum, add);
  }

  for (const newEnum of newSchema.enums) {
    if (oldSchema.enumMap.has(newEnum.fullName)) continue;
    if (oldSchema.deletedEnums.has(newEnum.fullName)) {
      add({
        code: "ENUM_NAME_REUSED_AFTER_DELETE",
        kind: "reused",
        message: newEnum.fullName,
        path: newEnum.fullName,
        directions: BOTH,
        description: `Enum name '${newEnum.fullName}' was previously deleted and must not be reused`,
        oldValue: newEnum.fullName,
      });
    } else {
      add({
        code: "ENUM_ADDED",
        kind: "added",
        message: newEnum.fullName,
        path: newEnum.fullName,
        description: `Enum '${newEnum.fullName}' was added`,
        newValue: newEnum.fullName,
      });
    }
  }
}

function compareEnum(
  oldEnum: NormalizedEnum,
  newEnum: NormalizedEnum,
  add: (change: ChangeInput) => void,
): void {
  if (oldEnum.open !== newEnum.open) {
    const directions: BreakingDirection[] = oldEnum.open ? ["backward"] : ["forward"];
    add({
      code: "ENUM_OPENNESS_CHANGED",
      kind: "modified",
      message: oldEnum.fullName,
      path: oldEnum.fullName,
      directions,
      description: oldEnum.open
        ? `Enum '${oldEnum.fullName}' changed from open to closed; a new closed reader cannot retain unknown numeric values written by old producers`
        : `Enum '${oldEnum.fullName}' changed from closed to open; an old closed reader cannot retain unknown numeric values written by new producers`,
      oldValue: oldEnum.open ? "open" : "closed",
      newValue: newEnum.open ? "open" : "closed",
    });
  }

  const matchedOld = new Set<NormalizedEnumValue>();
  const matchedNew = new Set<NormalizedEnumValue>();

  for (const oldValue of oldEnum.values) {
    const sameName = newEnum.valuesByName.get(oldValue.name);
    if (sameName) {
      matchedOld.add(oldValue);
      matchedNew.add(sameName);
      if (sameName.number !== oldValue.number) {
        add({
          code: "ENUM_VALUE_NUMBER_CHANGED",
          kind: "modified",
          message: oldEnum.fullName,
          path: `${oldEnum.fullName}.${oldValue.name}`,
          directions: BOTH,
          description: `Enum value '${oldValue.name}' changed number from ${oldValue.number} to ${sameName.number}`,
          oldValue: { name: oldValue.name, number: oldValue.number },
          newValue: { name: sameName.name, number: sameName.number },
        });
      }
    }
  }

  for (const oldValue of oldEnum.values) {
    if (matchedOld.has(oldValue)) continue;
    const sameNumber = newEnum.valuesByNumber.get(oldValue.number);
    const newValue =
      sameNumber?.find((value) => value.name === oldValue.name && !matchedNew.has(value)) ??
      sameNumber?.find((value) => !matchedNew.has(value));
    if (newValue) {
      matchedOld.add(oldValue);
      matchedNew.add(newValue);
      const reused =
        oldEnum.reservedNames.has(newValue.name) ||
        oldEnum.deletedNames.has(newValue.name) ||
        newEnum.reservedNames.has(oldValue.name) ||
        newEnum.deletedNames.has(oldValue.name);
      if (reused) {
        add({
          code: "ENUM_VALUE_NUMBER_REUSED_AFTER_DELETE",
          kind: "reused",
          message: oldEnum.fullName,
          path: `${oldEnum.fullName}.${newValue.name}`,
          directions: BOTH,
          description: `Enum value number ${oldValue.number} appears to have been reused after '${oldValue.name}' was deleted`,
          oldValue: { name: oldValue.name, number: oldValue.number },
          newValue: { name: newValue.name, number: newValue.number },
        });
      } else {
        add({
          code: "ENUM_VALUE_RENAMED_SAME_NUMBER",
          kind: "renamed",
          message: oldEnum.fullName,
          path: `${oldEnum.fullName}.${newValue.name}`,
          severity: "warning",
          description: `Enum value '${oldValue.name}' was renamed to '${newValue.name}' without changing number ${oldValue.number}`,
          oldValue: { name: oldValue.name, number: oldValue.number },
          newValue: { name: newValue.name, number: newValue.number },
        });
      }
    }
  }

  for (const oldValue of oldEnum.values) {
    if (matchedOld.has(oldValue)) continue;
    const safe = isNumberReserved(oldValue.number, newEnum.reservedRanges) && newEnum.reservedNames.has(oldValue.name);
    const directions: BreakingDirection[] = newEnum.open ? [] : ["backward"];
    add({
      code: safe
        ? "ENUM_VALUE_REMOVED_RESERVED"
        : "ENUM_VALUE_REMOVED_WITHOUT_RESERVATION",
      kind: "removed",
      message: oldEnum.fullName,
      path: `${oldEnum.fullName}.${oldValue.name}`,
      directions,
      severity: directions.length > 0 ? "error" : safe ? "info" : "warning",
      description: safe
        ? `Enum value '${oldValue.name}' (${oldValue.number}) was removed and reserved`
        : `Enum value '${oldValue.name}' (${oldValue.number}) was removed without reserving both its number and name`,
      oldValue: { name: oldValue.name, number: oldValue.number },
    });
  }

  for (const newValue of newEnum.values) {
    if (matchedNew.has(newValue)) continue;
    if (oldEnum.valuesByNumber.has(newValue.number)) {
      add({
        code: "ENUM_VALUE_ALIAS_ADDED",
        kind: "added",
        message: oldEnum.fullName,
        path: `${oldEnum.fullName}.${newValue.name}`,
        description: `Enum alias '${newValue.name}' was added for existing number ${newValue.number}`,
        newValue: { name: newValue.name, number: newValue.number },
      });
      continue;
    }
    const numberReused =
      isNumberReserved(newValue.number, oldEnum.reservedRanges) ||
      oldEnum.deletedNumbers.has(newValue.number);
    const nameReused =
      oldEnum.reservedNames.has(newValue.name) ||
      oldEnum.deletedNames.has(newValue.name);
    if (numberReused || nameReused) {
      add({
        code: numberReused
          ? "ENUM_VALUE_NUMBER_REUSED_AFTER_DELETE"
          : "ENUM_VALUE_NAME_REUSES_RESERVED_NAME",
        kind: "reused",
        message: oldEnum.fullName,
        path: `${oldEnum.fullName}.${newValue.name}`,
        directions: BOTH,
        description: numberReused
          ? `Enum value '${newValue.name}' reuses number ${newValue.number}, which was deleted/reserved in the old enum`
          : `Enum value '${newValue.name}' reuses a name that was reserved/deleted in the old enum`,
        oldValue: {
          reservedRanges: oldEnum.reservedRanges,
          deletedNumbers: [...oldEnum.deletedNumbers],
          reservedNames: [...oldEnum.reservedNames],
          deletedNames: [...oldEnum.deletedNames],
        },
        newValue: { name: newValue.name, number: newValue.number },
      });
      continue;
    }

    const directions: BreakingDirection[] = oldEnum.open ? [] : ["forward"];
    add({
      code: "ENUM_VALUE_ADDED",
      kind: "added",
      message: oldEnum.fullName,
      path: `${oldEnum.fullName}.${newValue.name}`,
      directions,
      severity: directions.length > 0 ? "error" : "info",
      description: oldEnum.open
        ? `Enum value '${newValue.name}' (${newValue.number}) was added to an open enum`
        : `Enum value '${newValue.name}' (${newValue.number}) was added to a closed enum; old readers treat it as an unknown field`,
      newValue: { name: newValue.name, number: newValue.number },
    });
  }

  for (const range of oldEnum.reservedRanges) {
    if (!rangesCover(newEnum.reservedRanges, range)) {
      add({
        code: "ENUM_RESERVED_RANGE_REMOVED",
        kind: "reserved",
        message: oldEnum.fullName,
        path: `${oldEnum.fullName}.reserved`,
        severity: "warning",
        description: `Reserved enum-number range ${range.start}-${range.end} was removed`,
        oldValue: range,
      });
    }
  }
  for (const name of oldEnum.reservedNames) {
    if (!newEnum.reservedNames.has(name)) {
      add({
        code: "ENUM_RESERVED_NAME_REMOVED",
        kind: "reserved",
        message: oldEnum.fullName,
        path: `${oldEnum.fullName}.reserved.${name}`,
        severity: "warning",
        description: `Reserved enum value name '${name}' was removed`,
        oldValue: name,
      });
    }
  }
}

function compareScalars(oldType: ScalarType, newType: ScalarType): ScalarComparison {
  if (oldType === newType) return { compatible: true, directions: [] };
  const oldInfo = scalarInfo[oldType];
  const newInfo = scalarInfo[newType];
  if (oldInfo.wireType !== newInfo.wireType) {
    return {
      compatible: false,
      directions: [...BOTH],
      code: "FIELD_WIRE_TYPE_CHANGED",
      description: `${oldType} and ${newType} use different wire types (${oldInfo.wireType} and ${newInfo.wireType})`,
    };
  }
  if (oldInfo.family !== newInfo.family) {
    return {
      compatible: false,
      directions: [...BOTH],
      code: "FIELD_WIRE_ENCODING_CHANGED",
      description: `${oldType} and ${newType} share wire type ${oldInfo.wireType} but use different value encodings (${oldInfo.family} vs ${newInfo.family})`,
    };
  }
  return { compatible: true, directions: [] };
}

function isOpenEnum(schema: ProtoSchema, typeName?: string): boolean {
  if (!typeName) return true;
  return schema.enumMap.get(typeName)?.open ?? true;
}

function enumForField(schema: ProtoSchema, field: NormalizedField): NormalizedEnum | undefined {
  return field.typeName ? schema.enumMap.get(field.typeName) : undefined;
}

function isVarintScalar(field: NormalizedField): boolean {
  return field.typeKind === "scalar" && field.wireType === 0;
}

function isLengthScalar(field: NormalizedField): boolean {
  return field.typeKind === "scalar" && field.wireType === 2;
}

function isNumberReserved(number: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => number >= range.start && number <= range.end);
}

function rangesCover(
  ranges: Array<{ start: number; end: number }>,
  target: { start: number; end: number },
): boolean {
  const sorted = [...ranges]
    .filter((range) => range.end >= target.start && range.start <= target.end)
    .sort((left, right) => left.start - right.start);
  let cursor = target.start;
  for (const range of sorted) {
    if (range.start > cursor) return false;
    if (range.end >= cursor) cursor = range.end + 1;
    if (cursor > target.end) return true;
  }
  return cursor > target.end;
}

function fieldSnapshot(field: NormalizedField): Record<string, unknown> {
  return {
    name: field.name,
    jsonName: field.jsonName,
    number: field.number,
    label: field.label,
    type: field.declaredType,
    typeKind: field.typeKind,
    typeName: field.typeName,
    wireType: field.wireType,
    oneof: field.oneof,
    map: field.map
      ? {
          keyType: field.map.keyType,
          valueType: field.map.valueType,
        }
      : undefined,
  };
}

function isJsonAffecting(change: SchemaChange): boolean {
  if (change.code === "FIELD_RENAMED_SAME_NUMBER") {
    const oldName = (change.oldValue as Record<string, unknown> | undefined)?.jsonName;
    const newName = (change.newValue as Record<string, unknown> | undefined)?.jsonName;
    return oldName !== newName;
  }
  if (change.code === "ONEOF_RENAMED") return false;
  return JSON_NAME_CODES.has(change.code) || change.code.startsWith("JSON_");
}

function detectOneofRenames(
  oldMessage: NormalizedMessage,
  newMessage: NormalizedMessage,
): Map<string, string> {
  const renames = new Map<string, string>();
  const newToOld = new Map<string, string>();
  for (const [oldName, members] of oldMessage.oneofs) {
    if (newMessage.oneofs.has(oldName)) {
      renames.set(oldName, oldName);
      newToOld.set(oldName, oldName);
      continue;
    }
    if (members.length === 0) continue;
    const candidates = [...newMessage.oneofs.entries()].filter(([newName, newMembers]) => {
      if (newMessage.oneofs.has(newName) && oldMessage.oneofs.has(newName)) return false;
      return members.every((member) => newMembers.includes(member));
    });
    if (candidates.length === 1 && !newToOld.has(candidates[0][0])) {
      renames.set(oldName, candidates[0][0]);
      newToOld.set(candidates[0][0], oldName);
    }
  }
  return renames;
}

function chooseMinimalBreaking(changes: SchemaChange[]): SchemaChange | null {
  if (changes.length === 0) return null;
  return [...changes].sort((left, right) => {
    const depth = left.path.split(".").length - right.path.split(".").length;
    if (depth !== 0) return depth;
    const priority = changePriority(left) - changePriority(right);
    if (priority !== 0) return priority;
    return left.path.localeCompare(right.path);
  })[0];
}

function changePriority(change: SchemaChange): number {
  if (change.code.includes("REUSED")) return 0;
  if (change.code.includes("NUMBER_CHANGED")) return 1;
  if (change.code.includes("WIRE")) return 2;
  if (change.code.includes("TYPE")) return 3;
  if (change.code.startsWith("FIELD_")) return 4;
  if (change.code.includes("ONEOF")) return 5;
  if (change.code.includes("ENUM")) return 6;
  return 7;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function schemaWithHistory(schema: ProtoSchema, history: SchemaHistory): ProtoSchema {
  const clone = (message: NormalizedMessage): NormalizedMessage => ({
    ...message,
    fields: [...message.fields],
    fieldsByNumber: new Map(message.fieldsByNumber),
    oneofs: new Map(message.oneofs),
    reservedRanges: [...message.reservedRanges],
    reservedNames: new Set(message.reservedNames),
    deletedNumbers: new Set(message.deletedNumbers),
    deletedNames: new Set(message.deletedNames),
  });
  const messages = schema.messages.map(clone);
  const messageMap = new Map(messages.map((message) => [message.fullName, message]));
  const enums = schema.enums.map((enumDef) => ({
    ...enumDef,
    values: [...enumDef.values],
    valuesByNumber: new Map(enumDef.valuesByNumber),
    valuesByName: new Map(enumDef.valuesByName),
    reservedRanges: [...enumDef.reservedRanges],
    reservedNames: new Set(enumDef.reservedNames),
    deletedNumbers: new Set(enumDef.deletedNumbers),
    deletedNames: new Set(enumDef.deletedNames),
  }));

  for (const message of messages) {
    const shortName = message.fullName.split(".").pop() ?? message.fullName;
    const entry = history.messages?.[message.fullName] ?? history.messages?.[shortName];
    const deleted = history.deletedFields?.[message.fullName] ?? history.deletedFields?.[shortName];
    for (const value of [...(entry?.deletedFields ?? []), ...(entry?.deletedNumbers ?? []), ...(deleted ?? [])]) {
      if (typeof value === "number") message.deletedNumbers.add(value);
      else message.deletedNames.add(value);
    }
    for (const value of entry?.reservedNumbers ?? []) message.deletedNumbers.add(value);
    for (const value of entry?.reservedNames ?? []) message.deletedNames.add(value);
  }

  for (const enumDef of enums) {
    const shortName = enumDef.fullName.split(".").pop() ?? enumDef.fullName;
    const entry = history.enums?.[enumDef.fullName] ?? history.enums?.[shortName];
    for (const value of [
      ...(entry?.deletedValues ?? []),
      ...(entry?.deletedFields ?? []),
      ...(entry?.deletedNumbers ?? []),
    ]) {
      if (typeof value === "number") enumDef.deletedNumbers.add(value);
      else enumDef.deletedNames.add(value);
    }
    for (const value of entry?.reservedNumbers ?? []) enumDef.deletedNumbers.add(value);
    for (const value of entry?.reservedNames ?? []) enumDef.deletedNames.add(value);
  }

  return {
    ...schema,
    messages,
    messageMap,
    enums,
    enumMap: new Map(enums.map((enumDef) => [enumDef.fullName, enumDef])),
    deletedMessages: new Set([...schema.deletedMessages, ...(history.deletedMessages ?? [])]),
    deletedEnums: new Set([...schema.deletedEnums, ...(history.deletedEnums ?? [])]),
  };
}
