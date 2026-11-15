#include "value.hpp"

namespace dataeng {

void setField(Value& structValue, std::string name, ValuePtr value) {
    if (auto* slot = getFieldSlot(structValue, name)) {
        *slot = std::move(value);
        return;
    }
    structValue.fields.push_back(NamedField{std::move(name), std::move(value)});
}

ValuePtr* getFieldSlot(Value& structValue, const std::string& name) {
    for (auto& field : structValue.fields) {
        if (field.name == name) {
            return &field.value;
        }
    }
    return nullptr;
}

const Value* getField(const Value& structValue, const std::string& name) {
    for (const auto& field : structValue.fields) {
        if (field.name == name) {
            return field.value.get();
        }
    }
    return nullptr;
}

bool valuesEqual(const ValuePtr& a, const ValuePtr& b) {
    if (isNull(a) || isNull(b)) {
        return isNull(a) && isNull(b);
    }
    if (a->type != b->type) {
        return false;
    }
    switch (a->type) {
        case ValueType::Null:
            return true;
        case ValueType::Bool:
            return a->boolean == b->boolean;
        case ValueType::Int64:
            return a->integer == b->integer;
        case ValueType::Double:
            return a->real == b->real;
        case ValueType::String:
            return a->text == b->text;
        case ValueType::Struct: {
            if (a->fields.size() != b->fields.size()) {
                return false;
            }
            for (std::size_t i = 0; i < a->fields.size(); ++i) {
                if (a->fields[i].name != b->fields[i].name) {
                    return false;
                }
                if (!valuesEqual(a->fields[i].value, b->fields[i].value)) {
                    return false;
                }
            }
            return true;
        }
        case ValueType::List: {
            if (a->elements.size() != b->elements.size()) {
                return false;
            }
            for (std::size_t i = 0; i < a->elements.size(); ++i) {
                if (!valuesEqual(a->elements[i], b->elements[i])) {
                    return false;
                }
            }
            return true;
        }
        case ValueType::Map: {
            if (a->pairs.size() != b->pairs.size()) {
                return false;
            }
            for (std::size_t i = 0; i < a->pairs.size(); ++i) {
                if (!valuesEqual(a->pairs[i].key, b->pairs[i].key)) {
                    return false;
                }
                if (!valuesEqual(a->pairs[i].value, b->pairs[i].value)) {
                    return false;
                }
            }
            return true;
        }
    }
    return false;
}

}  // namespace dataeng
