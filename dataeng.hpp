#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <utility>
#include <variant>
#include <vector>

namespace dataeng {

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

enum class SchemaKind {
  Struct,
  List,
  Primitive,
};

enum class Presence {
  Required,
  Optional,
};

enum class PrimitiveType {
  Boolean,
  Int32,
  Int64,
  UInt64,
  Float,
  Double,
  String,
  Binary,
};

// A small, logical Dremel/Parquet schema.
//
// Struct nodes keep their fields in `children`.  A List node has exactly one
// child: the element schema.  The element itself may be required or optional;
// a null element is different from an empty list.
//
// The list's repeated layer is implicit.  A list contributes one definition
// level for "the list is present" when it is optional, and one definition plus
// one repetition level for each live element.  This matches the usual
// three-level Parquet LIST encoding:
//
//   optional group items (LIST) {
//     repeated group list {
//       optional int32 element;
//     }
//   }
//
// while keeping the API focused on logical list/struct/null values.
struct SchemaNode {
  std::string name;
  SchemaKind kind = SchemaKind::Struct;
  Presence presence = Presence::Required;
  PrimitiveType primitive_type = PrimitiveType::String;
  std::vector<SchemaNode> children;

  SchemaNode() = default;
  SchemaNode(std::string node_name, SchemaKind node_kind,
             Presence node_presence = Presence::Required,
             PrimitiveType type = PrimitiveType::String);

  static SchemaNode root(std::string name, std::vector<SchemaNode> fields);
  static SchemaNode group(std::string name, Presence presence,
                          std::vector<SchemaNode> fields);
  static SchemaNode list(std::string name, Presence presence,
                         SchemaNode element);
  static SchemaNode primitive(std::string name, PrimitiveType type,
                              Presence presence = Presence::Optional);

  static SchemaNode optional_group(std::string name,
                                   std::vector<SchemaNode> fields);
  static SchemaNode required_group(std::string name,
                                   std::vector<SchemaNode> fields);
  static SchemaNode optional_list(std::string name, SchemaNode element);
  static SchemaNode required_list(std::string name, SchemaNode element);
  static SchemaNode optional_primitive(std::string name, PrimitiveType type);
  static SchemaNode required_primitive(std::string name, PrimitiveType type);

  bool is_leaf() const noexcept { return kind == SchemaKind::Primitive; }
};

using Schema = SchemaNode;
using Field = SchemaNode;

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

// Logical value tree produced by the decoder.  std::nullptr_t denotes null;
// an empty Array denotes an empty list, while a null Array denotes a null
// list.  Object is used for structs.
struct Value {
  using Array = std::vector<Value>;
  using Object = std::map<std::string, Value>;
  using Storage =
      std::variant<std::nullptr_t, bool, std::int32_t, std::int64_t,
                   std::uint64_t, float, double, std::string, Array, Object>;

  Storage data = nullptr;

  Value() = default;
  Value(std::nullptr_t) : data(nullptr) {}
  Value(bool value) : data(value) {}
  Value(std::int32_t value) : data(value) {}
  Value(std::int64_t value) : data(value) {}
  Value(std::uint64_t value) : data(value) {}
  Value(float value) : data(value) {}
  Value(double value) : data(value) {}
  template <typename T,
            std::enable_if_t<std::is_integral_v<std::decay_t<T>> &&
                                 !std::is_same_v<std::decay_t<T>, bool>,
                             int> = 0>
  Value(T value) {
    if constexpr (std::is_signed_v<T>) {
      data = static_cast<std::int64_t>(value);
    } else {
      data = static_cast<std::uint64_t>(value);
    }
  }
  Value(const char* value) : data(std::string(value)) {}
  Value(std::string value) : data(std::move(value)) {}
  Value(Array value) : data(std::move(value)) {}
  Value(Object value) : data(std::move(value)) {}

  static Value null() { return Value(nullptr); }
  static Value list() { return Value(Array{}); }
  static Value list(Array values) { return Value(std::move(values)); }
  static Value object() { return Value(Object{}); }
  static Value object(Object values) { return Value(std::move(values)); }

  bool is_null() const noexcept {
    return std::holds_alternative<std::nullptr_t>(data);
  }
  bool is_array() const noexcept {
    return std::holds_alternative<Array>(data);
  }
  bool is_object() const noexcept {
    return std::holds_alternative<Object>(data);
  }

  const Array& as_array() const { return std::get<Array>(data); }
  Array& as_array() { return std::get<Array>(data); }
  const Object& as_object() const { return std::get<Object>(data); }
  Object& as_object() { return std::get<Object>(data); }
};

using Record = Value;

inline bool operator==(const Value& lhs, const Value& rhs) {
  return lhs.data == rhs.data;
}
inline bool operator!=(const Value& lhs, const Value& rhs) {
  return !(lhs == rhs);
}

// ---------------------------------------------------------------------------
// Level streams
// ---------------------------------------------------------------------------

// One leaf column.  `values` contains one entry for every event whose
// definition level reaches the leaf's maximum definition level; null elements
// and empty/null lists do not consume a value.
struct Column {
  // Names from the root's children down to the primitive leaf.  If the leaf is
  // a list element, the synthetic element name may be omitted as long as the
  // column still identifies exactly one leaf.
  std::vector<std::string> path;
  std::vector<int> repetition_levels;
  std::vector<int> definition_levels;
  std::vector<Value> values;

  std::string label;

  Column() = default;
  Column(std::vector<std::string> field_path,
         std::vector<int> repetition, std::vector<int> definition,
         std::vector<Value> stream_values = {});
  // Convenience factory accepting a dotted or slash-separated path, e.g.
  // "items.element" or "items/element".
  static Column from_path(std::string field_path,
                          std::vector<int> repetition,
                          std::vector<int> definition,
                          std::vector<Value> stream_values = {});

  std::string name() const;
};

using LevelStream = Column;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class DataEngError : public std::runtime_error {
 public:
  DataEngError(std::string message, std::size_t position,
               std::string column = {}, std::optional<std::size_t> row =
                                             std::nullopt);

  // Zero-based event index in the offending column.  For errors that are not
  // tied to an event this is the closest known position.
  std::size_t position() const noexcept { return position_; }
  std::size_t event_index() const noexcept { return position_; }
  const std::string& column() const noexcept { return column_; }
  const std::optional<std::size_t>& row() const noexcept { return row_; }

 private:
  std::size_t position_;
  std::string column_;
  std::optional<std::size_t> row_;
};

class DecodeError : public DataEngError {
 public:
  using DataEngError::DataEngError;
};

class EncodeError : public DataEngError {
 public:
  using DataEngError::DataEngError;
};

// ---------------------------------------------------------------------------
// Decoder / encoder
// ---------------------------------------------------------------------------

struct LeafInfo {
  std::vector<std::string> path;
  int max_definition_level = 0;
  int max_repetition_level = 0;
};

class Decoder {
 public:
  explicit Decoder(SchemaNode schema);

  const SchemaNode& schema() const noexcept { return schema_; }
  const std::vector<LeafInfo>& leaves() const noexcept { return leaves_; }

  // Decodes all supplied leaf columns and assembles logical records.  Columns
  // may be a projection, but no leaf may occur twice.  A Column whose path is
  // unknown or ambiguous is rejected.
  std::vector<Value> decode(const std::vector<Column>& columns) const;

  // Maximum levels for a leaf identified by `path`.
  int max_definition_level(const std::vector<std::string>& path) const;
  int max_repetition_level(const std::vector<std::string>& path) const;

 private:
  SchemaNode schema_;
  std::vector<LeafInfo> leaves_;
};

class Encoder {
 public:
  explicit Encoder(SchemaNode schema);

  // Encodes logical records into one column per primitive leaf.  Every row
  // produces at least one event per column, including null/empty markers.
  std::vector<Column> encode(const std::vector<Value>& rows) const;

  const std::vector<LeafInfo>& leaves() const noexcept { return leaves_; }

 private:
  SchemaNode schema_;
  std::vector<LeafInfo> leaves_;
};

std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<Column>& columns);
// Single-leaf convenience overload.  The schema may contain one leaf, or an
// empty path is accepted when exactly one leaf exists.
std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<int>& repetition_levels,
                          const std::vector<int>& definition_levels,
                          const std::vector<Value>& values);
std::vector<Value> decode(const SchemaNode& schema,
                          const std::vector<std::string>& path,
                          const std::vector<int>& repetition_levels,
                          const std::vector<int>& definition_levels,
                          const std::vector<Value>& values);
std::vector<Column> encode(const SchemaNode& schema,
                           const std::vector<Value>& rows);

using DremelDecoder = Decoder;
using DremelEncoder = Encoder;

}  // namespace dataeng
