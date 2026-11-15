#include "levels.hpp"

#include <sstream>
#include <utility>

namespace dataeng {

namespace {

const SchemaNode* nextOnPath(const std::vector<const SchemaNode*>& path,
                             const SchemaNode* node) {
    for (std::size_t i = 0; i + 1 < path.size(); ++i) {
        if (path[i] == node) {
            return path[i + 1];
        }
    }
    return nullptr;
}

}  // namespace

LevelEncoder::LevelEncoder(const Schema& schema, const SchemaNode& leaf)
    : root_(&schema.root()), leaf_(&leaf) {
    for (const SchemaNode* node = &leaf; node != nullptr; node = node->parent) {
        path_.insert(path_.begin(), node);
    }
    if (path_.empty() || path_.front() != root_) {
        throw std::invalid_argument("leaf does not belong to schema");
    }
}

EncodeStatus LevelEncoder::appendRow(const Value& rowValue) {
    emitted_ = false;
    EncodeStatus status = walk(*root_, &rowValue, 0);
    if (!status.ok) {
        return status;
    }
    if (!emitted_) {
        return EncodeStatus::failure("encoder produced no level entry for row");
    }
    return EncodeStatus::success();
}

EncodeStatus LevelEncoder::encodeColumn(const Schema& schema,
                                        const SchemaNode& leaf,
                                        const std::vector<ValuePtr>& rows,
                                        std::vector<LevelEntry>& out) {
    LevelEncoder encoder(schema, leaf);
    for (const auto& row : rows) {
        if (!row) {
            return EncodeStatus::failure("row value is null");
        }
        EncodeStatus status = encoder.appendRow(*row);
        if (!status.ok) {
            return status;
        }
    }
    out.insert(out.end(), std::make_move_iterator(encoder.output_.begin()),
               std::make_move_iterator(encoder.output_.end()));
    return EncodeStatus::success();
}

EncodeStatus LevelEncoder::walk(const SchemaNode& node, const Value* nodeValue,
                                int rep) {
    if (node.kind == NodeKind::Primitive) {
        if (node.repetition == Repetition::Repeated) {
            if (!nodeValue || nodeValue->type == ValueType::Null) {
                return EncodeStatus::failure(
                    "repeated field cannot be null, use an empty list");
            }
            if (nodeValue->type != ValueType::List) {
                return EncodeStatus::failure("repeated primitive expects a list");
            }
            if (nodeValue->elements.empty()) {
                output_.push_back(LevelEntry{rep, node.defLevel - 1, false,
                                             nullptr});
            }
            for (std::size_t i = 0; i < nodeValue->elements.size(); ++i) {
                const auto& element = nodeValue->elements[i];
                if (!element || element->type == ValueType::Null) {
                    return EncodeStatus::failure(
                        "repeated primitive element cannot be null");
                }
                output_.push_back(LevelEntry{
                    rep + (i == 0 ? 0 : 1), node.defLevel, true,
                    element->clone()});
            }
            emitted_ = true;
            return EncodeStatus::success();
        }

        if (!nodeValue || nodeValue->type == ValueType::Null) {
            if (node.repetition != Repetition::Optional) {
                return EncodeStatus::failure("null value for required primitive " +
                                             node.name);
            }
            output_.push_back(
                LevelEntry{rep, node.defLevel - 1, false, Value::makeNull()});
        } else {
            output_.push_back(LevelEntry{
                rep, node.defLevel, true,
                nodeValue->clone()});
        }
        emitted_ = true;
        return EncodeStatus::success();
    }

    if (node.repetition == Repetition::Optional &&
        (!nodeValue || nodeValue->type == ValueType::Null)) {
        int nullDef = (node.kind == NodeKind::List ||
                       node.kind == NodeKind::Map)
                          ? node.defLevel
                          : node.defLevel - 1;
        output_.push_back(
            LevelEntry{rep, nullDef, false, nullptr});
        emitted_ = true;
        return EncodeStatus::success();
    }

    if (node.repetition == Repetition::Required &&
        (!nodeValue || nodeValue->type == ValueType::Null)) {
        return EncodeStatus::failure("null value for required node " + node.name);
    }

    const SchemaNode* childNode = nextOnPath(path_, &node);
    if (!childNode) {
        return EncodeStatus::failure("schema path missing under " + node.name);
    }

    if (node.kind == NodeKind::Struct) {
        if (nodeValue->type != ValueType::Struct) {
            return EncodeStatus::failure("expected struct value for node " +
                                         node.name);
        }
        return walk(*childNode, getField(*nodeValue, childNode->name), rep);
    }

    if (node.kind == NodeKind::List) {
        if (nodeValue->type != ValueType::List) {
            return EncodeStatus::failure("expected list value for node " +
                                         node.name);
        }
        const SchemaNode& wrapper = *node.children.front();
        const SchemaNode& elementNode = *wrapper.children.front();
        if (nodeValue->elements.empty()) {
            output_.push_back(
                LevelEntry{rep, wrapper.defLevel, false, nullptr});
            emitted_ = true;
            return EncodeStatus::success();
        }
        for (std::size_t i = 0; i < nodeValue->elements.size(); ++i) {
            int childRep = (i == 0 ? rep : wrapper.repLevel);
            EncodeStatus status =
                walk(elementNode, nodeValue->elements[i].get(), childRep);
            if (!status.ok) {
                return status;
            }
        }
        return EncodeStatus::success();
    }

    if (node.kind == NodeKind::Map) {
        if (nodeValue->type != ValueType::Map) {
            return EncodeStatus::failure("expected map value for node " +
                                         node.name);
        }
        const SchemaNode& pairGroup = *node.children.front();
        const SchemaNode& keyNode = *pairGroup.children[0];
        const SchemaNode& valueNode = *pairGroup.children[1];
        if (nodeValue->pairs.empty()) {
            output_.push_back(
                LevelEntry{rep, pairGroup.defLevel, false, nullptr});
            emitted_ = true;
            return EncodeStatus::success();
        }
        bool keyColumn = false;
        for (const SchemaNode* candidate = leaf_; candidate;
             candidate = candidate->parent) {
            if (candidate == &keyNode) {
                keyColumn = true;
                break;
            }
            if (candidate == &valueNode) {
                break;
            }
        }
        for (std::size_t i = 0; i < nodeValue->pairs.size(); ++i) {
            int childRep = rep + (i == 0 ? 0 : 1);
            const auto& pair = nodeValue->pairs[i];
            if (keyColumn) {
                if (!pair.key || pair.key->type == ValueType::Null) {
                    return EncodeStatus::failure("map key cannot be null");
                }
                EncodeStatus status =
                    walk(keyNode, pair.key.get(), childRep);
                if (!status.ok) {
                    return status;
                }
            } else {
                EncodeStatus status =
                    walk(valueNode, pair.value.get(), childRep);
                if (!status.ok) {
                    return status;
                }
            }
        }
        return EncodeStatus::success();
    }

    return EncodeStatus::failure("unsupported schema node " + node.name);
}

LevelDecoder::LevelDecoder(const Schema& schema, const SchemaNode& leaf)
    : root_(&schema.root()), leaf_(&leaf) {
    for (const SchemaNode* node = &leaf; node != nullptr; node = node->parent) {
        path_.insert(path_.begin(), node);
    }
    if (path_.empty() || path_.front() != root_) {
        throw std::invalid_argument("leaf does not belong to schema");
    }
}

void LevelDecoder::reset() {
    stack_.clear();
    rows_.clear();
    currentRow_.reset();
    consumed_ = 0;
    pagesConsumed_ = 0;
    rowIndex_ = 0;
    failed_ = false;
}

std::vector<ValuePtr> LevelDecoder::takeRows() {
    if (currentRow_) {
        rows_.push_back(std::move(currentRow_));
        stack_.clear();
    }
    return std::move(rows_);
}

DecodeStatus LevelDecoder::fail(std::string message, std::size_t global,
                                std::size_t page, std::size_t inPage) {
    failed_ = true;
    return DecodeStatus::failure(std::move(message), global, page, inPage);
}

DecodeStatus LevelDecoder::feedPage(const LevelPage& page) {
    return feedPage(page.entries);
}

DecodeStatus LevelDecoder::feedPage(const std::vector<LevelEntry>& entries) {
    if (failed_) {
        return DecodeStatus::failure("decoder is in failed state", consumed_,
                                     pagesConsumed_, 0);
    }
    for (std::size_t i = 0; i < entries.size(); ++i) {
        DecodeStatus status = process(entries[i], consumed_, pagesConsumed_, i);
        if (!status.ok) {
            return status;
        }
        ++consumed_;
    }
    ++pagesConsumed_;
    return DecodeStatus::success();
}

DecodeStatus LevelDecoder::feedEntry(const LevelEntry& entry) {
    if (failed_) {
        return DecodeStatus::failure("decoder is in failed state", consumed_,
                                     pagesConsumed_, 0);
    }
    DecodeStatus status = process(entry, consumed_, pagesConsumed_, 0);
    if (status.ok) {
        ++consumed_;
    }
    return status;
}

void LevelDecoder::resetStackForRow() {
    stack_.clear();
    currentRow_ = Value::makeStruct();
    stack_.push_back(Frame{root_, Frame::StructField, currentRow_.get()});
    ++rowIndex_;
}

DecodeStatus LevelDecoder::process(const LevelEntry& entry, std::size_t global,
                                   std::size_t page, std::size_t inPage) {
    if (entry.repetition < 0 || entry.repetition > leaf_->repLevel) {
        return fail("repetition level " + std::to_string(entry.repetition) +
                        " exceeds leaf maximum " +
                        std::to_string(leaf_->repLevel),
                    global, page, inPage);
    }
    if (entry.definition < 0 || entry.definition > leaf_->defLevel) {
        return fail("definition level " + std::to_string(entry.definition) +
                        " exceeds leaf maximum " +
                        std::to_string(leaf_->defLevel),
                    global, page, inPage);
    }
    if (entry.definition < entry.repetition) {
        return fail("definition level below repetition level", global, page,
                    inPage);
    }
    if (entry.repetition > 0 && !currentRow_) {
        return fail("repetition level without an open record", global, page,
                    inPage);
    }
    if (entry.hasValue && entry.definition < leaf_->defLevel) {
        return fail("value present at definition level below leaf maximum",
                    global, page, inPage);
    }
    if (entry.hasValue &&
        (!entry.value || entry.value->type == ValueType::Null)) {
        return fail("entry marked with value but holds no primitive", global,
                    page, inPage);
    }

    bool explicitNull = !entry.hasValue && entry.value &&
                        entry.value->type == ValueType::Null;

    std::size_t startDepth = 1;
    if (entry.repetition == 0) {
        if (currentRow_) {
            rows_.push_back(std::move(currentRow_));
        }
        resetStackForRow();
    } else {
        const SchemaNode* restartNode = nullptr;
        for (std::size_t i = path_.size(); i-- > 0;) {
            if (path_[i]->isRepeated() &&
                path_[i]->repLevel == entry.repetition) {
                restartNode = path_[i];
                startDepth = i;
                break;
            }
        }
        if (!restartNode) {
            return fail(
                "repetition level does not match any open repeated node",
                global, page, inPage);
        }
        while (!stack_.empty() && stack_.back().node !=
                                      path_[startDepth - 1]) {
            stack_.pop_back();
        }
        if (stack_.empty()) {
            return fail("repetition level lost its enclosing frame", global,
                        page, inPage);
        }
    }

    auto attachToParent = [&](const SchemaNode* node, ValuePtr value) {
        Frame& parentFrame = stack_.back();
        if (parentFrame.role == Frame::ListElements || parentFrame.role == Frame::TransparentElement) {
            if (parentFrame.role == Frame::TransparentElement) {
                setField(*parentFrame.container, node->name, std::move(value));
                return;
            }
            parentFrame.container->elements.push_back(std::move(value));
        } else if (parentFrame.role == Frame::MapPairStruct) {
            auto& pair = parentFrame.container->pairs.back();
            if (node->name == "key") {
                pair.key = std::move(value);
            } else {
                pair.value = std::move(value);
            }
        } else {
            setField(*parentFrame.container, node->name, std::move(value));
        }
    };

    for (std::size_t depth = startDepth; depth < path_.size(); ++depth) {
        const SchemaNode* node = path_[depth];
        bool defined;
        if (node->kind == NodeKind::List || node->kind == NodeKind::Map) {
            defined = entry.definition >= node->defLevel + 1;
        } else {
            defined = entry.definition >= node->defLevel;
        }

        if (node->kind == NodeKind::Primitive) {
            if (node->repetition == Repetition::Repeated) {
                auto ensureList = [&]() -> Value* {
                    if (stack_.back().role == Frame::StructField) {
                        ValuePtr* slot = getFieldSlot(
                            *stack_.back().container, node->name);
                        if (slot && *slot) {
                            return slot->get();
                        }
                        attachToParent(node, Value::makeList());
                        return getFieldSlot(*stack_.back().container,
                                            node->name)
                            ->get();
                    }
                    if (stack_.back().role == Frame::ListElements) {
                        auto& elements =
                            stack_.back().container->elements;
                        if (!elements.empty() && elements.back() &&
                            elements.back()->type == ValueType::List) {
                            return elements.back().get();
                        }
                        auto list = Value::makeList();
                        Value* listPtr = list.get();
                        elements.push_back(std::move(list));
                        return listPtr;
                    }
                    auto& pair = stack_.back().container->pairs.back();
                    ValuePtr& target =
                        node->name == "key" ? pair.key : pair.value;
                    if (!target) {
                        target = Value::makeList();
                    }
                    return target.get();
                };

                if (!entry.hasValue && !explicitNull) {
                    if (entry.definition != node->defLevel - 1) {
                        return fail(
                            "repeated primitive sentinel at wrong definition "
                            "level",
                            global, page, inPage);
                    }
                    ensureList();
                    break;
                }
                if (entry.definition != node->defLevel) {
                    return fail(
                        "repeated primitive element at wrong definition level",
                        global, page, inPage);
                }
                if (!entry.hasValue) {
                    return fail("repeated primitive element cannot be null",
                                global, page, inPage);
                }
                Value* repeatedList = ensureList();
                repeatedList->elements.push_back(entry.value->clone());
                break;
            }

            if (entry.hasValue) {
                if (entry.definition != leaf_->defLevel) {
                    return fail(
                        "primitive value at non-maximum definition level",
                        global, page, inPage);
                }
                attachToParent(node, entry.value->clone());
            } else if (explicitNull) {
                if (node->repetition != Repetition::Optional) {
                    return fail("explicit null for non-optional primitive " +
                                    node->name,
                                global, page, inPage);
                }
                attachToParent(node, Value::makeNull());
            } else {
                if (node->repetition != Repetition::Optional ||
                    entry.definition != node->defLevel - 1) {
                    return fail(
                        "missing value for required primitive " + node->name,
                        global, page, inPage);
                }
                attachToParent(node, Value::makeNull());
            }
            break;
        }

        if (!defined) {
            if (!node->addsDefLevel()) {
                return fail(
                    "undefined definition level for node that cannot be null " +
                        node->name,
                    global, page, inPage);
            }
            const SchemaNode* parentNode = node->parent;
            bool wrapperOfContainer =
                parentNode && (parentNode->kind == NodeKind::List ||
                               parentNode->kind == NodeKind::Map);
            if (wrapperOfContainer &&
                (stack_.back().role == Frame::ListElements || stack_.back().role == Frame::MapPairs)) {
                break;
            }
            if (stack_.back().role == Frame::MapPairStruct) {
                auto& pair = stack_.back().container->pairs.back();
                if (node->name == "key") {
                    pair.key = Value::makeNull();
                } else {
                    pair.value = Value::makeNull();
                }
            } else if (stack_.back().role == Frame::ListElements) {
                stack_.back().container->elements.push_back(Value::makeNull());
            } else {
                setField(*stack_.back().container, node->name,
                         Value::makeNull());
            }
            break;
        }

        if (node->kind == NodeKind::Struct) {
            if (node->isRepeated() && !entry.hasValue && !explicitNull &&
                entry.definition == node->defLevel) {
                break;
            }
            const SchemaNode* parentNode = node->parent;
            if (parentNode && parentNode->kind == NodeKind::List) {
                const SchemaNode* innerNode = node->children.front().get();
                if (innerNode->kind == NodeKind::Primitive ||
                    innerNode->kind == NodeKind::List) {
                    stack_.push_back(
                        Frame{node, Frame::ListElements, stack_.back().container});
                } else {
                    ValuePtr elementStruct = Value::makeStruct();
                    Value* elementStructPtr = elementStruct.get();
                    stack_.back().container->elements.push_back(
                        std::move(elementStruct));
                    stack_.push_back(Frame{node, Frame::TransparentElement, elementStructPtr});
                }
            } else if (parentNode && parentNode->kind == NodeKind::Map) {
                Value* mapContainer = stack_.back().container;
                mapContainer->pairs.push_back(MapPair{nullptr, nullptr});
                stack_.push_back(Frame{node, Frame::MapPairStruct, mapContainer});
            } else if (stack_.back().role == Frame::TransparentElement) {
                Value* elementStructPtr = stack_.back().container;
                stack_.push_back(Frame{node, Frame::TransparentElement, elementStructPtr});
            } else {
                ValuePtr structValue = Value::makeStruct();
                Value* structPtr = structValue.get();
                attachToParent(node, std::move(structValue));
                stack_.push_back(Frame{node, Frame::StructField, structPtr});
            }
            continue;
        }

        if (node->kind == NodeKind::List) {
            ValuePtr listValue = Value::makeList();
            Value* listPtr = listValue.get();
            if (stack_.back().role == Frame::ListElements) {
                stack_.back().container->elements.push_back(
                    std::move(listValue));
            } else {
                attachToParent(node, std::move(listValue));
            }
            stack_.push_back(Frame{node, Frame::ListElements, listPtr});
            continue;
        }

        if (node->kind == NodeKind::Map) {
            ValuePtr mapValue = Value::makeMap();
            Value* mapPtr = mapValue.get();
            attachToParent(node, std::move(mapValue));
            stack_.push_back(Frame{node, Frame::MapPairs, mapPtr});
            continue;
        }
    }

    return DecodeStatus::success();
}

DecodeStatus LevelDecoder::finish() {
    if (failed_) {
        return DecodeStatus::failure("decoder is in failed state", consumed_,
                                     pagesConsumed_, 0);
    }
    if (currentRow_) {
        rows_.push_back(std::move(currentRow_));
        stack_.clear();
    }
    return DecodeStatus::success();
}

namespace {

DecodeStatus mergeValues(ValuePtr& target, ValuePtr incoming,
                         const std::string& context) {
    if (!incoming) {
        return DecodeStatus::success();
    }
    if (incoming->type == ValueType::Null) {
        if (!target) {
            target = std::move(incoming);
        }
        return DecodeStatus::success();
    }
    if (!target || target->type == ValueType::Null) {
        target = std::move(incoming);
        return DecodeStatus::success();
    }
    if (target->type != incoming->type) {
        return DecodeStatus::failure("type mismatch while merging " + context,
                                     0, 0, 0);
    }
    if (target->type == ValueType::Struct) {
        for (auto& incomingField : incoming->fields) {
            if (ValuePtr* slot = getFieldSlot(*target, incomingField.name)) {
                DecodeStatus status = mergeValues(
                    *slot, std::move(incomingField.value),
                    context + "." + incomingField.name);
                if (!status.ok) {
                    return status;
                }
            } else {
                target->fields.push_back(NamedField{
                    std::move(incomingField.name),
                    std::move(incomingField.value)});
            }
        }
        return DecodeStatus::success();
    }
    if (target->type == ValueType::List) {
        if (target->elements.size() != incoming->elements.size()) {
            return DecodeStatus::failure(
                "list length mismatch while merging " + context, 0, 0, 0);
        }
        for (std::size_t i = 0; i < target->elements.size(); ++i) {
            DecodeStatus status = mergeValues(
                target->elements[i], std::move(incoming->elements[i]),
                context + "[" + std::to_string(i) + "]");
            if (!status.ok) {
                return status;
            }
        }
        return DecodeStatus::success();
    }
    if (target->type == ValueType::Map) {
        if (target->pairs.size() != incoming->pairs.size()) {
            return DecodeStatus::failure(
                "map size mismatch while merging " + context, 0, 0, 0);
        }
        for (std::size_t i = 0; i < target->pairs.size(); ++i) {
            auto isBlank = [](const ValuePtr& p) {
                return !p || p->type == ValueType::Null;
            };
            if (isBlank(target->pairs[i].key) ||
                isBlank(incoming->pairs[i].key) ||
                isBlank(target->pairs[i].value) ||
                isBlank(incoming->pairs[i].value)) {
                if (!isBlank(incoming->pairs[i].key)) {
                    target->pairs[i].key =
                        std::move(incoming->pairs[i].key);
                }
                if (!isBlank(incoming->pairs[i].value)) {
                    target->pairs[i].value =
                        std::move(incoming->pairs[i].value);
                }
                continue;
            }
            DecodeStatus keyStatus = mergeValues(
                target->pairs[i].key, std::move(incoming->pairs[i].key),
                context + "{" + std::to_string(i) + "}.key");
            if (!keyStatus.ok) {
                return keyStatus;
            }
            DecodeStatus valueStatus = mergeValues(
                target->pairs[i].value, std::move(incoming->pairs[i].value),
                context + "{" + std::to_string(i) + "}.value");
            if (!valueStatus.ok) {
                return valueStatus;
            }
        }
        return DecodeStatus::success();
    }
    return DecodeStatus::failure("conflicting primitive values at " + context,
                                 0, 0, 0);
}

}  // namespace

RecordAssembler::RecordAssembler(const Schema& schema) : schema_(schema) {}

DecodeStatus RecordAssembler::appendColumn(
    const SchemaNode& leaf, const std::vector<ValuePtr>& leafRows) {
    std::vector<const SchemaNode*> path;
    for (const SchemaNode* node = &leaf; node != &schema_.root();
         node = node->parent) {
        if (!node) {
            return DecodeStatus::failure("leaf does not belong to schema", 0,
                                         0, 0);
        }
        path.insert(path.begin(), node);
    }

    if (records_.empty()) {
        records_.resize(leafRows.size());
    }
    if (records_.size() != leafRows.size()) {
        return DecodeStatus::failure(
            "column row count " + std::to_string(leafRows.size()) +
                " does not match record count " +
                std::to_string(records_.size()),
            0, 0, 0);
    }

    for (std::size_t row = 0; row < leafRows.size(); ++row) {
        ValuePtr incoming;
        if (leafRows[row]) {
            incoming = leafRows[row]->clone();
        }
        DecodeStatus status =
            mergeValues(records_[row], std::move(incoming), leaf.name);
        if (!status.ok) {
            status.globalIndex = row;
            return status;
        }
    }
    return DecodeStatus::success();
}

DecodeStatus RecordAssembler::appendColumn(
    const std::string& leafPathDot,
    const std::vector<ValuePtr>& leafRows) {
    const SchemaNode* leaf = schema_.findLeaf(leafPathDot);
    if (!leaf) {
        return DecodeStatus::failure("unknown leaf " + leafPathDot, 0, 0, 0);
    }
    return appendColumn(*leaf, leafRows);
}

std::vector<ValuePtr> RecordAssembler::takeRecords() {
    return std::move(records_);
}

std::string toString(const Value& value) {
    switch (value.type) {
        case ValueType::Null:
            return "null";
        case ValueType::Bool:
            return value.boolean ? "true" : "false";
        case ValueType::Int64:
            return std::to_string(value.integer);
        case ValueType::Double: {
            std::ostringstream out;
            out << value.real;
            return out.str();
        }
        case ValueType::String:
            return "\"" + value.text + "\"";
        case ValueType::Struct: {
            std::string result = "{";
            for (std::size_t i = 0; i < value.fields.size(); ++i) {
                if (i) {
                    result += ", ";
                }
                result += value.fields[i].name + ": ";
                if (value.fields[i].value) {
                    result += toString(*value.fields[i].value);
                } else {
                    result += "null";
                }
            }
            result += "}";
            return result;
        }
        case ValueType::List: {
            std::string result = "[";
            for (std::size_t i = 0; i < value.elements.size(); ++i) {
                if (i) {
                    result += ", ";
                }
                result += value.elements[i] ? toString(*value.elements[i])
                                             : "null";
            }
            result += "]";
            return result;
        }
        case ValueType::Map: {
            std::string result = "{";
            for (std::size_t i = 0; i < value.pairs.size(); ++i) {
                if (i) {
                    result += ", ";
                }
                result +=
                    (value.pairs[i].key ? toString(*value.pairs[i].key)
                                        : "null") +
                    "=" +
                    (value.pairs[i].value ? toString(*value.pairs[i].value)
                                          : "null");
            }
            result += "}";
            return result;
        }
    }
    return "";
}

}  // namespace dataeng
