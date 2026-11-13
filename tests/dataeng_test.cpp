#include "dataeng.hpp"

#include <cstdint>
#include <functional>
#include <iostream>
#include <random>
#include <string>
#include <utility>
#include <vector>

namespace {

using dataeng::Column;
using dataeng::DecodeError;
using dataeng::Presence;
using dataeng::PrimitiveType;
using dataeng::SchemaNode;
using dataeng::Value;

int failures = 0;

void check(bool condition, const char* expression, const char* file, int line) {
  if (condition) {
    return;
  }
  std::cerr << file << ':' << line << ": check failed: " << expression
            << '\n';
  ++failures;
}

#define CHECK(expression) check((expression), #expression, __FILE__, __LINE__)

template <typename Function>
void expect_decode_error(Function&& function, std::size_t position,
                         const char* file, int line) {
  try {
    function();
  } catch (const DecodeError& error) {
    if (error.position() != position) {
      std::cerr << file << ':' << line << ": expected error position "
                << position << ", got " << error.position() << ": "
                << error.what() << '\n';
      ++failures;
    }
    return;
  } catch (const std::exception& error) {
    std::cerr << file << ':' << line
              << ": expected dataeng::DecodeError, got another exception: "
              << error.what() << '\n';
    ++failures;
    return;
  }
  std::cerr << file << ':' << line << ": expected dataeng::DecodeError\n";
  ++failures;
}

#define EXPECT_DECODE_ERROR(expression, position) \
  expect_decode_error([&] { expression; }, position, __FILE__, __LINE__)

void check_equal(const Value& actual, const Value& expected, const char* file,
                 int line) {
  if (actual == expected) {
    return;
  }
  std::cerr << file << ':' << line << ": decoded value differs from input\n";
  ++failures;
}

#define CHECK_EQUAL(actual, expected) \
  check_equal((actual), (expected), __FILE__, __LINE__)

SchemaNode flat_optional_int() {
  return SchemaNode::root(
      "root", {SchemaNode::optional_primitive("x", PrimitiveType::Int32)});
}

SchemaNode optional_list_of_optional_int() {
  return SchemaNode::root(
      "root",
      {SchemaNode::optional_list(
          "items",
          SchemaNode::optional_primitive("element", PrimitiveType::Int32))});
}

SchemaNode nested_optional_lists() {
  return SchemaNode::root(
      "root",
      {SchemaNode::optional_list(
          "outer",
          SchemaNode::optional_list(
              "element",
              SchemaNode::optional_primitive("element",
                                            PrimitiveType::Int32)))});
}

SchemaNode list_of_optional_structs() {
  return SchemaNode::root(
      "root",
      {SchemaNode::optional_list(
          "items",
          SchemaNode::optional_group(
              "element",
              {SchemaNode::optional_primitive("a", PrimitiveType::Int32),
               SchemaNode::optional_primitive("b", PrimitiveType::String)}))});
}

SchemaNode optional_struct() {
  return SchemaNode::root(
      "root",
      {SchemaNode::optional_group(
          "s", {SchemaNode::optional_primitive("a", PrimitiveType::Int32),
                SchemaNode::optional_primitive("b", PrimitiveType::String)})});
}

SchemaNode complex_nested_schema() {
  return SchemaNode::root(
      "root",
      {SchemaNode::optional_group(
          "s",
          {SchemaNode::optional_list(
               "items",
               SchemaNode::optional_group(
                   "element",
                   {SchemaNode::optional_primitive(
                        "a", PrimitiveType::Int32),
                    SchemaNode::optional_list(
                        "tags",
                        SchemaNode::optional_primitive(
                            "element", PrimitiveType::String))})),
           SchemaNode::optional_primitive("note", PrimitiveType::String)})});
}

Value object(std::initializer_list<std::pair<const std::string, Value>> fields) {
  Value result = Value::object();
  for (const auto& field : fields) {
    result.as_object().insert(field);
  }
  return result;
}

void test_levels_and_distinction() {
  const SchemaNode schema = optional_list_of_optional_int();
  const std::vector<Value> rows = {
      object({{"items", Value::null()}}),
      object({{"items", Value::list()}}),
      object({{"items", Value::list({Value::null()})}}),
      object({{"items", Value::list({Value(std::int32_t{7})})}}),
      object({{"items",
               Value::list({Value::null(), Value(std::int32_t{8})})}}),
  };

  const std::vector<Column> columns = dataeng::encode(schema, rows);
  CHECK(columns.size() == 1);
  CHECK(columns[0].repetition_levels ==
        std::vector<int>({0, 0, 0, 0, 0, 1}));
  CHECK(columns[0].definition_levels == std::vector<int>({0, 1, 2, 3, 2, 3}));
  CHECK(columns[0].values ==
        std::vector<Value>({Value(std::int32_t{7}),
                            Value(std::int32_t{8})}));

  const std::vector<Value> decoded = dataeng::decode(schema, columns);
  CHECK_EQUAL(decoded, rows);
  CHECK(decoded[0].as_object().at("items").is_null());
  CHECK(decoded[1].as_object().at("items").is_array());
  CHECK(decoded[1].as_object().at("items").as_array().empty());
  CHECK(decoded[2].as_object().at("items").as_array().front().is_null());
}

void test_nested_lists() {
  const SchemaNode schema = nested_optional_lists();
  const std::vector<Value> rows = {
      object({{"outer", Value::null()}}),
      object({{"outer", Value::list()}}),
      object({{"outer", Value::list({Value::null()})}}),
      object({{"outer", Value::list({Value::list()})}}),
      object({{"outer", Value::list({Value::list({Value::null()})})}}),
      object({{"outer",
               Value::list({Value::list(
                   {Value(std::int32_t{1}), Value(std::int32_t{2})})})}}),
      object({{"outer",
               Value::list(
                   {Value::list({Value(std::int32_t{3})}),
                    Value::list({Value(std::int32_t{4}), Value::null()})})}}),
  };

  const std::vector<Column> columns = dataeng::encode(schema, rows);
  CHECK(columns.size() == 1);
  CHECK(columns[0].repetition_levels ==
        std::vector<int>({0, 0, 0, 0, 0, 0, 2, 0, 1, 2}));
  CHECK(columns[0].definition_levels ==
        std::vector<int>({0, 1, 2, 3, 4, 5, 5, 5, 5, 4}));
  CHECK_EQUAL(dataeng::decode(schema, columns), rows);
}

void test_struct_assembly() {
  const SchemaNode schema = list_of_optional_structs();
  const std::vector<Value> rows = {
      object({{"items", Value::null()}}),
      object({{"items", Value::list()}}),
      object({{"items", Value::list({Value::null()})}}),
      object({{"items",
               Value::list({object({{"a", Value::null()},
                                     {"b", Value::null()}})})}}),
      object({{"items",
               Value::list(
                   {Value::null(),
                    object({{"a", Value(std::int32_t{9})},
                             {"b", Value(std::string("nine"))}})})}}),
  };

  const std::vector<Column> columns = dataeng::encode(schema, rows);
  CHECK(columns.size() == 2);
  const std::vector<Value> decoded = dataeng::decode(schema, columns);
  CHECK_EQUAL(decoded, rows);

  // Project only the `a` column: the other struct field is omitted rather
  // than invented as a null.
  const std::vector<Value> projected =
      dataeng::decode(schema, std::vector<Column>({columns[0]}));
  CHECK(projected.size() == rows.size());
  CHECK(projected[4].as_object().at("items").as_array()[1]
            .as_object()
            .at("a") == Value(std::int32_t{9}));
  CHECK(projected[4].as_object().at("items").as_array()[1]
            .as_object()
            .count("b") == 0);

  Column alias_column = columns[0];
  alias_column.path = {"items", "a"};
  CHECK_EQUAL(dataeng::decode(schema, {alias_column}), projected);
}

void test_complex_nested_assembly() {
  const SchemaNode schema = complex_nested_schema();
  const std::vector<Value> rows = {
      object({{"s", Value::null()}}),
      object({{"s", object({{"items", Value::null()},
                            {"note", Value::null()}})}}),
      object({{"s", object({{"items", Value::list()},
                            {"note", Value(std::string())}})}}),
      object({{"s", object({{"items", Value::list({Value::null()})},
                            {"note", Value::null()}})}}),
      object({{"s",
               object({{"items",
                        Value::list({object({{"a", Value::null()},
                                             {"tags", Value::null()}})})},
                       {"note", Value(std::string("n1"))}})}}),
      object({{"s",
               object({{"items",
                        Value::list({object({{"a", Value(std::int32_t{1})},
                                             {"tags", Value::list()}})})},
                       {"note", Value::null()}})}}),
      object({{"s",
               object(
                   {{"items",
                     Value::list(
                         {object({{"a", Value(std::int32_t{2})},
                                  {"tags",
                                   Value::list({Value(std::string()),
                                                Value(std::string("x"))})}}),
                          object({{"a", Value::null()},
                                  {"tags",
                                   Value::list({Value::null()})}})})},
                    {"note", Value(std::string("n2"))}})}}),
  };

  const std::vector<Column> columns = dataeng::encode(schema, rows);
  CHECK(columns.size() == 3);
  const std::vector<Value> decoded = dataeng::decode(schema, columns);
  CHECK_EQUAL(decoded, rows);
  CHECK(decoded[2].as_object().at("s").as_object().at("note") ==
        Value(std::string()));
  CHECK(decoded[3].as_object().at("s").as_object().at("items")
            .as_array()
            .front()
            .is_null());
}

void test_required_container() {
  const SchemaNode schema = SchemaNode::root(
      "root",
      {SchemaNode::required_list(
          "numbers", SchemaNode::required_primitive("element",
                                                    PrimitiveType::Int32))});
  const std::vector<Value> rows = {
      object({{"numbers", Value::list()}}),
      object({{"numbers", Value::list({Value(std::int32_t{0})})}}),
      object({{"numbers", Value::list({Value(std::int32_t{1}),
                                       Value(std::int32_t{2})})}}),
  };
  const std::vector<Column> columns = dataeng::encode(schema, rows);
  CHECK(columns[0].definition_levels == std::vector<int>({0, 1, 1, 1}));
  CHECK(columns[0].repetition_levels == std::vector<int>({0, 0, 0, 1}));
  CHECK_EQUAL(dataeng::decode(schema, columns), rows);
}

std::vector<Value> enumerate_node(const SchemaNode& node,
                                  std::size_t max_list_length) {
  std::vector<Value> result;
  if (node.kind == dataeng::SchemaKind::Primitive) {
    switch (node.primitive_type) {
      case PrimitiveType::Boolean:
        result = {Value(false), Value(true)};
        break;
      case PrimitiveType::Int32:
      case PrimitiveType::Int64:
        result = {Value(std::int32_t{0}), Value(std::int32_t{1})};
        break;
      case PrimitiveType::UInt64:
        result = {Value(std::uint64_t{0}), Value(std::uint64_t{1})};
        break;
      case PrimitiveType::Float:
      case PrimitiveType::Double:
        result = {Value(0.0), Value(1.0)};
        break;
      case PrimitiveType::String:
      case PrimitiveType::Binary:
        result = {Value(std::string()), Value(std::string("v"))};
        break;
    }
    if (node.presence == Presence::Optional) {
      result.insert(result.begin(), Value::null());
    }
    return result;
  }

  if (node.kind == dataeng::SchemaKind::Struct) {
    std::vector<Value> objects = {Value::object()};
    for (const SchemaNode& child : node.children) {
      const std::vector<Value> domain = enumerate_node(child, max_list_length);
      std::vector<Value> expanded;
      for (const Value& base : objects) {
        for (const Value& field_value : domain) {
          Value next(base);
          next.as_object().emplace(child.name, field_value);
          expanded.push_back(std::move(next));
        }
      }
      objects = std::move(expanded);
    }
    result = std::move(objects);
    if (node.presence == Presence::Optional) {
      result.insert(result.begin(), Value::null());
    }
    return result;
  }

  const std::vector<Value> element_domain =
      enumerate_node(node.children.front(), max_list_length);
  result.push_back(Value::list());
  std::vector<Value> sequences = {Value::list()};
  for (std::size_t length = 1; length <= max_list_length; ++length) {
    std::vector<Value> next_sequences;
    for (const Value& prefix : sequences) {
      for (const Value& element : element_domain) {
        Value::Array array = prefix.as_array();
        array.push_back(element);
        next_sequences.push_back(Value::list(std::move(array)));
      }
    }
    sequences = std::move(next_sequences);
    result.insert(result.end(), sequences.begin(), sequences.end());
  }
  if (node.presence == Presence::Optional) {
    result.insert(result.begin(), Value::null());
  }
  return result;
}

void roundtrip_all(const SchemaNode& schema, std::size_t max_list_length) {
  const std::vector<Value> rows = enumerate_node(schema, max_list_length);
  const std::vector<Column> columns = dataeng::encode(schema, rows);
  const std::vector<Value> decoded = dataeng::decode(schema, columns);
  CHECK(decoded.size() == rows.size());
  for (std::size_t i = 0; i < rows.size(); ++i) {
    CHECK_EQUAL(decoded[i], rows[i]);
  }
}

Value random_node(const SchemaNode& node, std::mt19937& generator,
                  std::size_t max_list_length) {
  if (node.presence == Presence::Optional &&
      generator() % 4 == 0) {
    return Value::null();
  }
  switch (node.kind) {
    case dataeng::SchemaKind::Primitive:
      if (node.primitive_type == PrimitiveType::Int32 ||
          node.primitive_type == PrimitiveType::Int64) {
        return Value(static_cast<std::int32_t>(generator() % 17));
      }
      return Value(std::string(1,
                               static_cast<char>('a' + generator() % 4)));
    case dataeng::SchemaKind::Struct: {
      Value object_value = Value::object();
      for (const SchemaNode& child : node.children) {
        object_value.as_object().emplace(
            child.name,
            random_node(child, generator, max_list_length));
      }
      return object_value;
    }
    case dataeng::SchemaKind::List: {
      const std::size_t count = generator() % (max_list_length + 1);
      Value::Array array;
      for (std::size_t i = 0; i < count; ++i) {
        array.push_back(
            random_node(node.children.front(), generator, max_list_length));
      }
      return Value::list(std::move(array));
    }
  }
  return Value::null();
}

void test_random_nested_roundtrip() {
  const SchemaNode schema = complex_nested_schema();
  std::mt19937 generator(0x5eed1234U);
  std::vector<Value> rows;
  for (int i = 0; i < 300; ++i) {
    rows.push_back(random_node(schema, generator, 3));
  }
  const std::vector<Column> columns = dataeng::encode(schema, rows);
  const std::vector<Value> decoded = dataeng::decode(schema, columns);
  CHECK(decoded.size() == rows.size());
  for (std::size_t i = 0; i < rows.size(); ++i) {
    CHECK_EQUAL(decoded[i], rows[i]);
  }
}

void test_enumerated_roundtrips() {
  roundtrip_all(flat_optional_int(), 2);
  roundtrip_all(optional_list_of_optional_int(), 2);
  roundtrip_all(nested_optional_lists(), 2);
  roundtrip_all(optional_struct(), 2);
  roundtrip_all(list_of_optional_structs(), 2);
}

void test_illegal_levels_report_position() {
  const SchemaNode flat = flat_optional_int();
  EXPECT_DECODE_ERROR(
      dataeng::decode(flat, {Column({"x"}, {0, 2}, {1, 1}, {})}), 1);
  EXPECT_DECODE_ERROR(
      dataeng::decode(flat, {Column({"x"}, {0, 0}, {1, 2}, {})}), 1);
  EXPECT_DECODE_ERROR(
      dataeng::decode(flat, {Column({"x"}, {1}, {1}, {Value(1)})}), 0);

  const SchemaNode list = optional_list_of_optional_int();
  EXPECT_DECODE_ERROR(
      dataeng::decode(list, {Column({"items"}, {0, 1}, {0, 0}, {})}), 1);
  EXPECT_DECODE_ERROR(
      dataeng::decode(list,
                      {Column({"items"}, {0, 1}, {3, 3}, {Value(1)})}),
      1);
  EXPECT_DECODE_ERROR(
      dataeng::decode(list,
                      {Column({"items"}, {0, 1}, {1, 3}, {Value(1)})}),
      1);

  const SchemaNode nested = nested_optional_lists();
  EXPECT_DECODE_ERROR(
      dataeng::decode(nested, {Column({"outer"}, {0, 1}, {1, 1}, {})}), 1);
}

void test_cross_column_shape_errors() {
  const SchemaNode schema = optional_struct();
  const std::vector<Column> columns_a = dataeng::encode(
      schema, {object({{"s", Value::null()}})});
  const std::vector<Column> columns_b = dataeng::encode(
      schema,
      {object({{"s", Value::null()}}), object({{"s", Value::null()}})});
  EXPECT_DECODE_ERROR(
      dataeng::decode(schema,
                      {columns_a[0], columns_b[1]}),
      1);
}

void test_unknown_and_ambiguous_paths() {
  const SchemaNode schema = optional_struct();
  try {
    dataeng::decode(schema, {Column({"nope"}, {0}, {0}, {})});
    CHECK(false);
  } catch (const DecodeError&) {
    CHECK(true);
  }

  const SchemaNode duplicate_names = SchemaNode::root(
      "root", {SchemaNode::required_group(
                   "left", {SchemaNode::optional_primitive(
                                "value", PrimitiveType::Int32)}),
               SchemaNode::required_group(
                   "right", {SchemaNode::optional_primitive(
                                 "value", PrimitiveType::Int32)}),
               SchemaNode::optional_primitive("other",
                                              PrimitiveType::Int32)});
  try {
    dataeng::decode(duplicate_names, {Column({"value"}, {0}, {0}, {})});
    CHECK(false);
  } catch (const DecodeError&) {
    CHECK(true);
  }
}

void test_empty_streams() {
  const SchemaNode schema = flat_optional_int();
  CHECK(dataeng::decode(schema, {}).empty());
  const std::vector<Column> columns = dataeng::encode(schema, {});
  CHECK(columns.size() == 1);
  CHECK(columns[0].repetition_levels.empty());
  CHECK(dataeng::decode(schema, columns).empty());
}

void test_api_helpers() {
  const SchemaNode schema = optional_list_of_optional_int();
  const dataeng::Decoder decoder(schema);
  CHECK(decoder.max_definition_level({"items", "element"}) == 3);
  CHECK(decoder.max_definition_level({"items"}) == 3);
  CHECK(decoder.max_repetition_level({"items", "element"}) == 1);
  CHECK(decoder.leaves().size() == 1);
  CHECK(decoder.leaves().front().path ==
        std::vector<std::string>({"items", "element"}));

  const auto decoded = dataeng::decode(
      schema, {0, 1}, {3, 2}, {Value(std::int32_t{4})});
  CHECK(decoded.size() == 1);
  CHECK(decoded[0].as_object().at("items").as_array().size() == 2);
  CHECK(decoded[0].as_object().at("items").as_array().back().is_null());

  const Column dotted =
      Column::from_path("items.element", {0}, {3}, {Value(std::int32_t{5})});
  const auto dotted_rows = dataeng::decode(schema, {dotted});
  CHECK(dotted_rows.size() == 1);
  CHECK(dotted_rows[0].as_object().at("items").as_array().front() ==
        Value(std::int32_t{5}));
}

}  // namespace

int main() {
  test_levels_and_distinction();
  test_nested_lists();
  test_struct_assembly();
  test_complex_nested_assembly();
  test_random_nested_roundtrip();
  test_required_container();
  test_enumerated_roundtrips();
  test_illegal_levels_report_position();
  test_cross_column_shape_errors();
  test_unknown_and_ambiguous_paths();
  test_empty_streams();
  test_api_helpers();

  if (failures != 0) {
    std::cerr << failures << " check(s) failed\n";
    return 1;
  }
  std::cout << "all Dremel reconstruction tests passed\n";
  return 0;
}
