#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace dataeng {

enum class ValueType { Null, Bool, Int64, Double, String, Struct, List, Map };

struct Value;
using ValuePtr = std::unique_ptr<Value>;

struct NamedField {
    std::string name;
    ValuePtr value;
};

struct MapPair {
    ValuePtr key;
    ValuePtr value;
};

struct Value {
    ValueType type = ValueType::Null;
    bool boolean = false;
    std::int64_t integer = 0;
    double real = 0.0;
    std::string text;
    std::vector<NamedField> fields;
    std::vector<ValuePtr> elements;
    std::vector<MapPair> pairs;

    static ValuePtr makeNull() { return std::make_unique<Value>(); }
    static ValuePtr makeBool(bool v) { auto p = std::make_unique<Value>(); p->type = ValueType::Bool; p->boolean = v; return p; }
    static ValuePtr makeInt(std::int64_t v) { auto p = std::make_unique<Value>(); p->type = ValueType::Int64; p->integer = v; return p; }
    static ValuePtr makeDouble(double v) { auto p = std::make_unique<Value>(); p->type = ValueType::Double; p->real = v; return p; }
    static ValuePtr makeString(std::string v) { auto p = std::make_unique<Value>(); p->type = ValueType::String; p->text = std::move(v); return p; }
    static ValuePtr makeStruct() { auto p = std::make_unique<Value>(); p->type = ValueType::Struct; return p; }
    static ValuePtr makeList() { auto p = std::make_unique<Value>(); p->type = ValueType::List; return p; }
    static ValuePtr makeMap() { auto p = std::make_unique<Value>(); p->type = ValueType::Map; return p; }

    ValuePtr clone() const {
        auto copy = std::make_unique<Value>();
        copy->type = type;
        copy->boolean = boolean;
        copy->integer = integer;
        copy->real = real;
        copy->text = text;
        copy->fields.reserve(fields.size());
        for (const auto& field : fields) {
            copy->fields.push_back(
                NamedField{field.name, field.value ? field.value->clone()
                                                   : nullptr});
        }
        copy->elements.reserve(elements.size());
        for (const auto& element : elements) {
            copy->elements.push_back(element ? element->clone() : nullptr);
        }
        copy->pairs.reserve(pairs.size());
        for (const auto& pair : pairs) {
            copy->pairs.push_back(MapPair{
                pair.key ? pair.key->clone() : nullptr,
                pair.value ? pair.value->clone() : nullptr});
        }
        return copy;
    }
};

inline bool isNull(const ValuePtr& p) { return !p || p->type == ValueType::Null; }
inline bool isNull(const Value* p) { return !p || p->type == ValueType::Null; }

void setField(Value& structValue, std::string name, ValuePtr value);
const Value* getField(const Value& structValue, const std::string& name);
ValuePtr* getFieldSlot(Value& structValue, const std::string& name);

bool valuesEqual(const ValuePtr& a, const ValuePtr& b);

}  // namespace dataeng
