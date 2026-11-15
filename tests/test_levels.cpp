#include <algorithm>
#include <cassert>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <vector>

#include "levels.hpp"
#include "schema.hpp"
#include "value.hpp"

using namespace dataeng;

namespace {

int g_failures = 0;

#define CHECK(cond)                                                          \
    do {                                                                     \
        if (!(cond)) {                                                       \
            ++g_failures;                                                    \
            std::cerr << "CHECK failed: " << #cond << " at " << __FILE__     \
                      << ":" << __LINE__ << "\n";                            \
        }                                                                    \
    } while (0)

LevelEntry e(int r, int d) {
    return LevelEntry{r, d, false, nullptr};
}

LevelEntry en(int r, int d) {
    return LevelEntry{r, d, false, Value::makeNull()};
}

LevelEntry ei(int r, int d, std::int64_t v) {
    return LevelEntry{r, d, true, Value::makeInt(v)};
}

LevelEntry es(int r, int d, std::string v) {
    return LevelEntry{r, d, true, Value::makeString(std::move(v))};
}

bool sameEntries(const std::vector<LevelEntry>& a,
                 const std::vector<LevelEntry>& b) {
    if (a.size() != b.size()) {
        return false;
    }
    for (std::size_t i = 0; i < a.size(); ++i) {
        if (a[i].repetition != b[i].repetition ||
            a[i].definition != b[i].definition ||
            a[i].hasValue != b[i].hasValue) {
            return false;
        }
        if (a[i].hasValue &&
            (!a[i].value || !b[i].value ||
             a[i].value->type != b[i].value->type ||
             a[i].value->integer != b[i].value->integer ||
             a[i].value->text != b[i].value->text)) {
            return false;
        }
    }
    return true;
}

SchemaNodePtr documentBacklinkSchema() {
    auto backlink = Schema::makePrimitive("backlink", Repetition::Repeated,
                                          PrimType::Int64);
    return Schema::makeStruct("Document", Repetition::Required, {backlink});
}

}  // namespace

static void testSpecBacklinkReference() {
    Schema schema(documentBacklinkSchema());
    const SchemaNode* leaf = schema.findLeaf("Document.backlink");
    CHECK(leaf != nullptr);
    CHECK(leaf->maxRepLevel == 1);
    CHECK(leaf->maxDefLevel == 1);

    std::vector<LevelEntry> expected = {
        ei(0, 1, 10), ei(1, 1, 30), e(0, 0),
        ei(0, 1, 40),
    };

    LevelDecoder decoder(schema, *leaf);
    CHECK(decoder.feedPage(expected).ok);
    CHECK(decoder.finish().ok);

    const auto& rows = decoder.rows();
    CHECK(rows.size() == 3);
    const Value* row0List = getField(*rows[0], "backlink");
    CHECK(row0List && row0List->type == ValueType::List);
    CHECK(row0List->elements.size() == 2);
    CHECK(row0List->elements[0]->integer == 10);
    CHECK(row0List->elements[1]->integer == 30);
    const Value* row1List = getField(*rows[1], "backlink");
    CHECK(row1List && row1List->type == ValueType::List);
    CHECK(row1List->elements.empty());
    const Value* row2List = getField(*rows[2], "backlink");
    CHECK(row2List && row2List->type == ValueType::List);
    CHECK(row2List->elements.size() == 1);
    CHECK(row2List->elements[0]->integer == 40);

    std::vector<ValuePtr> input;
    for (const auto& row : rows) {
        input.push_back(row->clone());
    }
    std::vector<LevelEntry> encoded;
    CHECK(LevelEncoder::encodeColumn(schema, *leaf, input, encoded).ok);
    CHECK(sameEntries(encoded, expected));
}

static void testThreeLevelListNullEmptyNullElement() {
    auto names = Schema::makeList(
        "names", Repetition::Optional,
        Schema::makePrimitive("element", Repetition::Optional,
                              PrimType::String));
    Schema schema(Schema::makeStruct("Doc", Repetition::Required, {names}));
    const SchemaNode* leaf = schema.findLeaf("Doc.names.element.element");
    CHECK(leaf != nullptr);
    CHECK(leaf->maxRepLevel == 1);
    CHECK(leaf->maxDefLevel == 3);

    std::vector<LevelEntry> page = {
        es(0, 3, "a"), es(1, 3, "b"),
        e(0, 2),
        e(0, 1),
        es(0, 3, "x"), en(1, 2),
    };

    LevelDecoder decoder(schema, *leaf);
    CHECK(decoder.feedPage(page).ok);
    CHECK(decoder.finish().ok);
    const auto& rows = decoder.rows();
    CHECK(rows.size() == 4);

    const Value* present = getField(*rows[0], "names");
    CHECK(present && present->type == ValueType::List);
    CHECK(present->elements.size() == 2);
    CHECK(present->elements[0]->text == "a");

    const Value* emptyList = getField(*rows[1], "names");
    CHECK(emptyList && emptyList->type == ValueType::List);
    CHECK(emptyList->elements.empty());

    const Value* nullList = getField(*rows[2], "names");
    CHECK(isNull(nullList));

    const Value* nullElementList = getField(*rows[3], "names");
    CHECK(nullElementList && nullElementList->type == ValueType::List);
    CHECK(nullElementList->elements.size() == 2);
    CHECK(nullElementList->elements[0]->text == "x");
    CHECK(isNull(nullElementList->elements[1]));

    std::vector<ValuePtr> input;
    for (const auto& row : rows) {
        input.push_back(row->clone());
    }
    std::vector<LevelEntry> encoded;
    CHECK(LevelEncoder::encodeColumn(schema, *leaf, input, encoded).ok);
    CHECK(sameEntries(encoded, page));
}

static void testStructAndListOfStructs() {
    auto address = Schema::makeStruct(
        "address", Repetition::Optional,
        {Schema::makePrimitive("city", Repetition::Optional,
                               PrimType::String)});
    auto tags = Schema::makeList(
        "tags", Repetition::Optional,
        Schema::makeStruct(
            "element", Repetition::Required,
            {Schema::makePrimitive("label", Repetition::Optional,
                                   PrimType::String)}));
    Schema schema(Schema::makeStruct(
        "Profile", Repetition::Required, {address, tags}));
    const SchemaNode* city = schema.findLeaf("Profile.address.city");
    const SchemaNode* label =
        schema.findLeaf("Profile.tags.element.element.label");
    CHECK(city && label);

    std::vector<LevelEntry> cityPage = {
        es(0, 2, "Beijing"), e(0, 1), e(0, 0),
    };
    LevelDecoder cityDecoder(schema, *city);
    CHECK(cityDecoder.feedPage(cityPage).ok);
    CHECK(cityDecoder.finish().ok);
    const auto& cityRows = cityDecoder.rows();
    CHECK(getField(*cityRows[0], "address")->fields[0].value->text ==
          "Beijing");
    const Value* partialAddress = getField(*cityRows[1], "address");
    CHECK(partialAddress && partialAddress->type == ValueType::Struct);
    CHECK(isNull(getField(*partialAddress, "city")));
    CHECK(isNull(getField(*cityRows[2], "address")));

    std::vector<LevelEntry> labelPage = {
        e(0, 2),
        es(0, 3, "hot"), es(1, 3, "new"),
        en(0, 3),
    };
    LevelDecoder labelDecoder(schema, *label);
    CHECK(labelDecoder.feedPage(labelPage).ok);
    CHECK(labelDecoder.finish().ok);
    const auto& labelRows = labelDecoder.rows();
    const Value* empty = getField(*labelRows[0], "tags");
    CHECK(empty && empty->type == ValueType::List &&
          empty->elements.empty());
    const Value* two = getField(*labelRows[1], "tags");
    CHECK(two && two->elements.size() == 2);
    CHECK(getField(*two->elements[0], "label")->text == "hot");
    const Value* nullTag = getField(*labelRows[2], "tags");
    CHECK(nullTag && nullTag->elements.size() == 1);
    CHECK(isNull(getField(*nullTag->elements[0], "label")));
}

static void testMapNullEmptyAndNullValue() {
    auto key = Schema::makePrimitive("key", Repetition::Required,
                                     PrimType::String);
    auto value = Schema::makePrimitive("value", Repetition::Optional,
                                       PrimType::Int64);
    auto mapping =
        Schema::makeMap("mapping", Repetition::Optional, key, value);
    Schema schema(
        Schema::makeStruct("Doc", Repetition::Required, {mapping}));
    const SchemaNode* keyLeaf = schema.findLeaf("Doc.mapping.key_value.key");
    const SchemaNode* valueLeaf =
        schema.findLeaf("Doc.mapping.key_value.value");
    CHECK(keyLeaf && valueLeaf);
    CHECK(keyLeaf->maxDefLevel == 2);
    CHECK(valueLeaf->maxDefLevel == 3);

    std::vector<LevelEntry> keyPage = {
        es(0, 2, "a"), es(1, 2, "b"), e(0, 2), e(0, 1),
    };
    std::vector<LevelEntry> valuePage = {
        ei(0, 3, 1), en(1, 2), e(0, 2), e(0, 1),
    };

    LevelDecoder keyDecoder(schema, *keyLeaf);
    CHECK(keyDecoder.feedPage(keyPage).ok);
    CHECK(keyDecoder.finish().ok);
    LevelDecoder valueDecoder(schema, *valueLeaf);
    CHECK(valueDecoder.feedPage(valuePage).ok);
    CHECK(valueDecoder.finish().ok);

    RecordAssembler assembler(schema);
    CHECK(assembler.appendColumn(*keyLeaf, keyDecoder.rows()).ok);
    CHECK(assembler.appendColumn(*valueLeaf, valueDecoder.rows()).ok);
    auto records = assembler.takeRecords();
    CHECK(records.size() == 3);

    const Value* populated = getField(*records[0], "mapping");
    CHECK(populated && populated->type == ValueType::Map);
    CHECK(populated->pairs.size() == 2);
    CHECK(populated->pairs[0].key->text == "a");
    CHECK(populated->pairs[0].value->integer == 1);
    CHECK(populated->pairs[1].key->text == "b");
    CHECK(isNull(populated->pairs[1].value));

    const Value* emptyMap = getField(*records[1], "mapping");
    CHECK(emptyMap && emptyMap->type == ValueType::Map);
    CHECK(emptyMap->pairs.empty());

    const Value* nullMap = getField(*records[2], "mapping");
    CHECK(isNull(nullMap));

    std::vector<ValuePtr> keyInput;
    std::vector<ValuePtr> valueInput;
    for (const auto& record : records) {
        keyInput.push_back(record->clone());
        valueInput.push_back(record->clone());
    }
    std::vector<LevelEntry> encodedKeys;
    std::vector<LevelEntry> encodedValues;
    CHECK(LevelEncoder::encodeColumn(schema, *keyLeaf, keyInput,
                                     encodedKeys)
              .ok);
    CHECK(LevelEncoder::encodeColumn(schema, *valueLeaf, valueInput,
                                     encodedValues)
              .ok);
    CHECK(sameEntries(encodedKeys, keyPage));
    CHECK(sameEntries(encodedValues, valuePage));
}

static void testCrossPageStateAndEarliestError() {
    Schema schema(documentBacklinkSchema());
    const SchemaNode* leaf = schema.findLeaf("Document.backlink");

    LevelDecoder decoder(schema, *leaf);
    LevelPage first;
    first.entries = {ei(0, 1, 1), ei(1, 1, 2)};
    LevelPage second;
    second.entries = {ei(1, 1, 3), ei(0, 1, 9)};
    CHECK(decoder.feedPage(first).ok);
    CHECK(decoder.pagesConsumed() == 1);
    CHECK(decoder.entriesConsumed() == 2);
    CHECK(decoder.feedPage(second).ok);
    CHECK(decoder.finish().ok);
    const auto& rows = decoder.rows();
    CHECK(rows.size() == 2);
    CHECK(getField(*rows[0], "backlink")->elements.size() == 3);
    CHECK(getField(*rows[1], "backlink")->elements.size() == 1);

    LevelDecoder bad(schema, *leaf);
    DecodeStatus badStatus = bad.feedPage(std::vector<LevelEntry>{
        ei(0, 1, 1), LevelEntry{2, 1, true, Value::makeInt(7)}});
    CHECK(!badStatus.ok);
    CHECK(badStatus.globalIndex == 1);
    CHECK(badStatus.pageIndex == 0);
    CHECK(badStatus.indexInPage == 1);

    LevelDecoder badDef(schema, *leaf);
    DecodeStatus defStatus = badDef.feedPage(
        std::vector<LevelEntry>{LevelEntry{0, 5, false, nullptr}});
    CHECK(!defStatus.ok);
    CHECK(defStatus.globalIndex == 0);

    LevelDecoder orphan(schema, *leaf);
    DecodeStatus orphanStatus = orphan.feedPage(
        std::vector<LevelEntry>{LevelEntry{1, 1, false, nullptr}});
    CHECK(!orphanStatus.ok);
    CHECK(orphanStatus.globalIndex == 0);

    LevelDecoder pages(schema, *leaf);
    CHECK(pages.feedPage(std::vector<LevelEntry>{ei(0, 1, 1)}).ok);
    DecodeStatus secondPageStatus = pages.feedPage(
        std::vector<LevelEntry>{LevelEntry{5, 1, false, nullptr}});
    CHECK(!secondPageStatus.ok);
    CHECK(secondPageStatus.pageIndex == 1);
    CHECK(secondPageStatus.indexInPage == 0);
    CHECK(secondPageStatus.globalIndex == 1);
}

static void testInvalidDefinitionAndValueMismatch() {
    auto names = Schema::makeList(
        "names", Repetition::Optional,
        Schema::makePrimitive("element", Repetition::Optional,
                              PrimType::String));
    Schema schema(Schema::makeStruct("Doc", Repetition::Required, {names}));
    const SchemaNode* leaf = schema.findLeaf("Doc.names.element.element");

    LevelDecoder below(schema, *leaf);
    DecodeStatus belowStatus = below.feedPage(
        std::vector<LevelEntry>{LevelEntry{1, 0, false, nullptr}});
    CHECK(!belowStatus.ok);
    CHECK(belowStatus.globalIndex == 0);

    LevelDecoder valueAtLowDef(schema, *leaf);
    DecodeStatus valueStatus = valueAtLowDef.feedPage(
        std::vector<LevelEntry>{LevelEntry{0, 1, true, Value::makeString("z")}});
    CHECK(!valueStatus.ok);

    Schema requiredSchema(Schema::makeStruct(
        "Doc", Repetition::Required,
        {Schema::makePrimitive("id", Repetition::Required,
                               PrimType::Int64)}));
    const SchemaNode* requiredLeaf =
        requiredSchema.findLeaf("Doc.id");
    LevelDecoder requiredNull(requiredSchema, *requiredLeaf);
    DecodeStatus requiredStatus = requiredNull.feedPage(
        std::vector<LevelEntry>{LevelEntry{0, 0, false, nullptr}});
    CHECK(!requiredStatus.ok);
}

static void testNestedListsRoundTrip() {
    auto inner = Schema::makeList(
        "inner", Repetition::Required,
        Schema::makePrimitive("element", Repetition::Required,
                              PrimType::Int64));
    auto outer = Schema::makeList("outer", Repetition::Optional, inner);
    Schema schema(Schema::makeStruct("Doc", Repetition::Required, {outer}));
    const SchemaNode* leaf = schema.findLeaf(
        "Doc.outer.element.inner.element.element");
    CHECK(leaf);
    CHECK(leaf->maxRepLevel == 2);

    auto row = Value::makeStruct();
    auto outerList = Value::makeList();
    auto firstInner = Value::makeList();
    firstInner->elements.push_back(Value::makeInt(1));
    firstInner->elements.push_back(Value::makeInt(2));
    auto secondInner = Value::makeList();
    secondInner->elements.push_back(Value::makeInt(3));
    outerList->elements.push_back(std::move(firstInner));
    outerList->elements.push_back(std::move(secondInner));
    setField(*row, "outer", std::move(outerList));

    LevelEncoder encoder(schema, *leaf);
    CHECK(encoder.appendRow(*row).ok);
    const auto& encoded = encoder.output();
    std::vector<LevelEntry> expected = {
        ei(0, 3, 1), ei(2, 3, 2), ei(1, 3, 3),
    };
    CHECK(sameEntries(encoded, expected));

    LevelDecoder decoder(schema, *leaf);
    CHECK(decoder.feedPage(encoded).ok);
    CHECK(decoder.finish().ok);
    const auto& rows = decoder.rows();
    CHECK(rows.size() == 1);
    const Value* decodedOuter = getField(*rows[0], "outer");
    CHECK(decodedOuter && decodedOuter->type == ValueType::List);
    CHECK(decodedOuter->elements.size() == 2);
    const Value* decodedFirstInner = decodedOuter->elements[0].get();
    CHECK(decodedFirstInner->type == ValueType::List);
    CHECK(decodedFirstInner->elements.size() == 2);
    CHECK(decodedFirstInner->elements[1]->integer == 2);
    const Value* decodedSecondInner = decodedOuter->elements[1].get();
    CHECK(decodedSecondInner->elements.size() == 1);
    CHECK(decodedSecondInner->elements[0]->integer == 3);

    std::vector<ValuePtr> againInput;
    againInput.emplace_back(rows[0]->clone());
    std::vector<LevelEntry> again;
    CHECK(LevelEncoder::encodeColumn(schema, *leaf, againInput, again).ok);
    CHECK(sameEntries(again, expected));
}

static void testEncoderRejectsInvalidValues() {
    Schema schema(documentBacklinkSchema());
    const SchemaNode* leaf = schema.findLeaf("Document.backlink");

    auto badNullRow = Value::makeStruct();
    setField(*badNullRow, "backlink", Value::makeNull());
    {
        LevelEncoder encoder(schema, *leaf);
        CHECK(!encoder.appendRow(*badNullRow).ok);
    }

    auto badElementRow = Value::makeStruct();
    auto badList = Value::makeList();
    badList->elements.push_back(Value::makeNull());
    setField(*badNullRow, "backlink", std::move(badList));
    {
        LevelEncoder encoder(schema, *leaf);
        CHECK(!encoder.appendRow(*badNullRow).ok);
    }

    auto key = Schema::makePrimitive("key", Repetition::Required,
                                     PrimType::String);
    auto value = Schema::makePrimitive("value", Repetition::Required,
                                       PrimType::String);
    Schema mapSchema(Schema::makeStruct(
        "Doc", Repetition::Required,
        {Schema::makeMap("mapping", Repetition::Optional, key, value)}));
    const SchemaNode* keyLeaf =
        mapSchema.findLeaf("Doc.mapping.key_value.key");
    auto mapRow = Value::makeStruct();
    auto mapValue = Value::makeMap();
    mapValue->pairs.push_back(MapPair{Value::makeNull(), Value::makeString("v")});
    setField(*mapRow, "mapping", std::move(mapValue));
    LevelEncoder mapEncoder(mapSchema, *keyLeaf);
    CHECK(!mapEncoder.appendRow(*mapRow).ok);
}

static ValuePtr makeRandomValue(const SchemaNode& node, unsigned& seed,
                                int depth);

static ValuePtr makeRandomPrimitive(PrimType type, unsigned& seed) {
    seed = seed * 1103515245u + 12345u;
    switch (type) {
        case PrimType::Boolean:
            return Value::makeBool((seed >> 16) % 2);
        case PrimType::Int64:
            return Value::makeInt(static_cast<std::int64_t>(seed % 1000));
        case PrimType::Double:
            return Value::makeDouble((seed % 1000) / 3.0);
        case PrimType::String:
            return Value::makeString("s" + std::to_string(seed % 50));
    }
    return Value::makeNull();
}

static ValuePtr makeRandomValue(const SchemaNode& node, unsigned& seed,
                                int depth) {
    seed = seed * 1103515245u + 12345u;
    if (node.isOptional() && depth > 0 && (seed % 5) == 0) {
        return Value::makeNull();
    }

    if (node.kind == NodeKind::Primitive) {
        if (node.repetition == Repetition::Repeated) {
            auto list = Value::makeList();
            seed = seed * 1103515245u + 12345u;
            std::size_t count = seed % 4;
            for (std::size_t i = 0; i < count; ++i) {
                list->elements.push_back(
                    makeRandomPrimitive(node.primitive, seed));
            }
            return list;
        }
        return makeRandomPrimitive(node.primitive, seed);
    }

    if (node.kind == NodeKind::Struct) {
        auto structValue = Value::makeStruct();
        for (const auto& child : node.children) {
            setField(*structValue, child->name,
                     makeRandomValue(*child, seed, depth + 1));
        }
        return structValue;
    }

    if (node.kind == NodeKind::List) {
        auto list = Value::makeList();
        const SchemaNode& element = *node.children.front()->children.front();
        seed = seed * 1103515245u + 12345u;
        std::size_t count = seed % 4;
        for (std::size_t i = 0; i < count; ++i) {
            list->elements.push_back(makeRandomValue(element, seed, depth + 1));
        }
        return list;
    }

    if (node.kind == NodeKind::Map) {
        auto mapValue = Value::makeMap();
        const SchemaNode& keyNode = *node.children.front()->children[0];
        const SchemaNode& valueNode = *node.children.front()->children[1];
        seed = seed * 1103515245u + 12345u;
        std::size_t count = seed % 4;
        for (std::size_t i = 0; i < count; ++i) {
            mapValue->pairs.push_back(MapPair{
                makeRandomPrimitive(keyNode.primitive, seed),
                makeRandomValue(valueNode, seed, depth + 1)});
        }
        return mapValue;
    }

    return Value::makeNull();
}

static void testRandomRoundTripAcrossPages() {
    auto address = Schema::makeStruct(
        "address", Repetition::Optional,
        {Schema::makePrimitive("city", Repetition::Optional,
                               PrimType::String)});
    auto scores = Schema::makeList(
        "scores", Repetition::Optional,
        Schema::makePrimitive("element", Repetition::Required,
                              PrimType::Int64));
    auto tags = Schema::makeList(
        "tags", Repetition::Optional,
        Schema::makeStruct(
            "element", Repetition::Required,
            {Schema::makePrimitive("label", Repetition::Optional,
                                   PrimType::String)}));
    auto mapping = Schema::makeMap(
        "props", Repetition::Optional,
        Schema::makePrimitive("key", Repetition::Required, PrimType::String),
        Schema::makePrimitive("value", Repetition::Optional,
                              PrimType::String));
    Schema schema(Schema::makeStruct(
        "Root", Repetition::Required,
        {address, scores, tags, mapping}));

    unsigned seed = 20261116u;
    constexpr std::size_t rowCount = 60;
    std::vector<ValuePtr> rows;
    for (std::size_t i = 0; i < rowCount; ++i) {
        rows.push_back(makeRandomValue(schema.root(), seed, 0));
    }

    for (const SchemaNode* leaf : schema.leaves()) {
        std::vector<LevelEntry> encoded;
        EncodeStatus enc =
            LevelEncoder::encodeColumn(schema, *leaf, rows, encoded);
        CHECK(enc.ok);

        LevelDecoder decoder(schema, *leaf);
        for (std::size_t offset = 0; offset < encoded.size();) {
            std::size_t chunk = 1 + (offset % 3);
            std::size_t end = std::min(offset + chunk, encoded.size());
            std::vector<LevelEntry> page(
                std::make_move_iterator(encoded.begin() +
                                        static_cast<long>(offset)),
                std::make_move_iterator(encoded.begin() +
                                        static_cast<long>(end)));
            CHECK(decoder.feedPage(page).ok);
            offset = end;
        }
        CHECK(decoder.finish().ok);
        const auto& decodedRows = decoder.rows();
        CHECK(decodedRows.size() == rowCount);

        for (std::size_t row = 0; row < rowCount; ++row) {
            const Value* expectedField =
                getField(*rows[row], leaf->name);
            const Value* decodedField =
                getField(*decodedRows[row], leaf->name);
            CHECK((expectedField == nullptr) == (decodedField == nullptr));
            if (expectedField && decodedField) {
                CHECK(valuesEqual(expectedField->clone(),
                                  decodedField->clone()));
            }
        }
    }
}

int main() {
    testSpecBacklinkReference();
    testThreeLevelListNullEmptyNullElement();
    testStructAndListOfStructs();
    testMapNullEmptyAndNullValue();
    testCrossPageStateAndEarliestError();
    testInvalidDefinitionAndValueMismatch();
    testNestedListsRoundTrip();
    testEncoderRejectsInvalidValues();
    testRandomRoundTripAcrossPages();

    if (g_failures == 0) {
        std::cout << "all dataeng tests passed\n";
        return EXIT_SUCCESS;
    }
    std::cerr << g_failures << " test failures\n";
    return EXIT_FAILURE;
}
