// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSchemas,
  isBackwardCompatible,
  isForwardCompatible,
  isFullyCompatible,
  normalizeSchema,
  parseProto,
} from "../index.ts";

const proto = (body: string, syntax = "proto3", packageName = "p") =>
  `syntax = "${syntax}"; package ${packageName}; ${body}`;

test("parses nested messages, maps, oneofs, reserved ranges, and enum openness", () => {
  const source = `
    syntax = "proto3";
    package acme;
    message Order {
      reserved 100 to 110, 200;
      reserved "old_name";
      string id = 1 [json_name = "orderId"];
      map<string, Item> items = 2;
      oneof payment {
        string card = 3;
        string bank = 4;
      }
      message Item { int32 qty = 1; double price = 2; }
      enum Status { NEW = 0; SHIPPED = 1; }
      Status status = 5;
    }
  `;
  const schema = normalizeSchema(source);
  const order = schema.messageMap.get("acme.Order");
  assert.ok(order);
  assert.equal(order.reservedRanges[0].start, 100);
  assert.equal(order.reservedRanges[0].end, 110);
  assert.equal(order.reservedNames.has("old_name"), true);
  assert.deepEqual(order.oneofs.get("payment"), ["card", "bank"]);
  assert.equal(order.fieldsByNumber.get(2).typeKind, "map");
  assert.equal(order.fieldsByNumber.get(2).map.valueType, "acme.Order.Item");
  assert.equal(schema.enumMap.get("acme.Order.Status").open, true);
  assert.equal(schema.messages.some((message) => message.mapEntry), false);

  const parsed = parseProto(source);
  assert.equal(parsed.messages[0].fields[0].jsonName, "orderId");
});

test("a rename with the same number stays binary compatible", () => {
  const report = compareSchemas(
    proto(`message M { string old_name = 1; }`),
    proto(`message M { string new_name = 1; }`),
  );
  assert.equal(report.compatible, true);
  assert.equal(report.compatibility, "full");
  assert.equal(report.backwardCompatible, true);
  assert.equal(report.forwardCompatible, true);
  assert.equal(report.minimalBreakingPath, null);
  assert.deepEqual(report.breakingChanges, []);
  assert.deepEqual(report.warnings.map((change) => change.code), ["FIELD_RENAMED_SAME_NUMBER"]);
  assert.equal(report.jsonCompatible, false);
});

test("reusing a reserved/deleted number is breaking, unlike a rename", () => {
  const report = compareSchemas(
    proto(`message M { reserved 2; reserved "gone"; }`),
    proto(`message M { string replacement = 2; }`),
  );
  assert.equal(report.compatible, false);
  assert.equal(report.compatibility, "none");
  assert.equal(report.backwardCompatible, false);
  assert.equal(report.forwardCompatible, false);
  assert.equal(report.breakingChanges[0].code, "FIELD_NUMBER_REUSED_AFTER_DELETE");
  assert.equal(report.minimalBreakingPath, "p.M.replacement");
});

test("history can identify a number deleted before the old snapshot was taken", () => {
  const report = compareSchemas(
    proto(`message M { string current = 1; }`),
    proto(`message M { string current = 1; string reused = 7; }`),
    { history: { messages: { M: { deletedFields: [7] } } } },
  );
  assert.equal(report.compatible, false);
  assert.equal(report.breakingChanges[0].code, "FIELD_NUMBER_REUSED_AFTER_DELETE");
});

test("field and wire changes identify the shortest breaking path", () => {
  const report = compareSchemas(
    proto(`message M { int32 a = 1; string b = 2; }`),
    proto(`message M { string a = 1; string b = 3; }`),
  );
  assert.equal(report.minimalBreakingPath, "p.M.b");
  assert.equal(report.minimalBreakingPathDetails.code, "FIELD_NUMBER_CHANGED");
  assert.ok(report.breakingPaths.includes("p.M.a"));
});

test("wire-compatible scalar changes do not break, but zigzag changes do", () => {
  const compatible = compareSchemas(
    proto(`message M { int32 value = 1; }`),
    proto(`message M { int64 value = 1; }`),
  );
  assert.equal(compatible.compatible, true);
  assert.equal(compatible.wireCompatible, true);
  assert.equal(compatible.warnings[0].code, "FIELD_TYPE_CHANGED_WIRE_COMPATIBLE");

  const incompatible = compareSchemas(
    proto(`message M { int32 value = 1; }`),
    proto(`message M { sint32 value = 1; }`),
  );
  assert.equal(incompatible.compatible, false);
  assert.equal(incompatible.backwardCompatible, false);
  assert.equal(incompatible.forwardCompatible, false);
  assert.equal(incompatible.breakingChanges[0].code, "FIELD_WIRE_ENCODING_CHANGED");
});

test("labels have asymmetric directions", () => {
  const repeatedToSingular = compareSchemas(
    proto(`message M { repeated int32 value = 1; }`),
    proto(`message M { int32 value = 1; }`),
  );
  assert.equal(repeatedToSingular.backwardCompatible, false);
  assert.equal(repeatedToSingular.forwardCompatible, true);
  assert.equal(repeatedToSingular.compatibility, "forward");

  const singularToRepeated = compareSchemas(
    proto(`message M { int32 value = 1; }`),
    proto(`message M { repeated int32 value = 1; }`),
  );
  assert.equal(singularToRepeated.backwardCompatible, true);
  assert.equal(singularToRepeated.forwardCompatible, false);
  assert.equal(singularToRepeated.compatibility, "backward");

  const optionalToRequired = compareSchemas(
    proto(`message M { optional int32 value = 1; }`, "proto2"),
    proto(`message M { required int32 value = 1; }`, "proto2"),
  );
  assert.equal(optionalToRequired.backwardCompatible, false);
  assert.equal(optionalToRequired.forwardCompatible, true);
});

test("oneof membership changes are directional and a pure oneof rename is not", () => {
  const intoOneof = compareSchemas(
    proto(`message M { int32 a = 1; int32 b = 2; }`),
    proto(`message M { oneof choice { int32 a = 1; int32 b = 2; } }`),
  );
  assert.equal(intoOneof.backwardCompatible, false);
  assert.equal(intoOneof.forwardCompatible, true);
  assert.equal(intoOneof.breakingChanges[0].code, "FIELD_ENTERED_ONEOF");

  const outOfOneof = compareSchemas(
    proto(`message M { oneof choice { int32 a = 1; int32 b = 2; } }`),
    proto(`message M { int32 a = 1; int32 b = 2; }`),
  );
  assert.equal(outOfOneof.backwardCompatible, true);
  assert.equal(outOfOneof.forwardCompatible, false);

  const renamed = compareSchemas(
    proto(`message M { oneof choice { int32 a = 1; int32 b = 2; } }`),
    proto(`message M { oneof selection { int32 a = 1; int32 b = 2; } }`),
  );
  assert.equal(renamed.compatible, true);
  assert.deepEqual(renamed.warnings.map((change) => change.code), ["ONEOF_RENAMED"]);
});

test("map entry changes compare keys, values, and map-vs-non-map", () => {
  const valueWidened = compareSchemas(
    proto(`message M { map<string, int32> values = 1; }`),
    proto(`message M { map<string, int64> values = 1; }`),
  );
  assert.equal(valueWidened.compatible, true);
  assert.equal(valueWidened.warnings[0].code, "MAP_VALUE_TYPE_CHANGED");

  const keyChanged = compareSchemas(
    proto(`message M { map<int32, int32> values = 1; }`),
    proto(`message M { map<sint32, int32> values = 1; }`),
  );
  assert.equal(keyChanged.compatible, false);
  assert.equal(keyChanged.breakingChanges[0].code, "MAP_KEY_WIRE_TYPE_CHANGED");

  const toRepeated = compareSchemas(
    proto(`message M { map<string, int32> values = 1; }`),
    proto(`message M { repeated int32 values = 1; }`),
  );
  assert.equal(toRepeated.compatible, false);
  assert.equal(toRepeated.breakingChanges[0].code, "FIELD_MAP_KIND_CHANGED");
});

test("enum openness and added values distinguish directions", () => {
  const openAdd = compareSchemas(
    proto(`enum E { A = 0; } message M { E value = 1; }`),
    proto(`enum E { A = 0; B = 1; } message M { E value = 1; }`),
  );
  assert.equal(openAdd.compatible, true);

  const closedAdd = compareSchemas(
    proto(`enum E { A = 0; } message M { optional E value = 1; }`, "proto2"),
    proto(`enum E { A = 0; B = 1; } message M { optional E value = 1; }`, "proto2"),
  );
  assert.equal(closedAdd.backwardCompatible, true);
  assert.equal(closedAdd.forwardCompatible, false);
  assert.equal(closedAdd.compatibility, "backward");

  const openToClosed = compareSchemas(
    proto(`enum E { A = 0; } message M { E value = 1; }`),
    proto(`enum E { option features.enum_type = CLOSED; A = 0; } message M { E value = 1; }`),
  );
  assert.equal(openToClosed.backwardCompatible, false);
  assert.equal(openToClosed.forwardCompatible, true);
  assert.equal(openToClosed.breakingChanges[0].code, "ENUM_OPENNESS_CHANGED");

  const closedToOpen = compareSchemas(
    proto(`enum E { option features.enum_type = CLOSED; A = 0; } message M { E value = 1; }`),
    proto(`enum E { A = 0; } message M { E value = 1; }`),
  );
  assert.equal(closedToOpen.backwardCompatible, true);
  assert.equal(closedToOpen.forwardCompatible, false);
});

test("enum value rename and reserved-number reuse produce different conclusions", () => {
  const rename = compareSchemas(
    proto(`enum E { A = 0; }`),
    proto(`enum E { B = 0; }`),
  );
  assert.equal(rename.compatible, true);
  assert.equal(rename.warnings[0].code, "ENUM_VALUE_RENAMED_SAME_NUMBER");

  const reuse = compareSchemas(
    proto(`enum E { reserved 1; A = 0; }`),
    proto(`enum E { A = 0; B = 1; }`),
  );
  assert.equal(reuse.compatible, false);
  assert.equal(reuse.breakingChanges[0].code, "ENUM_VALUE_NUMBER_REUSED_AFTER_DELETE");
  assert.equal(reuse.minimalBreakingPath, "p.E.B");
});

test("descriptor-style JSON and object MessageDefinition inputs are accepted", () => {
  const descriptor = {
    syntax: "proto3",
    package: "p",
    messageType: [
      {
        name: "M",
        field: [
          { name: "id", number: 1, label: 1, type: 9 },
          { name: "items", number: 2, label: 3, type: 11, typeName: ".p.M.ItemsEntry" },
        ],
        nestedType: [
          {
            name: "ItemsEntry",
            options: { mapEntry: true },
            field: [
              { name: "key", number: 1, label: 1, type: 9 },
              { name: "value", number: 2, label: 1, type: 5 },
            ],
          },
        ],
      },
    ],
  };
  const schema = normalizeSchema(descriptor);
  assert.equal(schema.messageMap.get("p.M").fieldsByNumber.get(2).typeKind, "map");

  const objectMessages = {
    messages: {
      M: {
        fields: {
          1: { name: "id", type: "string" },
          2: { name: "count", type: "int32" },
        },
      },
    },
  };
  const objectSchema = normalizeSchema(objectMessages);
  assert.equal(objectSchema.messageMap.get("M").fieldsByNumber.get(2).type, undefined);
  assert.equal(objectSchema.messageMap.get("M").fieldsByNumber.get(2).declaredType, "int32");
});

test("direction selection and boolean helper exports work", () => {
  const oldSchema = proto(`message M { int32 value = 1; }`);
  const newSchema = proto(`message M { string value = 1; }`);
  assert.equal(isBackwardCompatible(oldSchema, newSchema), false);
  assert.equal(isForwardCompatible(oldSchema, newSchema), false);
  assert.equal(isFullyCompatible(oldSchema, newSchema), false);

  const directional = compareSchemas(
    proto(`message M { int32 value = 1; }`),
    proto(`message M { repeated int32 value = 1; }`),
    "forward",
  );
  assert.equal(directional.compatible, false);
  assert.equal(directional.backwardCompatible, true);
  assert.equal(directional.compatibility, "backward");
});

test("strictJson can turn a rename into a breaking JSON/API change", () => {
  const report = compareSchemas(
    proto(`message M { string old_name = 1; }`),
    proto(`message M { string new_name = 1; }`),
    { strictJson: true },
  );
  assert.equal(report.compatible, false);
  assert.equal(report.wireCompatible, true);
  assert.equal(report.jsonCompatible, false);
  assert.equal(report.breakingChanges[0].code, "FIELD_RENAMED_SAME_NUMBER");
});
