#pragma once

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <initializer_list>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <ostream>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace dataeng {

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

enum class StatusCode {
  Ok = 0,
  OK = 0,
  InvalidArgument = 1,
  NotFound = 2,
  OutOfRange = 3,
  TypeMismatch = 4,
  InvalidState = 5,
  Truncated = 6,
  Corrupt = 7,
  AlreadyExists = 8,
  Unsupported = 9,
  Internal = 10,
};

namespace detail {

struct Text {
  std::string value;

  Text() = default;
  Text(std::string text) : value(std::move(text)) {}
  Text(const char* text) : value(text == nullptr ? "" : text) {}

  operator const std::string&() const { return value; }
  const std::string& operator()() const { return value; }
  const std::string& str() const { return value; }
  const char* c_str() const { return value.c_str(); }
  bool empty() const { return value.empty(); }
  std::size_t size() const { return value.size(); }
  Text& operator=(std::string text) {
    value = std::move(text);
    return *this;
  }
  Text& operator=(const char* text) {
    value = text == nullptr ? "" : text;
    return *this;
  }
  friend bool operator==(const Text& lhs, const Text& rhs) {
    return lhs.value == rhs.value;
  }
  friend bool operator==(const Text& lhs, std::string_view rhs) {
    return lhs.value == rhs;
  }
  friend bool operator==(std::string_view lhs, const Text& rhs) {
    return lhs == rhs.value;
  }
  friend bool operator!=(const Text& lhs, const Text& rhs) {
    return !(lhs == rhs);
  }
  friend std::ostream& operator<<(std::ostream& os, const Text& text) {
    return os << text.value;
  }
};

inline std::string StatusCodeName(StatusCode code) {
  switch (code) {
    case StatusCode::Ok:
      return "OK";
    case StatusCode::InvalidArgument:
      return "InvalidArgument";
    case StatusCode::NotFound:
      return "NotFound";
    case StatusCode::OutOfRange:
      return "OutOfRange";
    case StatusCode::TypeMismatch:
      return "TypeMismatch";
    case StatusCode::InvalidState:
      return "InvalidState";
    case StatusCode::Truncated:
      return "Truncated";
    case StatusCode::Corrupt:
      return "Corrupt";
    case StatusCode::AlreadyExists:
      return "AlreadyExists";
    case StatusCode::Unsupported:
      return "Unsupported";
    case StatusCode::Internal:
      return "Internal";
    default:
      return "Unknown";
  }
}

inline std::string StatusCodeName(int code) {
  return StatusCodeName(static_cast<StatusCode>(code));
}

}  // namespace detail

class Status {
 public:
  Status() = default;
  Status(StatusCode code, std::string message = {})
      : code(code), message(std::move(message)) {}

  static Status Ok() { return Status(); }
  static Status OK() { return Status(); }
  static Status Invalid(std::string message) {
    return Status(StatusCode::InvalidArgument, std::move(message));
  }
  static Status NotFound(std::string message) {
    return Status(StatusCode::NotFound, std::move(message));
  }
  static Status OutOfRange(std::string message) {
    return Status(StatusCode::OutOfRange, std::move(message));
  }
  static Status TypeMismatch(std::string message) {
    return Status(StatusCode::TypeMismatch, std::move(message));
  }
  static Status InvalidState(std::string message) {
    return Status(StatusCode::InvalidState, std::move(message));
  }
  static Status Truncated(std::string message) {
    return Status(StatusCode::Truncated, std::move(message));
  }
  static Status Corrupt(std::string message) {
    return Status(StatusCode::Corrupt, std::move(message));
  }
  static Status Unsupported(std::string message) {
    return Status(StatusCode::Unsupported, std::move(message));
  }

  bool ok() const { return code == StatusCode::Ok; }
  operator bool() const { return ok(); }
  operator StatusCode() const { return code; }

  std::string ToString() const {
    if (ok()) {
      return "OK";
    }
    if (message.empty()) {
      return detail::StatusCodeName(code);
    }
    return detail::StatusCodeName(code) + ": " + message.value;
  }

  void ThrowIfNotOk() const {
    if (!ok()) {
      throw std::runtime_error(ToString());
    }
  }

  StatusCode code = StatusCode::Ok;
  detail::Text message;

  friend bool operator==(const Status& lhs, const Status& rhs) {
    return lhs.code == rhs.code;
  }
  friend bool operator!=(const Status& lhs, const Status& rhs) {
    return !(lhs == rhs);
  }
  friend bool operator==(const Status& status, StatusCode code) {
    return status.code == code;
  }
  friend bool operator==(StatusCode code, const Status& status) {
    return status.code == code;
  }
  friend bool operator!=(const Status& status, StatusCode code) {
    return !(status == code);
  }
  friend bool operator==(const Status& status, bool ok) {
    return status.ok() == ok;
  }
  friend bool operator==(bool ok, const Status& status) {
    return status == ok;
  }
  friend bool operator!=(const Status& status, bool ok) {
    return !(status == ok);
  }
  friend std::ostream& operator<<(std::ostream& os, const Status& status) {
    return os << status.ToString();
  }
};

inline Status OkStatus() { return Status::Ok(); }

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

enum class TypeId : std::uint8_t {
  Null = 0,
  Bool,
  Int8,
  Int16,
  Int32,
  Int = Int32,
  Int64,
  Long = Int64,
  UInt8,
  UInt16,
  UInt32,
  UInt64,
  Float16,
  Float32,
  Float = Float32,
  Float64,
  Double = Float64,
  Utf8,
  String = Utf8,
  LargeUtf8,
  Binary,
  Bytes = Binary,
  LargeBinary,
  FixedSizeBinary,
  Date32,
  Date64,
  Time32,
  Time64,
  Timestamp,
  Duration,
  Interval,
  Decimal128,
  Decimal256,
  List,
  LargeList,
  Struct,
  Map,
  Dictionary,
  Unknown,
};

inline std::string TypeIdName(TypeId id) {
  switch (id) {
    case TypeId::Null:
      return "null";
    case TypeId::Bool:
      return "bool";
    case TypeId::Int8:
      return "int8";
    case TypeId::Int16:
      return "int16";
    case TypeId::Int32:
      return "int32";
    case TypeId::Int64:
      return "int64";
    case TypeId::UInt8:
      return "uint8";
    case TypeId::UInt16:
      return "uint16";
    case TypeId::UInt32:
      return "uint32";
    case TypeId::UInt64:
      return "uint64";
    case TypeId::Float16:
      return "float16";
    case TypeId::Float32:
      return "float32";
    case TypeId::Float64:
      return "float64";
    case TypeId::Utf8:
      return "utf8";
    case TypeId::LargeUtf8:
      return "large_utf8";
    case TypeId::Binary:
      return "binary";
    case TypeId::LargeBinary:
      return "large_binary";
    case TypeId::FixedSizeBinary:
      return "fixed_size_binary";
    case TypeId::Date32:
      return "date32";
    case TypeId::Date64:
      return "date64";
    case TypeId::Time32:
      return "time32";
    case TypeId::Time64:
      return "time64";
    case TypeId::Timestamp:
      return "timestamp";
    case TypeId::Duration:
      return "duration";
    case TypeId::Interval:
      return "interval";
    case TypeId::Decimal128:
      return "decimal128";
    case TypeId::Decimal256:
      return "decimal256";
    case TypeId::List:
      return "list";
    case TypeId::LargeList:
      return "large_list";
    case TypeId::Struct:
      return "struct";
    case TypeId::Map:
      return "map";
    case TypeId::Dictionary:
      return "dictionary";
    case TypeId::Unknown:
      return "unknown";
  }
  return "unknown";
}

struct DataType;
using DataTypePtr = std::shared_ptr<const DataType>;

struct DataType {
  TypeId id = TypeId::Null;
  std::int32_t byte_width = 0;
  std::int32_t precision = 0;
  std::int32_t scale = 0;
  std::string timezone;
  DataTypePtr index_type;
  DataTypePtr value_type;

  DataType() = default;
  DataType(TypeId type) : id(type) { Normalize(); }
  DataType(const char* name) { *this = FromString(name == nullptr ? "" : name); }
  DataType(const std::string& name) { *this = FromString(name); }
  DataType(std::string_view name) { *this = FromString(name); }

  inline static constexpr TypeId BOOL = TypeId::Bool;
  inline static constexpr TypeId INT8 = TypeId::Int8;
  inline static constexpr TypeId INT16 = TypeId::Int16;
  inline static constexpr TypeId INT32 = TypeId::Int32;
  inline static constexpr TypeId INT64 = TypeId::Int64;
  inline static constexpr TypeId UINT8 = TypeId::UInt8;
  inline static constexpr TypeId UINT16 = TypeId::UInt16;
  inline static constexpr TypeId UINT32 = TypeId::UInt32;
  inline static constexpr TypeId UINT64 = TypeId::UInt64;
  inline static constexpr TypeId FLOAT16 = TypeId::Float16;
  inline static constexpr TypeId FLOAT32 = TypeId::Float32;
  inline static constexpr TypeId FLOAT64 = TypeId::Float64;
  inline static constexpr TypeId UTF8 = TypeId::Utf8;
  inline static constexpr TypeId STRING = TypeId::Utf8;
  inline static constexpr TypeId BINARY = TypeId::Binary;
  inline static constexpr TypeId DICTIONARY = TypeId::Dictionary;

  static DataType Null() { return DataType(TypeId::Null); }
  static DataType Bool() { return DataType(TypeId::Bool); }
  static DataType Int8() { return DataType(TypeId::Int8); }
  static DataType Int16() { return DataType(TypeId::Int16); }
  static DataType Int32() { return DataType(TypeId::Int32); }
  static DataType Int64() { return DataType(TypeId::Int64); }
  static DataType UInt8() { return DataType(TypeId::UInt8); }
  static DataType UInt16() { return DataType(TypeId::UInt16); }
  static DataType UInt32() { return DataType(TypeId::UInt32); }
  static DataType UInt64() { return DataType(TypeId::UInt64); }
  static DataType Float16() { return DataType(TypeId::Float16); }
  static DataType Float32() { return DataType(TypeId::Float32); }
  static DataType Float64() { return DataType(TypeId::Float64); }
  static DataType Utf8() { return DataType(TypeId::Utf8); }
  static DataType String() { return DataType(TypeId::Utf8); }
  static DataType LargeUtf8() { return DataType(TypeId::LargeUtf8); }
  static DataType Binary() { return DataType(TypeId::Binary); }
  static DataType LargeBinary() { return DataType(TypeId::LargeBinary); }
  static DataType Decimal(std::int32_t precision, std::int32_t scale) {
    DataType type(TypeId::Decimal128);
    type.precision = precision;
    type.scale = scale;
    return type;
  }
  static DataType Dictionary(const DataType& index,
                             const DataType& values) {
    DataType type(TypeId::Dictionary);
    type.index_type = std::make_shared<DataType>(index);
    type.value_type = std::make_shared<DataType>(values);
    return type;
  }

  static DataType FromString(std::string_view name) {
    std::string lower;
    lower.reserve(name.size());
    for (char ch : name) {
      if (ch == '-' || ch == ' ') {
        lower.push_back('_');
      } else {
        lower.push_back(static_cast<char>(
            std::tolower(static_cast<unsigned char>(ch))));
      }
    }
    if (lower.empty() || lower == "null" || lower == "none") {
      return DataType(TypeId::Null);
    }
    if (lower == "bool" || lower == "boolean") {
      return DataType(TypeId::Bool);
    }
    if (lower == "int8" || lower == "i8") {
      return DataType(TypeId::Int8);
    }
    if (lower == "int16" || lower == "i16") {
      return DataType(TypeId::Int16);
    }
    if (lower == "int32" || lower == "int" || lower == "i32") {
      return DataType(TypeId::Int32);
    }
    if (lower == "int64" || lower == "long" || lower == "i64") {
      return DataType(TypeId::Int64);
    }
    if (lower == "uint8" || lower == "u8") {
      return DataType(TypeId::UInt8);
    }
    if (lower == "uint16" || lower == "u16") {
      return DataType(TypeId::UInt16);
    }
    if (lower == "uint32" || lower == "u32") {
      return DataType(TypeId::UInt32);
    }
    if (lower == "uint64" || lower == "u64") {
      return DataType(TypeId::UInt64);
    }
    if (lower == "float16" || lower == "half") {
      return DataType(TypeId::Float16);
    }
    if (lower == "float32" || lower == "float") {
      return DataType(TypeId::Float32);
    }
    if (lower == "float64" || lower == "double") {
      return DataType(TypeId::Float64);
    }
    if (lower == "utf8" || lower == "string" || lower == "str" ||
        lower == "text") {
      return DataType(TypeId::Utf8);
    }
    if (lower == "large_utf8" || lower == "large_string") {
      return DataType(TypeId::LargeUtf8);
    }
    if (lower == "binary" || lower == "bytes") {
      return DataType(TypeId::Binary);
    }
    if (lower == "large_binary") {
      return DataType(TypeId::LargeBinary);
    }
    if (lower == "date32") {
      return DataType(TypeId::Date32);
    }
    if (lower == "date64") {
      return DataType(TypeId::Date64);
    }
    if (lower == "timestamp") {
      return DataType(TypeId::Timestamp);
    }
    if (lower == "duration") {
      return DataType(TypeId::Duration);
    }
    if (lower == "decimal" || lower == "decimal128") {
      return DataType(TypeId::Decimal128);
    }
    return DataType(TypeId::Unknown);
  }

  void Normalize() {
    if (byte_width != 0) {
      return;
    }
    switch (id) {
      case TypeId::Bool:
      case TypeId::Int8:
      case TypeId::UInt8:
        byte_width = 1;
        break;
      case TypeId::Int16:
      case TypeId::UInt16:
      case TypeId::Float16:
        byte_width = 2;
        break;
      case TypeId::Int32:
      case TypeId::UInt32:
      case TypeId::Float32:
      case TypeId::Date32:
      case TypeId::Time32:
        byte_width = 4;
        break;
      case TypeId::Int64:
      case TypeId::UInt64:
      case TypeId::Float64:
      case TypeId::Date64:
      case TypeId::Time64:
      case TypeId::Timestamp:
      case TypeId::Duration:
      case TypeId::Decimal128:
        byte_width = 8;
        break;
      case TypeId::Decimal256:
        byte_width = 32;
        break;
      default:
        break;
    }
  }

  bool is_null() const { return id == TypeId::Null; }
  bool is_bool() const { return id == TypeId::Bool; }
  bool is_integer() const {
    return id == TypeId::Int8 || id == TypeId::Int16 ||
           id == TypeId::Int32 || id == TypeId::Int64 ||
           id == TypeId::UInt8 || id == TypeId::UInt16 ||
           id == TypeId::UInt32 || id == TypeId::UInt64;
  }
  bool is_signed_integer() const {
    return id == TypeId::Int8 || id == TypeId::Int16 ||
           id == TypeId::Int32 || id == TypeId::Int64;
  }
  bool is_unsigned_integer() const {
    return id == TypeId::UInt8 || id == TypeId::UInt16 ||
           id == TypeId::UInt32 || id == TypeId::UInt64;
  }
  bool is_floating() const {
    return id == TypeId::Float16 || id == TypeId::Float32 ||
           id == TypeId::Float64;
  }
  bool is_string() const {
    return id == TypeId::Utf8 || id == TypeId::LargeUtf8;
  }
  bool is_binary_like() const {
    return is_string() || id == TypeId::Binary ||
           id == TypeId::LargeBinary;
  }
  bool is_dictionary() const { return id == TypeId::Dictionary; }

  DataType dictionary_index() const {
    return index_type == nullptr ? Null() : *index_type;
  }
  DataType dictionary_values() const {
    return value_type == nullptr ? Null() : *value_type;
  }

  std::string name() const {
    if (id == TypeId::Dictionary) {
      return "dictionary<" + dictionary_index().name() + "," +
             dictionary_values().name() + ">";
    }
    return TypeIdName(id);
  }

  friend bool operator==(const DataType& lhs, const DataType& rhs) {
    if (lhs.id != rhs.id) {
      return false;
    }
    if (lhs.id == TypeId::Decimal128 || lhs.id == TypeId::Decimal256) {
      return lhs.precision == rhs.precision && lhs.scale == rhs.scale;
    }
    if (lhs.id == TypeId::Timestamp) {
      return lhs.timezone == rhs.timezone;
    }
    if (lhs.id == TypeId::Dictionary) {
      return lhs.dictionary_index() == rhs.dictionary_index() &&
             lhs.dictionary_values() == rhs.dictionary_values();
    }
    return true;
  }
  friend bool operator!=(const DataType& lhs, const DataType& rhs) {
    return !(lhs == rhs);
  }
  friend bool operator==(const DataType& type, TypeId id) {
    return type.id == id;
  }
  friend bool operator==(TypeId id, const DataType& type) {
    return type.id == id;
  }
  friend bool operator!=(const DataType& type, TypeId id) {
    return !(type == id);
  }
  friend std::ostream& operator<<(std::ostream& os, const DataType& type) {
    return os << type.name();
  }
};

using Type = DataType;

inline DataType TypeFromString(std::string_view name) {
  return DataType::FromString(name);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

struct Field {
  std::string name;
  DataType type;
  union {
    std::int64_t dictionary_id;
    std::int64_t dict_id;
  };
  DataType index_type;
  bool nullable = true;
  bool ordered = false;

  Field() { dictionary_id = -1; }
  Field(std::string field_name, DataType field_type)
      : name(std::move(field_name)), type(std::move(field_type)) {
    dictionary_id = -1;
  }
  Field(std::string field_name, DataType field_type,
        std::int64_t dictionary)
      : name(std::move(field_name)), type(std::move(field_type)) {
    dictionary_id = dictionary;
  }
  Field(std::string field_name, std::int64_t dictionary, DataType field_type)
      : name(std::move(field_name)),
        type(std::move(field_type)),
        index_type(DataType::Int32()) {
    dictionary_id = dictionary;
  }
  Field(std::string field_name, DataType field_type,
        std::int64_t dictionary, DataType indices)
      : name(std::move(field_name)),
        type(std::move(field_type)),
        index_type(std::move(indices)) {
    dictionary_id = dictionary;
  }

  bool has_dictionary() const {
    return dictionary_id >= 0 || type.id == TypeId::Dictionary;
  }
  std::int64_t effective_dictionary_id() const {
    if (dictionary_id >= 0) {
      return dictionary_id;
    }
    return -1;
  }
  DataType value_type() const {
    if (type.id == TypeId::Dictionary) {
      return type.dictionary_values();
    }
    return type;
  }
  DataType dictionary_index_type() const {
    if (type.id == TypeId::Dictionary) {
      return type.dictionary_index();
    }
    if (!index_type.is_null()) {
      return index_type;
    }
    return DataType::Int32();
  }
};

struct Schema {
  std::vector<Field> fields;

  Schema() = default;
  explicit Schema(std::vector<Field> schema_fields)
      : fields(std::move(schema_fields)) {}
  Schema(std::initializer_list<Field> schema_fields) : fields(schema_fields) {}

  std::size_t size() const { return fields.size(); }
  bool empty() const { return fields.empty(); }
  const Field& operator[](std::size_t index) const { return fields.at(index); }
  Field& operator[](std::size_t index) { return fields.at(index); }
  const Field& field(std::size_t index) const { return fields.at(index); }
  Schema& AddField(Field field) {
    fields.push_back(std::move(field));
    return *this;
  }
  Schema& add_field(Field field) { return AddField(std::move(field)); }
  auto begin() const { return fields.begin(); }
  auto end() const { return fields.end(); }
  auto begin() { return fields.begin(); }
  auto end() { return fields.end(); }
};

// ---------------------------------------------------------------------------
// Arrays and immutable dictionary generations
// ---------------------------------------------------------------------------

struct DictionaryGeneration;

class Array {
 public:
  Array() = default;

  explicit Array(DataType type, std::int64_t length = 0)
      : type_(std::move(type)), length_(length) {}

  Array(DataType type, std::vector<std::int64_t> values)
      : type_(std::move(type)),
        length_(static_cast<std::int64_t>(values.size())),
        ints_(std::move(values)) {
    type_.Normalize();
  }

  Array(DataType type, std::vector<double> values)
      : type_(std::move(type)),
        length_(static_cast<std::int64_t>(values.size())),
        doubles_(std::move(values)) {
    type_.Normalize();
  }

  Array(DataType type, std::vector<std::string> values)
      : type_(std::move(type)),
        length_(static_cast<std::int64_t>(values.size())),
        strings_(std::move(values)) {
    type_.Normalize();
  }

  Array(std::vector<std::string> values)
      : Array(DataType::Utf8(), std::move(values)) {}
  Array(std::vector<std::int32_t> values) {
    *this = FromInt32(std::move(values));
  }
  Array(std::vector<std::int64_t> values) {
    *this = FromInt64(std::move(values));
  }
  Array(std::vector<double> values) {
    *this = FromFloat64(std::move(values));
  }
  Array(std::initializer_list<std::string> values)
      : Array(std::vector<std::string>(values)) {}
  Array(std::initializer_list<std::int32_t> values)
      : Array(std::vector<std::int32_t>(values)) {}
  Array(std::initializer_list<std::int64_t> values)
      : Array(std::vector<std::int64_t>(values)) {}

  static Array Empty(DataType type) {
    return Array(std::move(type), 0);
  }

  static Array FromBool(std::vector<bool> values) {
    Array array(DataType::Bool(),
                static_cast<std::int64_t>(values.size()));
    array.ints_.reserve(values.size());
    for (bool value : values) {
      array.ints_.push_back(value ? 1 : 0);
    }
    return array;
  }
  static Array FromBool(std::initializer_list<bool> values) {
    return FromBool(std::vector<bool>(values));
  }

  static Array FromInt8(std::vector<std::int8_t> values) {
    return FromSigned(values, TypeId::Int8);
  }
  static Array FromInt16(std::vector<std::int16_t> values) {
    return FromSigned(values, TypeId::Int16);
  }
  static Array FromInt32(std::vector<std::int32_t> values) {
    return FromSigned(values, TypeId::Int32);
  }
  static Array FromInt64(std::vector<std::int64_t> values) {
    return FromSigned(values, TypeId::Int64);
  }
  static Array FromUInt8(std::vector<std::uint8_t> values) {
    return FromUnsigned(values, TypeId::UInt8);
  }
  static Array FromUInt16(std::vector<std::uint16_t> values) {
    return FromUnsigned(values, TypeId::UInt16);
  }
  static Array FromUInt32(std::vector<std::uint32_t> values) {
    return FromUnsigned(values, TypeId::UInt32);
  }
  static Array FromUInt64(std::vector<std::uint64_t> values) {
    return FromUnsigned(values, TypeId::UInt64);
  }
  static Array FromInt32(std::initializer_list<std::int32_t> values) {
    return FromInt32(std::vector<std::int32_t>(values));
  }
  static Array FromInt64(std::initializer_list<std::int64_t> values) {
    return FromInt64(std::vector<std::int64_t>(values));
  }
  static Array FromUInt32(std::initializer_list<std::uint32_t> values) {
    return FromUInt32(std::vector<std::uint32_t>(values));
  }
  static Array FromUInt64(std::initializer_list<std::uint64_t> values) {
    return FromUInt64(std::vector<std::uint64_t>(values));
  }

  static Array FromFloat32(std::vector<float> values) {
    Array array(DataType::Float32(),
                static_cast<std::int64_t>(values.size()));
    array.doubles_.assign(values.begin(), values.end());
    return array;
  }
  static Array FromFloat64(std::vector<double> values) {
    return Array(DataType::Float64(), std::move(values));
  }

  static Array FromUtf8(std::vector<std::string> values) {
    return Array(DataType::Utf8(), std::move(values));
  }
  static Array FromStrings(std::vector<std::string> values) {
    return FromUtf8(std::move(values));
  }
  static Array FromUtf8(std::initializer_list<std::string> values) {
    return FromUtf8(std::vector<std::string>(values));
  }
  static Array FromStrings(std::initializer_list<std::string> values) {
    return FromUtf8(std::vector<std::string>(values));
  }
  static Array FromBinary(
      std::vector<std::vector<std::uint8_t>> values) {
    Array array(DataType::Binary(),
                static_cast<std::int64_t>(values.size()));
    array.binaries_ = std::move(values);
    return array;
  }

  template <typename T>
  static Array FromValues(const std::vector<T>& values) {
    if constexpr (std::is_same_v<T, bool>) {
      std::vector<bool> bools(values.begin(), values.end());
      return FromBool(std::move(bools));
    } else if constexpr (std::is_same_v<T, std::int8_t>) {
      return FromInt8(values);
    } else if constexpr (std::is_same_v<T, std::int16_t>) {
      return FromInt16(values);
    } else if constexpr (std::is_same_v<T, std::int32_t>) {
      return FromInt32(values);
    } else if constexpr (std::is_same_v<T, std::int64_t>) {
      return FromInt64(values);
    } else if constexpr (std::is_same_v<T, std::uint8_t>) {
      return FromUInt8(values);
    } else if constexpr (std::is_same_v<T, std::uint16_t>) {
      return FromUInt16(values);
    } else if constexpr (std::is_same_v<T, std::uint32_t>) {
      return FromUInt32(values);
    } else if constexpr (std::is_same_v<T, std::uint64_t>) {
      return FromUInt64(values);
    } else if constexpr (std::is_same_v<T, float>) {
      return FromFloat32(values);
    } else if constexpr (std::is_same_v<T, double>) {
      return FromFloat64(values);
    } else if constexpr (std::is_same_v<T, std::string>) {
      return FromUtf8(values);
    } else if constexpr (std::is_same_v<T, const char*> ||
                         std::is_same_v<T, char*>) {
      std::vector<std::string> strings;
      strings.reserve(values.size());
      for (const char* value : values) {
        strings.emplace_back(value == nullptr ? "" : value);
      }
      return FromUtf8(std::move(strings));
    } else if constexpr (std::is_integral_v<T> && std::is_signed_v<T>) {
      std::vector<std::int64_t> converted(values.begin(), values.end());
      return FromInt64(std::move(converted));
    } else if constexpr (std::is_integral_v<T> && std::is_unsigned_v<T>) {
      std::vector<std::uint64_t> converted(values.begin(), values.end());
      return FromUInt64(std::move(converted));
    } else if constexpr (std::is_floating_point_v<T>) {
      std::vector<double> converted(values.begin(), values.end());
      return FromFloat64(std::move(converted));
    } else {
      static_assert(!sizeof(T), "unsupported Array value type");
    }
  }

  template <typename T>
  static Array FromOptional(const std::vector<std::optional<T>>& values) {
    std::vector<T> present;
    std::vector<std::uint8_t> validity;
    present.reserve(values.size());
    validity.reserve(values.size());
    bool has_null = false;
    for (const auto& value : values) {
      if (value.has_value()) {
        present.push_back(*value);
        validity.push_back(1);
      } else {
        present.push_back(T{});
        validity.push_back(0);
        has_null = true;
      }
    }
    Array result = FromValues(present);
    if (has_null) {
      result.validity_ = std::move(validity);
    }
    return result;
  }

  static Array FromIndices(
      std::vector<std::int64_t> indices,
      std::shared_ptr<const DictionaryGeneration> dictionary);

  static Array FromIndices(
      std::vector<std::int64_t> indices,
      std::shared_ptr<const DictionaryGeneration> dictionary,
      std::vector<std::uint8_t> validity);
  static Array FromIndices(
      std::vector<std::int64_t> indices,
      const DictionaryGeneration* dictionary) {
    if (dictionary == nullptr) {
      return Array();
    }
    return FromIndices(
        std::move(indices),
        std::shared_ptr<const DictionaryGeneration>(
            dictionary, [](const DictionaryGeneration*) {}));
  }
  static Array FromIndices(
      std::initializer_list<std::int64_t> indices,
      std::shared_ptr<const DictionaryGeneration> dictionary) {
    return FromIndices(std::vector<std::int64_t>(indices),
                       std::move(dictionary));
  }
  static Array FromIndices(
      std::initializer_list<std::int64_t> indices,
      const DictionaryGeneration* dictionary) {
    return FromIndices(std::vector<std::int64_t>(indices), dictionary);
  }

  std::int64_t length() const { return length_; }
  std::int64_t size() const { return length_; }
  bool empty() const { return length_ == 0; }

  const DataType& type() const { return type_; }
  const DataType& dtype() const { return type_; }
  const DataType& value_type() const { return type_; }
  const DataType& index_type() const {
    return index_type_.is_null() ? type_ : index_type_;
  }
  DataType& mutable_type() { return type_; }

  bool is_dictionary() const { return dictionary_ != nullptr; }
  bool dictionary_encoded() const { return is_dictionary(); }
  const std::shared_ptr<const DictionaryGeneration>& dictionary() const {
    return dictionary_;
  }
  std::shared_ptr<const DictionaryGeneration> dictionary_ptr() const {
    return dictionary_;
  }
  const std::vector<std::int64_t>& indices() const { return indices_; }
  const std::vector<std::int64_t>& int_values() const { return ints_; }
  const std::vector<double>& double_values() const { return doubles_; }
  const std::vector<std::string>& string_values() const { return strings_; }
  const std::vector<std::vector<std::uint8_t>>& binary_values() const {
    return binaries_;
  }
  const std::vector<std::uint8_t>& validity() const { return validity_; }
  const std::vector<std::uint8_t>& validity_bitmap() const {
    return validity_;
  }
  std::vector<std::uint8_t>& mutable_validity() { return validity_; }

  bool has_bitmap() const { return !validity_.empty(); }
  std::int64_t null_count() const {
    if (validity_.empty()) {
      return 0;
    }
    return static_cast<std::int64_t>(
        std::count(validity_.begin(), validity_.end(), std::uint8_t{0}));
  }
  bool IsNull(std::int64_t index) const {
    if (index < 0 || index >= length_) {
      return true;
    }
    return !validity_.empty() && validity_[static_cast<std::size_t>(index)] == 0;
  }
  bool is_null(std::int64_t index) const { return IsNull(index); }
  bool IsValid(std::int64_t index) const { return !IsNull(index); }

  std::int64_t index_at(std::int64_t index) const {
    if (index < 0 || index >= static_cast<std::int64_t>(indices_.size())) {
      return -1;
    }
    return indices_[static_cast<std::size_t>(index)];
  }
  std::int64_t IndexAt(std::int64_t index) const { return index_at(index); }

  std::int64_t GetInt64(std::int64_t index) const;
  std::uint64_t GetUInt64(std::int64_t index) const {
    return static_cast<std::uint64_t>(GetInt64(index));
  }
  double GetDouble(std::int64_t index) const;
  bool GetBool(std::int64_t index) const { return GetInt64(index) != 0; }
  std::string GetString(std::int64_t index) const;
  std::string ToString(std::int64_t index) const { return GetString(index); }
  std::string GetValueAsString(std::int64_t index) const {
    return GetString(index);
  }
  std::vector<std::string> ToStrings(
      std::string null_value = "null") const;
  std::vector<std::string> values(
      std::string null_value = "null") const {
    return ToStrings(std::move(null_value));
  }

  Array Decoded() const;
  Array Decode() const { return Decoded(); }
  Array Materialize() const { return Decoded(); }

  bool Equals(const Array& other) const;
  bool operator==(const Array& other) const { return Equals(other); }
  bool operator!=(const Array& other) const { return !Equals(other); }

  Array Slice(std::int64_t offset, std::int64_t length) const;

  static Array Concatenate(const Array& first, const Array& second);
  static Array Concat(const Array& first, const Array& second) {
    return Concatenate(first, second);
  }

  void SetType(DataType type) {
    type_ = std::move(type);
    type_.Normalize();
  }

  // Public storage is deliberately simple so this remains easy to embed.
  DataType type_;
  DataType index_type_;
  std::int64_t length_ = 0;
  std::vector<std::uint8_t> validity_;
  std::vector<std::int64_t> ints_;
  std::vector<double> doubles_;
  std::vector<std::string> strings_;
  std::vector<std::vector<std::uint8_t>> binaries_;
  std::vector<std::int64_t> indices_;
  std::shared_ptr<const DictionaryGeneration> dictionary_;

 private:
  template <typename T>
  static Array FromSigned(const std::vector<T>& values, TypeId id) {
    Array array(DataType(id),
                static_cast<std::int64_t>(values.size()));
    array.ints_.reserve(values.size());
    for (T value : values) {
      array.ints_.push_back(static_cast<std::int64_t>(value));
    }
    return array;
  }

  template <typename T>
  static Array FromUnsigned(const std::vector<T>& values, TypeId id) {
    Array array(DataType(id),
                static_cast<std::int64_t>(values.size()));
    array.ints_.reserve(values.size());
    for (T value : values) {
      array.ints_.push_back(static_cast<std::int64_t>(value));
    }
    return array;
  }
};

struct DictionaryGeneration {
  std::int64_t id = -1;
  std::uint64_t generation = 0;
  bool is_delta = false;
  DataType value_type;
  DataType index_type = DataType::Int32();
  std::shared_ptr<const Array> values;
  std::shared_ptr<const Array> data;
  std::shared_ptr<const DictionaryGeneration> previous;
  std::uint64_t base_generation = 0;

  std::int64_t size() const {
    const std::shared_ptr<const Array>& array =
        values != nullptr ? values : data;
    return array == nullptr ? 0 : array->length();
  }
  const Array& array() const {
    static const Array empty;
    const std::shared_ptr<const Array>& source =
        values != nullptr ? values : data;
    return source == nullptr ? empty : *source;
  }
  const std::vector<std::string>& strings() const { return array().strings_; }
  const std::vector<std::int64_t>& ints() const { return array().ints_; }
  std::string ToString(std::int64_t index) const {
    return array().GetString(index);
  }
};

inline Array Array::FromIndices(
    std::vector<std::int64_t> indices,
    std::shared_ptr<const DictionaryGeneration> dictionary) {
  std::vector<std::uint8_t> validity(indices.size(), 1);
  return FromIndices(std::move(indices), std::move(dictionary),
                     std::move(validity));
}

inline Array Array::FromIndices(
    std::vector<std::int64_t> indices,
    std::shared_ptr<const DictionaryGeneration> dictionary,
    std::vector<std::uint8_t> validity) {
  Array array;
  if (dictionary != nullptr) {
    array.type_ = dictionary->value_type;
    array.index_type_ = dictionary->index_type;
  }
  array.length_ = static_cast<std::int64_t>(indices.size());
  array.indices_ = std::move(indices);
  array.dictionary_ = std::move(dictionary);
  if (validity.size() == static_cast<std::size_t>(array.length_) &&
      std::any_of(validity.begin(), validity.end(),
                  [](std::uint8_t value) { return value == 0; })) {
    array.validity_ = std::move(validity);
  }
  return array;
}

inline std::int64_t Array::GetInt64(std::int64_t index) const {
  if (index < 0 || index >= length_) {
    return 0;
  }
  const std::size_t pos = static_cast<std::size_t>(index);
  if (IsNull(index)) {
    return 0;
  }
  if (dictionary_ != nullptr) {
    if (pos >= indices_.size()) {
      return 0;
    }
    const std::int64_t dict_index = indices_[pos];
    if (dictionary_->values == nullptr || dict_index < 0 ||
        dict_index >= dictionary_->values->length()) {
      return 0;
    }
    return dictionary_->values->GetInt64(dict_index);
  }
  if (!ints_.empty() && pos < ints_.size()) {
    return ints_[pos];
  }
  if (!doubles_.empty() && pos < doubles_.size()) {
    return static_cast<std::int64_t>(doubles_[pos]);
  }
  return 0;
}

inline double Array::GetDouble(std::int64_t index) const {
  if (index < 0 || index >= length_) {
    return 0.0;
  }
  const std::size_t pos = static_cast<std::size_t>(index);
  if (IsNull(index)) {
    return 0.0;
  }
  if (dictionary_ != nullptr) {
    if (pos >= indices_.size()) {
      return 0.0;
    }
    const std::int64_t dict_index = indices_[pos];
    if (dictionary_->values == nullptr || dict_index < 0 ||
        dict_index >= dictionary_->values->length()) {
      return 0.0;
    }
    return dictionary_->values->GetDouble(dict_index);
  }
  if (!doubles_.empty() && pos < doubles_.size()) {
    return doubles_[pos];
  }
  if (!ints_.empty() && pos < ints_.size()) {
    return static_cast<double>(ints_[pos]);
  }
  return 0.0;
}

inline std::string Array::GetString(std::int64_t index) const {
  if (index < 0 || index >= length_) {
    return {};
  }
  const std::size_t pos = static_cast<std::size_t>(index);
  if (IsNull(index)) {
    return "null";
  }
  if (dictionary_ != nullptr) {
    if (pos >= indices_.size()) {
      return {};
    }
    const std::int64_t dict_index = indices_[pos];
    if (dictionary_->values == nullptr || dict_index < 0 ||
        dict_index >= dictionary_->values->length()) {
      return {};
    }
    return dictionary_->values->GetString(dict_index);
  }
  if (!strings_.empty() && pos < strings_.size()) {
    return strings_[pos];
  }
  if (!binaries_.empty() && pos < binaries_.size()) {
    const auto& bytes = binaries_[pos];
    return std::string(bytes.begin(), bytes.end());
  }
  if (type_.is_floating()) {
    double value = doubles_.empty() ? static_cast<double>(GetInt64(index))
                                    : doubles_[pos];
    std::ostringstream os;
    os.precision(std::numeric_limits<double>::max_digits10);
    os << value;
    return os.str();
  }
  if (type_.is_bool()) {
    return GetInt64(index) == 0 ? "false" : "true";
  }
  return std::to_string(GetInt64(index));
}

inline std::vector<std::string> Array::ToStrings(
    std::string null_value) const {
  std::vector<std::string> result;
  result.reserve(static_cast<std::size_t>(length_));
  for (std::int64_t i = 0; i < length_; ++i) {
    result.push_back(IsNull(i) ? null_value : GetString(i));
  }
  return result;
}

inline Array Array::Decoded() const {
  if (dictionary_ == nullptr) {
    return *this;
  }
  if (dictionary_->values == nullptr) {
    Array result(type_, length_);
    result.validity_.assign(static_cast<std::size_t>(length_), 0);
    return result;
  }
  const Array& dictionary_values = *dictionary_->values;
  Array result(dictionary_values.type_, length_);
  if (!validity_.empty()) {
    result.validity_ = validity_;
  } else if (dictionary_values.null_count() > 0) {
    result.validity_.assign(static_cast<std::size_t>(length_), 1);
  }
  const std::size_t count = static_cast<std::size_t>(length_);
  if (dictionary_values.type_.is_string()) {
    result.strings_.resize(count);
  } else if (dictionary_values.type_.id == TypeId::Binary ||
             dictionary_values.type_.id == TypeId::LargeBinary) {
    result.binaries_.resize(count);
  } else if (dictionary_values.type_.is_floating()) {
    result.doubles_.resize(count);
  } else if (!dictionary_values.type_.is_null()) {
    result.ints_.resize(count);
  }
  for (std::int64_t i = 0; i < length_; ++i) {
    if (IsNull(i)) {
      continue;
    }
    const std::int64_t dict_index = indices_[static_cast<std::size_t>(i)];
    if (dict_index < 0 || dict_index >= dictionary_values.length()) {
      result.validity_.assign(static_cast<std::size_t>(length_), 0);
      return result;
    }
    if (dictionary_values.IsNull(dict_index)) {
      if (result.validity_.empty()) {
        result.validity_.assign(static_cast<std::size_t>(length_), 1);
      }
      result.validity_[static_cast<std::size_t>(i)] = 0;
      continue;
    }
    if (!result.ints_.empty()) {
      result.ints_[static_cast<std::size_t>(i)] =
          dictionary_values.ints_[static_cast<std::size_t>(dict_index)];
    }
    if (!result.doubles_.empty()) {
      result.doubles_[static_cast<std::size_t>(i)] =
          dictionary_values.doubles_[static_cast<std::size_t>(dict_index)];
    }
    if (!result.strings_.empty()) {
      result.strings_[static_cast<std::size_t>(i)] =
          dictionary_values.strings_[static_cast<std::size_t>(dict_index)];
    }
    if (!result.binaries_.empty()) {
      result.binaries_[static_cast<std::size_t>(i)] =
          dictionary_values.binaries_[static_cast<std::size_t>(dict_index)];
    }
  }
  return result;
}

inline bool Array::Equals(const Array& other) const {
  if (length_ != other.length_ || type_ != other.type_) {
    return false;
  }
  if ((null_count() > 0) != (other.null_count() > 0)) {
    return false;
  }
  if (null_count() > 0 && validity_ != other.validity_) {
    return false;
  }
  if (is_dictionary() != other.is_dictionary()) {
    return is_dictionary() ? Decoded().Equals(other)
                           : other.Decoded().Equals(*this);
  }
  if (is_dictionary() || other.is_dictionary()) {
    if (indices_ != other.indices_) {
      return false;
    }
    if (dictionary_ == nullptr || other.dictionary_ == nullptr) {
      return dictionary_ == other.dictionary_;
    }
    if (dictionary_->value_type != other.dictionary_->value_type ||
        dictionary_->size() != other.dictionary_->size()) {
      return false;
    }
    return dictionary_->array() == other.dictionary_->array();
  }
  if (ints_ != other.ints_) {
    return false;
  }
  if (doubles_ != other.doubles_) {
    return false;
  }
  if (strings_ != other.strings_) {
    return false;
  }
  if (binaries_ != other.binaries_) {
    return false;
  }
  return true;
}

inline Array Array::Slice(std::int64_t offset, std::int64_t length) const {
  if (offset < 0 || length < 0 || offset + length > length_) {
    return {};
  }
  Array result = *this;
  result.length_ = length;
  const std::size_t begin = static_cast<std::size_t>(offset);
  const std::size_t end = static_cast<std::size_t>(offset + length);
  if (is_dictionary()) {
    result.indices_.assign(indices_.begin() + begin, indices_.begin() + end);
  } else {
    if (!ints_.empty()) {
      result.ints_.assign(ints_.begin() + begin, ints_.begin() + end);
    }
    if (!doubles_.empty()) {
      result.doubles_.assign(doubles_.begin() + begin, doubles_.begin() + end);
    }
    if (!strings_.empty()) {
      result.strings_.assign(strings_.begin() + begin, strings_.begin() + end);
    }
    if (!binaries_.empty()) {
      result.binaries_.assign(binaries_.begin() + begin,
                              binaries_.begin() + end);
    }
  }
  if (!validity_.empty()) {
    result.validity_.assign(validity_.begin() + begin, validity_.begin() + end);
  }
  return result;
}

inline Array Array::Concatenate(const Array& first, const Array& second) {
  if (first.type_ != second.type_) {
    return {};
  }
  if ((first.is_dictionary() != second.is_dictionary())) {
    return {};
  }
  Array result = first;
  result.length_ = first.length_ + second.length_;
  if (first.is_dictionary()) {
    result.indices_.insert(result.indices_.end(), second.indices_.begin(),
                           second.indices_.end());
  } else {
    result.ints_.insert(result.ints_.end(), second.ints_.begin(),
                        second.ints_.end());
    result.doubles_.insert(result.doubles_.end(), second.doubles_.begin(),
                           second.doubles_.end());
    result.strings_.insert(result.strings_.end(), second.strings_.begin(),
                           second.strings_.end());
    result.binaries_.insert(result.binaries_.end(), second.binaries_.begin(),
                            second.binaries_.end());
  }
  const bool first_has_nulls = !first.validity_.empty();
  const bool second_has_nulls = !second.validity_.empty();
  if (first_has_nulls || second_has_nulls) {
    std::vector<std::uint8_t> validity;
    validity.reserve(static_cast<std::size_t>(result.length_));
    for (std::int64_t i = 0; i < first.length_; ++i) {
      validity.push_back(first.IsNull(i) ? 0 : 1);
    }
    for (std::int64_t i = 0; i < second.length_; ++i) {
      validity.push_back(second.IsNull(i) ? 0 : 1);
    }
    result.validity_ = std::move(validity);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Record batches and messages
// ---------------------------------------------------------------------------

struct RecordBatch {
  Schema schema;
  std::vector<Array> columns;
  union {
    std::int64_t num_rows;
    std::int64_t length;
  };
  std::map<std::int64_t, std::shared_ptr<const DictionaryGeneration>>
      dictionaries;

  RecordBatch() { num_rows = 0; }
  explicit RecordBatch(std::vector<Array> batch_columns) {
    columns = std::move(batch_columns);
    num_rows = 0;
    for (const Array& column : columns) {
      num_rows = std::max(num_rows, column.length());
    }
  }
  RecordBatch(Schema batch_schema, std::vector<Array> batch_columns)
      : schema(std::move(batch_schema)), columns(std::move(batch_columns)) {
    num_rows = 0;
    for (const Array& column : columns) {
      num_rows = std::max(num_rows, column.length());
    }
  }
  RecordBatch(Schema batch_schema, std::initializer_list<Array> batch_columns)
      : RecordBatch(std::move(batch_schema),
                    std::vector<Array>(batch_columns)) {}
  RecordBatch(std::initializer_list<Array> batch_columns)
      : RecordBatch(std::vector<Array>(batch_columns)) {}

  std::int64_t row_count() const {
    if (num_rows != 0 || columns.empty()) {
      return num_rows;
    }
    return columns.front().length();
  }
  std::int64_t rows() const { return row_count(); }
  std::size_t num_columns() const { return columns.size(); }
  std::size_t column_count() const { return columns.size(); }
  std::size_t size() const { return columns.size(); }
  bool empty() const { return columns.empty() && num_rows == 0; }

  const Array& column(std::size_t index) const { return columns.at(index); }
  Array& column(std::size_t index) { return columns.at(index); }
  const Array& operator[](std::size_t index) const { return columns.at(index); }
  Array& operator[](std::size_t index) { return columns.at(index); }
  const Field& field(std::size_t index) const { return schema.fields.at(index); }
  const Schema& batch_schema() const { return schema; }

  RecordBatch Decoded() const {
    RecordBatch result = *this;
    for (Array& column : result.columns) {
      column = column.Decoded();
    }
    return result;
  }
  RecordBatch Decode() const { return Decoded(); }
  RecordBatch Materialize() const { return Decoded(); }

  bool Equals(const RecordBatch& other) const {
    if (columns.size() != other.columns.size() ||
        row_count() != other.row_count()) {
      return false;
    }
    for (std::size_t i = 0; i < columns.size(); ++i) {
      if (!(columns[i] == other.columns[i])) {
        return false;
      }
    }
    return true;
  }
  bool operator==(const RecordBatch& other) const { return Equals(other); }
  bool operator!=(const RecordBatch& other) const { return !Equals(other); }

  auto begin() const { return columns.begin(); }
  auto end() const { return columns.end(); }
  auto begin() { return columns.begin(); }
  auto end() { return columns.end(); }
};

struct DictionaryBatch {
  union {
    std::int64_t id;
    std::int64_t dictionary_id;
  };
  union {
    bool is_delta;
    bool isDelta;
  };
  Array values;
  Array data;
  union {
    std::int64_t offset;
    std::int64_t start_index;
  };

  DictionaryBatch() {
    id = -1;
    is_delta = false;
    offset = -1;
  }
  DictionaryBatch(std::int64_t dictionary_id, Array dictionary_values,
                  bool delta = false)
      : values(std::move(dictionary_values)) {
    id = dictionary_id;
    is_delta = delta;
    offset = -1;
  }
  DictionaryBatch(std::int64_t dictionary_id, bool delta,
                  Array dictionary_values)
      : values(std::move(dictionary_values)) {
    id = dictionary_id;
    is_delta = delta;
    offset = -1;
  }
  DictionaryBatch(std::int64_t dictionary_id,
                  const std::vector<std::string>& dictionary_values,
                  bool delta = false)
      : values(Array::FromUtf8(dictionary_values)) {
    id = dictionary_id;
    is_delta = delta;
    offset = -1;
  }
  DictionaryBatch(std::int64_t dictionary_id,
                  std::initializer_list<std::string> dictionary_values,
                  bool delta = false)
      : values(Array::FromUtf8(dictionary_values)) {
    id = dictionary_id;
    is_delta = delta;
    offset = -1;
  }

  bool delta() const { return is_delta; }
  Array effective_values() const {
    if (values.type().is_null() && values.length() == 0 &&
        !data.type().is_null()) {
      return data;
    }
    return values;
  }
};

enum class MessageType : std::uint8_t {
  Schema = 0,
  DictionaryBatch = 1,
  RecordBatch = 2,
  EndOfStream = 3,
  EOS = 3,
};

struct Message {
  MessageType type = MessageType::RecordBatch;
  Schema schema;
  DictionaryBatch dictionary_batch;
  RecordBatch record_batch;

  Message() = default;

  static Message SchemaMessage(Schema schema) {
    Message message;
    message.type = MessageType::Schema;
    message.schema = std::move(schema);
    return message;
  }
  static Message Dictionary(DictionaryBatch batch) {
    Message message;
    message.type = MessageType::DictionaryBatch;
    message.dictionary_batch = std::move(batch);
    return message;
  }
  static Message Dictionary(std::int64_t id, Array values,
                            bool is_delta = false) {
    return Dictionary(DictionaryBatch(id, std::move(values), is_delta));
  }
  static Message DictionaryMessage(DictionaryBatch batch) {
    return Dictionary(std::move(batch));
  }
  static Message DictionaryBatchMessage(DictionaryBatch batch) {
    return Dictionary(std::move(batch));
  }
  static Message Batch(RecordBatch batch) {
    Message message;
    message.type = MessageType::RecordBatch;
    message.record_batch = std::move(batch);
    return message;
  }
  static Message Record(RecordBatch batch) { return Batch(std::move(batch)); }
  static Message RecordBatchMessage(RecordBatch batch) {
    return Batch(std::move(batch));
  }
  static Message EndOfStream() {
    Message message;
    message.type = MessageType::EndOfStream;
    return message;
  }
  static Message EOS() { return EndOfStream(); }
  static Message End() { return EndOfStream(); }

  MessageType message_type() const { return type; }
  bool is_schema() const { return type == MessageType::Schema; }
  bool is_dictionary() const {
    return type == MessageType::DictionaryBatch;
  }
  bool is_record_batch() const { return type == MessageType::RecordBatch; }
  bool is_eos() const { return type == MessageType::EndOfStream; }
  RecordBatch& batch() { return record_batch; }
  const RecordBatch& batch() const { return record_batch; }
  DictionaryBatch& dictionary() { return dictionary_batch; }
  const DictionaryBatch& dictionary() const { return dictionary_batch; }
};

// ---------------------------------------------------------------------------
// Small result helpers
// ---------------------------------------------------------------------------

class BatchList : public std::vector<RecordBatch> {
 public:
  BatchList() = default;
  explicit BatchList(Status result) : status(std::move(result)) {}
  BatchList(Status result, std::vector<RecordBatch> records)
      : std::vector<RecordBatch>(std::move(records)),
        status(std::move(result)) {}

  bool ok() const { return status.ok(); }
  operator bool() const { return ok(); }
  operator Status() const { return status; }
  const Status& status_ref() const { return status; }
  Status& mutable_status() { return status; }
  std::vector<RecordBatch> Take() {
    std::vector<RecordBatch> result;
    result.swap(*this);
    return result;
  }

  Status status;
};

class DictionaryResult {
 public:
  DictionaryResult() = default;
  DictionaryResult(Status result,
                   const DictionaryGeneration* current_generation)
      : status_(std::move(result)), generation_(current_generation) {}

  bool ok() const { return status_.ok(); }
  operator bool() const { return ok(); }
  operator Status() const { return status_; }
  const Status& status() const { return status_; }
  const Status& result() const { return status_; }

  const DictionaryGeneration* get() const { return generation_; }
  const DictionaryGeneration* generation() const { return generation_; }
  const DictionaryGeneration* operator->() const { return generation_; }
  const DictionaryGeneration& operator*() const { return *generation_; }
  explicit operator const DictionaryGeneration*() const { return generation_; }

  friend bool operator==(const DictionaryResult& result, StatusCode code) {
    return result.status_ == code;
  }
  friend bool operator==(StatusCode code, const DictionaryResult& result) {
    return result == code;
  }
  friend bool operator==(const DictionaryResult& result, const Status& status) {
    return result.status_ == status;
  }
  friend bool operator==(const Status& status, const DictionaryResult& result) {
    return result == status;
  }
  friend bool operator==(const DictionaryResult& result, bool ok) {
    return result.ok() == ok;
  }
  friend bool operator==(bool ok, const DictionaryResult& result) {
    return result == ok;
  }

 private:
  Status status_;
  const DictionaryGeneration* generation_ = nullptr;
};

class BatchResult {
 public:
  BatchResult() = default;
  BatchResult(Status result, const RecordBatch* batch)
      : status_(std::move(result)), batch_(batch) {}

  bool ok() const { return status_.ok(); }
  operator bool() const { return ok(); }
  operator Status() const { return status_; }
  const Status& status() const { return status_; }
  const Status& result() const { return status_; }

  const RecordBatch* get() const { return batch_; }
  const RecordBatch* batch() const { return batch_; }
  const RecordBatch* operator->() const { return batch_; }
  const RecordBatch& operator*() const { return *batch_; }
  explicit operator const RecordBatch*() const { return batch_; }

  friend bool operator==(const BatchResult& result, StatusCode code) {
    return result.status_ == code;
  }
  friend bool operator==(StatusCode code, const BatchResult& result) {
    return result == code;
  }
  friend bool operator==(const BatchResult& result, const Status& status) {
    return result.status_ == status;
  }
  friend bool operator==(const BatchResult& result, bool ok) {
    return result.ok() == ok;
  }

 private:
  Status status_;
  const RecordBatch* batch_ = nullptr;
};

// ---------------------------------------------------------------------------
// Dictionary manager
// ---------------------------------------------------------------------------

class DictionaryManager {
 public:
  DictionaryManager() = default;

  Status RegisterField(const Field& field) {
    return ValidateAndRegisterField(field, true);
  }
  Status register_field(const Field& field) { return RegisterField(field); }
  Status AddField(const Field& field) { return RegisterField(field); }
  Status AddField(std::string name, std::int64_t dictionary_id,
                  DataType value_type,
                  DataType index_type = DataType::Int32()) {
    return RegisterField(Field(std::move(name), std::move(value_type),
                               dictionary_id, std::move(index_type)));
  }
  Status AddField(std::string name, DataType value_type,
                  std::int64_t dictionary_id,
                  DataType index_type = DataType::Int32()) {
    return AddField(std::move(name), dictionary_id, std::move(value_type),
                    std::move(index_type));
  }
  Status RegisterDictionaryField(std::string name,
                                 std::int64_t dictionary_id,
                                 DataType value_type,
                                 DataType index_type = DataType::Int32()) {
    return AddField(std::move(name), dictionary_id, std::move(value_type),
                    std::move(index_type));
  }
  Status RegisterSchema(const Schema& schema) {
    std::unordered_map<std::int64_t, std::pair<DataType, DataType>> pending;
    for (const Field& field : schema.fields) {
      Status status = ValidateField(field);
      if (!status.ok()) {
        return status;
      }
      if (field.has_dictionary()) {
        const std::int64_t id = field.effective_dictionary_id();
        const DataType value_type = field.value_type();
        const DataType index_type = field.dictionary_index_type();
        auto it = pending.find(id);
        if (it != pending.end()) {
          if ((!it->second.first.is_null() && !value_type.is_null() &&
               it->second.first != value_type) ||
              (!it->second.second.is_null() && !index_type.is_null() &&
               it->second.second != index_type)) {
            return Status::TypeMismatch(
                "fields sharing dictionary id " + std::to_string(id) +
                " in one schema disagree on types");
          }
        } else {
          pending.emplace(id, std::make_pair(value_type, index_type));
        }
      }
    }
    for (const Field& field : schema.fields) {
      Status status = ValidateAndRegisterField(field, true);
      if (!status.ok()) {
        return status;
      }
    }
    schema_ = schema;
    has_schema_ = true;
    return Status::Ok();
  }
  Status register_schema(const Schema& schema) {
    return RegisterSchema(schema);
  }
  Status AddSchema(const Schema& schema) { return RegisterSchema(schema); }
  Status SetSchema(const Schema& schema) { return RegisterSchema(schema); }

  DictionaryResult AddDictionary(const DictionaryBatch& batch) {
    if (batch.id < 0) {
      return DictionaryResult(
          Status::Invalid("dictionary id must be non-negative"), nullptr);
    }
    return AddDictionary(batch.id, batch.effective_values(),
                         batch.is_delta, batch.offset);
  }
  DictionaryResult AddDictionaryBatch(const DictionaryBatch& batch) {
    return AddDictionary(batch);
  }
  DictionaryResult add_dictionary(const DictionaryBatch& batch) {
    return AddDictionary(batch);
  }
  DictionaryResult add_dictionary(std::int64_t id, const Array& values,
                                  bool is_delta = false) {
    return AddDictionary(id, values, is_delta);
  }
  DictionaryResult AddDictionary(std::int64_t id, const Array& values,
                                 bool is_delta = false) {
    return AddDictionary(id, values, is_delta, -1);
  }
  DictionaryResult AddDictionary(std::int64_t id, bool is_delta,
                                 const Array& values) {
    return AddDictionary(id, values, is_delta, -1);
  }
  DictionaryResult AddDictionary(std::int64_t id,
                                 const std::vector<std::string>& values,
                                 bool is_delta = false) {
    return AddDictionary(id, Array::FromUtf8(values), is_delta, -1);
  }
  DictionaryResult AddDictionary(std::int64_t id, bool is_delta,
                                 const std::vector<std::string>& values) {
    return AddDictionary(id, Array::FromUtf8(values), is_delta, -1);
  }
  DictionaryResult AddDictionary(std::int64_t id,
                                 std::initializer_list<std::string> values,
                                 bool is_delta = false) {
    return AddDictionary(id, Array::FromUtf8(values), is_delta, -1);
  }
  DictionaryResult AddDictionary(std::int64_t id, const Array& values,
                                 bool is_delta, std::int64_t offset) {
    if (id < 0) {
      return DictionaryResult(
          Status::Invalid("dictionary id must be non-negative"), nullptr);
    }
    auto state_it = dictionaries_.find(id);
    DictState* state =
        state_it == dictionaries_.end() ? nullptr : &state_it->second;

    Array incoming = values.is_dictionary() ? values.Decoded() : values;
    if (incoming.type().is_null() && incoming.length() == 0 && state != nullptr &&
        !state->value_type.is_null()) {
      incoming.SetType(state->value_type);
    }

    DataType value_type = incoming.type();
    if (state != nullptr && !state->value_type.is_null() &&
        !value_type.is_null() && state->value_type != value_type) {
      return DictionaryResult(
          Status::TypeMismatch("dictionary " + std::to_string(id) +
                               " value type mismatch: expected " +
                               state->value_type.name() + ", got " +
                               value_type.name()),
          Current(id));
    }

    const DictionaryGeneration* previous = Current(id);
    if (is_delta) {
      if (previous == nullptr) {
        return DictionaryResult(
            Status::InvalidState("dictionary delta for id " +
                                 std::to_string(id) +
                                 " has no base dictionary"),
            nullptr);
      }
      const std::int64_t current_size = previous->size();
      if (offset >= 0 && offset != current_size) {
        return DictionaryResult(
            Status::OutOfRange("dictionary delta offset " +
                               std::to_string(offset) +
                               " is out of bounds for current size " +
                               std::to_string(current_size)),
            previous);
      }
      if (offset < -1) {
        return DictionaryResult(
            Status::OutOfRange("dictionary delta offset is negative"),
            previous);
      }
    } else if (offset >= 0 && offset != 0) {
      return DictionaryResult(
          Status::OutOfRange("full dictionary offset must be zero"),
          previous);
    }

    if (state == nullptr) {
      DictState fresh;
      fresh.value_type = value_type;
      fresh.index_type = DataType();
      state = &dictionaries_.emplace(id, std::move(fresh)).first->second;
    }
    if (state->value_type.is_null() && !value_type.is_null()) {
      state->value_type = value_type;
    }

    const std::int64_t base_size =
        is_delta && previous != nullptr ? previous->size() : 0;
    if (incoming.length() >
        std::numeric_limits<std::int64_t>::max() - base_size) {
      return DictionaryResult(
          Status::OutOfRange("dictionary size overflows int64"),
          previous);
    }
    const std::int64_t next_size = base_size + incoming.length();
    const std::int64_t capacity =
        DictionaryIndexCapacity(state->index_type);
    if (capacity > 0 && next_size > capacity) {
      return DictionaryResult(
          Status::OutOfRange(
              "dictionary delta would exceed the capacity of index type " +
              state->index_type.name()),
          previous);
    }

    std::shared_ptr<const Array> full_values;
    if (is_delta) {
      Array combined = Array::Concatenate(previous->array(), incoming);
      if (combined.length() !=
          previous->size() + incoming.length()) {
        return DictionaryResult(
            Status::TypeMismatch("dictionary delta type mismatch for id " +
                                 std::to_string(id)),
            previous);
      }
      full_values = std::make_shared<const Array>(std::move(combined));
    } else {
      Array copy = incoming;
      full_values = std::make_shared<const Array>(std::move(copy));
    }

    auto generation = std::make_shared<DictionaryGeneration>();
    generation->id = id;
    generation->generation =
        previous == nullptr ? 1 : previous->generation + 1;
    generation->is_delta = is_delta;
    generation->value_type = state->value_type;
    generation->index_type = state->index_type;
    generation->values = std::move(full_values);
    generation->data = generation->values;
    if (previous != nullptr) {
      generation->previous = state->generations.back();
      generation->base_generation = previous->generation;
    }
    state->generations.push_back(generation);
    return DictionaryResult(Status::Ok(), generation.get());
  }

  DictionaryResult AddDelta(std::int64_t id, const Array& values) {
    return AddDictionary(id, values, true, -1);
  }
  DictionaryResult add_delta(std::int64_t id, const Array& values) {
    return AddDelta(id, values);
  }
  DictionaryResult AddDelta(std::int64_t id,
                            const std::vector<std::string>& values) {
    return AddDictionary(id, Array::FromUtf8(values), true, -1);
  }
  DictionaryResult AddDelta(std::int64_t id,
                            std::initializer_list<std::string> values) {
    return AddDictionary(id, Array::FromUtf8(values), true, -1);
  }
  DictionaryResult AddDelta(std::int64_t id, std::int64_t offset,
                            const Array& values) {
    return AddDictionary(id, values, true, offset);
  }
  DictionaryResult AddDelta(std::int64_t id, const Array& values,
                            std::int64_t offset) {
    return AddDictionary(id, values, true, offset);
  }
  DictionaryResult AppendDictionary(std::int64_t id, const Array& values) {
    return AddDelta(id, values);
  }

  BatchResult AddRecordBatch(RecordBatch batch) {
    Status status = PrepareRecordBatch(&batch, true);
    if (!status.ok()) {
      return BatchResult(std::move(status), nullptr);
    }
    batches_.push_back(std::move(batch));
    return BatchResult(Status::Ok(), &batches_.back());
  }
  BatchResult add_record_batch(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult AddRecordBatch(const Schema& schema,
                             std::vector<Array> columns) {
    return AddRecordBatch(RecordBatch(schema, std::move(columns)));
  }
  BatchResult AddRecordBatch(std::vector<Array> columns) {
    return AddRecordBatch(RecordBatch(std::move(columns)));
  }
  BatchResult Enqueue(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult Enqueue(const Schema& schema, std::vector<Array> columns) {
    return AddRecordBatch(schema, std::move(columns));
  }
  BatchResult Push(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult AddBatch(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult AppendBatch(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult QueueBatch(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }
  BatchResult SubmitBatch(RecordBatch batch) {
    return AddRecordBatch(std::move(batch));
  }

  Status AddMessage(const Message& message) {
    switch (message.type) {
      case MessageType::Schema:
        return RegisterSchema(message.schema);
      case MessageType::DictionaryBatch:
        return AddDictionary(message.dictionary_batch).status();
      case MessageType::RecordBatch:
        return AddRecordBatch(message.record_batch).status();
      case MessageType::EndOfStream:
        return Status::Ok();
    }
    return Status::Invalid("unknown message type");
  }
  Status PushMessage(const Message& message) { return AddMessage(message); }
  Status Receive(const Message& message) { return AddMessage(message); }

  const DictionaryGeneration* GetDictionary(std::int64_t id) const {
    return Current(id);
  }
  std::shared_ptr<const DictionaryGeneration> GetDictionaryShared(
      std::int64_t id) const {
    return CurrentShared(id);
  }
  std::shared_ptr<const DictionaryGeneration> GetDictionaryPtr(
      std::int64_t id) const {
    return CurrentShared(id);
  }
  const DictionaryGeneration* GetGeneration(std::int64_t id) const {
    return Current(id);
  }
  const DictionaryGeneration* GetGeneration(std::int64_t id,
                                            std::uint64_t generation) const {
    return FindGeneration(id, generation);
  }
  const DictionaryGeneration* Current(std::int64_t id) const {
    auto it = dictionaries_.find(id);
    if (it == dictionaries_.end() || it->second.generations.empty()) {
      return nullptr;
    }
    return it->second.generations.back().get();
  }
  const DictionaryGeneration* CurrentDictionary(std::int64_t id) const {
    return Current(id);
  }
  const Array* GetDictionaryValues(std::int64_t id) const {
    const DictionaryGeneration* generation = Current(id);
    return generation == nullptr ? nullptr : generation->values.get();
  }
  const Array* dictionary_values(std::int64_t id) const {
    return GetDictionaryValues(id);
  }
  bool HasDictionary(std::int64_t id) const { return Current(id) != nullptr; }
  bool has_dictionary(std::int64_t id) const { return HasDictionary(id); }
  std::size_t GenerationCount(std::int64_t id) const {
    auto it = dictionaries_.find(id);
    return it == dictionaries_.end() ? 0 : it->second.generations.size();
  }
  std::size_t generation_count(std::int64_t id) const {
    return GenerationCount(id);
  }

  const std::vector<std::shared_ptr<const DictionaryGeneration>>&
  Generations(std::int64_t id) const {
    static const std::vector<
        std::shared_ptr<const DictionaryGeneration>>
        empty;
    auto it = dictionaries_.find(id);
    return it == dictionaries_.end() ? empty : it->second.generations;
  }
  const std::vector<std::shared_ptr<const DictionaryGeneration>>&
  generations(std::int64_t id) const {
    return Generations(id);
  }
  const std::unordered_map<std::int64_t, std::vector<
      std::shared_ptr<const DictionaryGeneration>>>&
  dictionary_generations() const {
    static_assert(sizeof(DictState) > 0, "");
    generations_view_.clear();
    for (const auto& entry : dictionaries_) {
      generations_view_[entry.first] = entry.second.generations;
    }
    return generations_view_;
  }

  const Schema& schema() const { return schema_; }
  bool has_schema() const { return has_schema_; }
  const std::vector<RecordBatch>& batches() const { return batches_; }
  const std::vector<RecordBatch>& records() const { return batches_; }
  const std::vector<RecordBatch>& queued() const { return batches_; }
  std::size_t size() const { return batches_.size(); }
  std::size_t batch_count() const { return batches_.size(); }
  bool empty() const { return batches_.empty(); }
  const RecordBatch* GetBatch(std::size_t index) const {
    if (index >= batches_.size()) {
      return nullptr;
    }
    return &batches_[index];
  }
  const RecordBatch* batch(std::size_t index) const {
    return GetBatch(index);
  }
  const RecordBatch& at(std::size_t index) const { return batches_.at(index); }

  std::optional<RecordBatch> TakeBatch() {
    if (batches_.empty()) {
      return std::nullopt;
    }
    RecordBatch result = std::move(batches_.front());
    batches_.erase(batches_.begin());
    return result;
  }
  std::optional<RecordBatch> PopBatch() { return TakeBatch(); }
  bool PopBatch(RecordBatch* out) {
    if (out == nullptr || batches_.empty()) {
      return false;
    }
    *out = std::move(batches_.front());
    batches_.erase(batches_.begin());
    return true;
  }
  std::vector<RecordBatch> TakeBatches() {
    std::vector<RecordBatch> result;
    result.swap(batches_);
    return result;
  }
  std::vector<RecordBatch> Drain() { return TakeBatches(); }

  const Status& status() const { return last_status_; }
  const Status& last_status() const { return last_status_; }
  void Reset(bool keep_schema = false) {
    dictionaries_.clear();
    batches_.clear();
    last_status_ = Status::Ok();
    if (!keep_schema) {
      schema_ = Schema();
      has_schema_ = false;
    }
  }

  const std::unordered_map<std::int64_t, Field>& dictionary_fields() const {
    return dictionary_fields_;
  }

 private:
  struct DictState {
    DataType value_type;
    DataType index_type = DataType::Int32();
    std::vector<std::shared_ptr<const DictionaryGeneration>> generations;
  };

  const DictionaryGeneration* FindGeneration(std::int64_t id,
                                             std::uint64_t generation) const {
    auto it = dictionaries_.find(id);
    if (it == dictionaries_.end()) {
      return nullptr;
    }
    for (const auto& candidate : it->second.generations) {
      if (candidate->generation == generation) {
        return candidate.get();
      }
    }
    return nullptr;
  }

  static std::int64_t DictionaryIndexCapacity(const DataType& index_type) {
    switch (index_type.id) {
      case TypeId::Int8:
        return static_cast<std::int64_t>(1) << 7;
      case TypeId::UInt8:
        return static_cast<std::int64_t>(1) << 8;
      case TypeId::Int16:
        return static_cast<std::int64_t>(1) << 15;
      case TypeId::UInt16:
        return static_cast<std::int64_t>(1) << 16;
      case TypeId::Int32:
        return static_cast<std::int64_t>(1) << 31;
      case TypeId::UInt32:
        return static_cast<std::int64_t>(1) << 32;
      default:
        return 0;
    }
  }

  std::shared_ptr<const DictionaryGeneration> CurrentShared(
      std::int64_t id) const {
    auto it = dictionaries_.find(id);
    if (it == dictionaries_.end() || it->second.generations.empty()) {
      return nullptr;
    }
    return it->second.generations.back();
  }

  Status ValidateField(const Field& field) const {
    if (!field.has_dictionary()) {
      return Status::Ok();
    }
    const std::int64_t id = field.effective_dictionary_id();
    if (id < 0) {
      return Status::Invalid("dictionary field must have a non-negative id");
    }
    const DataType value_type = field.value_type();
    const DataType index_type = field.dictionary_index_type();
    if (value_type.is_dictionary() || value_type.id == TypeId::Unknown) {
      return Status::Invalid("invalid dictionary value type");
    }
    auto it = dictionaries_.find(id);
    if (it == dictionaries_.end()) {
      return Status::Ok();
    }
    const DictState& state = it->second;
    if (!state.value_type.is_null() && !value_type.is_null() &&
        state.value_type != value_type) {
      return Status::TypeMismatch(
          "fields sharing dictionary id " + std::to_string(id) +
          " disagree on value type: " + state.value_type.name() + " vs " +
          value_type.name());
    }
    const bool has_registered_field =
        dictionary_fields_.find(id) != dictionary_fields_.end();
    if (has_registered_field && !state.index_type.is_null() &&
        !index_type.is_null() && state.index_type != index_type) {
      return Status::TypeMismatch(
          "fields sharing dictionary id " + std::to_string(id) +
          " disagree on index type: " + state.index_type.name() + " vs " +
          index_type.name());
    }
    if (!state.generations.empty() && !value_type.is_null()) {
      const auto& values = state.generations.back()->values;
      if (values != nullptr && !values->type().is_null() &&
          values->type() != value_type) {
        return Status::TypeMismatch(
            "field for dictionary id " + std::to_string(id) +
            " does not match existing dictionary value type");
      }
      const std::int64_t capacity = DictionaryIndexCapacity(index_type);
      if (capacity > 0 && state.generations.back()->size() > capacity) {
        return Status::OutOfRange(
            "dictionary id " + std::to_string(id) +
            " does not fit the declared index type " + index_type.name());
      }
    }
    return Status::Ok();
  }

  Status ValidateAndRegisterField(const Field& field, bool apply) {
    Status status = ValidateField(field);
    if (!status.ok() || !apply || !field.has_dictionary()) {
      return status;
    }
    const std::int64_t id = field.effective_dictionary_id();
    const bool had_field =
        dictionary_fields_.find(id) != dictionary_fields_.end();
    auto it = dictionaries_.find(id);
    if (it == dictionaries_.end()) {
      DictState state;
      state.value_type = field.value_type();
      state.index_type = field.dictionary_index_type();
      dictionaries_.emplace(id, std::move(state));
    } else {
      if (it->second.value_type.is_null()) {
        it->second.value_type = field.value_type();
      }
      if (!had_field || it->second.index_type.is_null()) {
        it->second.index_type = field.dictionary_index_type();
        for (auto& generation : it->second.generations) {
          if (generation->index_type.is_null()) {
            auto updated =
                std::make_shared<DictionaryGeneration>(*generation);
            updated->index_type = it->second.index_type;
            generation = std::move(updated);
          }
        }
      }
    }
    dictionary_fields_.emplace(id, field);
    return Status::Ok();
  }

  Status EnsureFieldForColumn(std::size_t index, const Array& column,
                              Schema* schema) {
    if (index < schema->fields.size()) {
      return Status::Ok();
    }
    Field field;
    field.name = "column_" + std::to_string(index);
    if (column.is_dictionary()) {
      field.type = column.dictionary()->value_type;
      field.dictionary_id = column.dictionary()->id;
      field.index_type = column.dictionary()->index_type;
    } else {
      field.type = column.type();
    }
    return ValidateAndRegisterField(field, true);
  }

  Status PrepareRecordBatch(RecordBatch* batch, bool register_schema) {
    if (batch == nullptr) {
      return Status::Invalid("null record batch");
    }
    Schema working = batch->schema;
    if (!working.fields.empty()) {
      Status status = register_schema ? RegisterSchema(working)
                                      : ValidateSchemaOnly(working);
      if (!status.ok()) {
        return status;
      }
    } else if (has_schema_) {
      working = schema_;
    }
    for (std::size_t i = 0; i < batch->columns.size(); ++i) {
      Status status = EnsureFieldForColumn(i, batch->columns[i], &working);
      if (!status.ok()) {
        return status;
      }
    }
    if (working.fields.size() < batch->columns.size()) {
      return Status::Invalid("schema does not describe every column");
    }

    std::int64_t row_count = batch->num_rows;
    if (row_count == 0 && !batch->columns.empty()) {
      row_count = batch->columns.front().length();
    }
    for (const Array& column : batch->columns) {
      if (column.length() != row_count) {
        return Status::Invalid("record batch columns have different lengths");
      }
    }

    for (std::size_t i = 0; i < batch->columns.size(); ++i) {
      const Field& field = working.fields[i];
      Array& column = batch->columns[i];
      if (!field.has_dictionary()) {
        if (column.is_dictionary()) {
          return Status::TypeMismatch(
              "dictionary-encoded column for non-dictionary field");
        }
        if (!field.type.is_null() && column.type() != field.type) {
          return Status::TypeMismatch(
              "column " + std::to_string(i) + " type mismatch: expected " +
              field.type.name() + ", got " + column.type().name());
        }
        continue;
      }

      const std::int64_t id = field.effective_dictionary_id();
      std::shared_ptr<const DictionaryGeneration> generation;
      if (column.is_dictionary()) {
        generation = column.dictionary();
        if (generation == nullptr) {
          return Status::InvalidState("dictionary array has no generation");
        }
        if (generation->id >= 0 && generation->id != id) {
          return Status::TypeMismatch(
              "dictionary array id does not match field id");
        }
      } else {
        generation = CurrentShared(id);
        if (generation == nullptr) {
          return Status::NotFound("no dictionary received for id " +
                                  std::to_string(id));
        }
      }
      if (generation->value_type != field.value_type()) {
        if (generation->size() == 0 && generation->value_type.is_null()) {
          auto retyped = std::make_shared<DictionaryGeneration>(*generation);
          retyped->value_type = field.value_type();
          retyped->values = std::make_shared<const Array>(
              Array(field.value_type(), 0));
          retyped->data = retyped->values;
          generation = std::move(retyped);
          if (column.is_dictionary()) {
            column.type_ = field.value_type();
            column.dictionary_ = generation;
          }
        } else {
          return Status::TypeMismatch(
              "dictionary id " + std::to_string(id) +
              " value type does not match field type");
        }
      }

      const bool materialized =
          !column.is_dictionary() && column.type() == field.value_type() &&
          !column.type().is_integer();
      if (column.is_dictionary()) {
        if (column.index_type_.is_null()) {
          column.index_type_ = field.dictionary_index_type();
        }
        for (std::int64_t row = 0; row < column.length(); ++row) {
          if (column.IsNull(row)) {
            continue;
          }
          const std::int64_t dict_index = column.index_at(row);
          if (dict_index < 0 || dict_index >= generation->size()) {
            return Status::OutOfRange(
                "dictionary index " + std::to_string(dict_index) +
                " for id " + std::to_string(id) + " is outside [0, " +
                std::to_string(generation->size()) + ")");
          }
        }
      } else if (!materialized) {
        if (!column.type().is_integer()) {
          return Status::TypeMismatch(
              "dictionary indices for field " + field.name +
              " must be integers");
        }
        for (std::int64_t row = 0; row < column.length(); ++row) {
          if (column.IsNull(row)) {
            continue;
          }
          const std::int64_t dict_index = column.GetInt64(row);
          if (dict_index < 0 || dict_index >= generation->size()) {
            return Status::OutOfRange(
                "dictionary index " + std::to_string(dict_index) +
                " for id " + std::to_string(id) + " is outside [0, " +
                std::to_string(generation->size()) + ")");
          }
        }
        std::vector<std::int64_t> indices;
        indices.reserve(static_cast<std::size_t>(column.length()));
        for (std::int64_t row = 0; row < column.length(); ++row) {
          indices.push_back(column.IsNull(row) ? 0 : column.GetInt64(row));
        }
        column = Array::FromIndices(std::move(indices), generation,
                                    column.validity());
        column.index_type_ = field.dictionary_index_type();
      }
      batch->dictionaries[id] = generation;
    }
    batch->schema = working;
    batch->num_rows = row_count;
    return Status::Ok();
  }

  Status ValidateSchemaOnly(const Schema& schema) {
    for (const Field& field : schema.fields) {
      Status status = ValidateField(field);
      if (!status.ok()) {
        return status;
      }
    }
    return Status::Ok();
  }

  std::unordered_map<std::int64_t, DictState> dictionaries_;
  std::unordered_map<std::int64_t, Field> dictionary_fields_;
  mutable std::unordered_map<
      std::int64_t,
      std::vector<std::shared_ptr<const DictionaryGeneration>>>
      generations_view_;
  Schema schema_;
  bool has_schema_ = false;
  std::vector<RecordBatch> batches_;
  Status last_status_;
};

using DictionaryMemo = DictionaryManager;
using DictionaryRegistry = DictionaryManager;
using DictionaryStore = DictionaryManager;
using IpcDictionaryManager = DictionaryManager;
using ArrowIpcDictionaryManager = DictionaryManager;
using DictionaryDeltaManager = DictionaryManager;
using Dictionary = DictionaryGeneration;
using DictionaryGenerationPtr =
    std::shared_ptr<const DictionaryGeneration>;

// ---------------------------------------------------------------------------
// Chunk-safe message codec
// ---------------------------------------------------------------------------

namespace detail {

class ByteWriter {
 public:
  void U8(std::uint8_t value) { data_.push_back(value); }
  void U16(std::uint16_t value) {
    for (int shift = 0; shift < 16; shift += 8) {
      data_.push_back(static_cast<std::uint8_t>(value >> shift));
    }
  }
  void U32(std::uint32_t value) {
    for (int shift = 0; shift < 32; shift += 8) {
      data_.push_back(static_cast<std::uint8_t>(value >> shift));
    }
  }
  void U64(std::uint64_t value) {
    for (int shift = 0; shift < 64; shift += 8) {
      data_.push_back(static_cast<std::uint8_t>(value >> shift));
    }
  }
  void I64(std::int64_t value) {
    U64(static_cast<std::uint64_t>(value));
  }
  void F64(double value) {
    std::uint64_t bits = 0;
    static_assert(sizeof(bits) == sizeof(value), "unexpected double size");
    std::memcpy(&bits, &value, sizeof(bits));
    U64(bits);
  }
  void Raw(const void* data, std::size_t size) {
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    data_.insert(data_.end(), bytes, bytes + size);
  }
  void String(std::string_view value) {
    U32(static_cast<std::uint32_t>(value.size()));
    data_.insert(data_.end(), value.begin(), value.end());
  }

  const std::vector<std::uint8_t>& data() const { return data_; }
  std::vector<std::uint8_t> Take() { return std::move(data_); }

 private:
  std::vector<std::uint8_t> data_;
};

class ByteReader {
 public:
  ByteReader(const std::uint8_t* data, std::size_t size)
      : data_(data), size_(size) {}

  bool ok() const { return ok_; }
  const Status& status() const { return status_; }
  std::size_t offset() const { return offset_; }
  std::size_t remaining() const { return size_ - offset_; }

  bool Need(std::size_t size) {
    if (!ok_) {
      return false;
    }
    if (size > size_ - offset_) {
      ok_ = false;
      status_ = Status::Truncated("truncated message payload");
      return false;
    }
    return true;
  }

  std::uint8_t U8() {
    if (!Need(1)) {
      return 0;
    }
    return data_[offset_++];
  }
  std::uint16_t U16() {
    if (!Need(2)) {
      return 0;
    }
    std::uint16_t value = 0;
    for (int shift = 0; shift < 16; shift += 8) {
      value |= static_cast<std::uint16_t>(data_[offset_++]) << shift;
    }
    return value;
  }
  std::uint32_t U32() {
    if (!Need(4)) {
      return 0;
    }
    std::uint32_t value = 0;
    for (int shift = 0; shift < 32; shift += 8) {
      value |= static_cast<std::uint32_t>(data_[offset_++]) << shift;
    }
    return value;
  }
  std::uint64_t U64() {
    if (!Need(8)) {
      return 0;
    }
    std::uint64_t value = 0;
    for (int shift = 0; shift < 64; shift += 8) {
      value |= static_cast<std::uint64_t>(data_[offset_++]) << shift;
    }
    return value;
  }
  std::int64_t I64() { return static_cast<std::int64_t>(U64()); }
  double F64() {
    const std::uint64_t bits = U64();
    double value = 0.0;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
  }
  const std::uint8_t* Raw(std::size_t size) {
    if (!Need(size)) {
      return nullptr;
    }
    const std::uint8_t* result = data_ + offset_;
    offset_ += size;
    return result;
  }
  std::string String() {
    const std::uint32_t size = U32();
    if (!ok_ || size > size_ - offset_) {
      ok_ = false;
      if (status_.ok()) {
        status_ = Status::Truncated("truncated string");
      }
      return {};
    }
    std::string value(reinterpret_cast<const char*>(data_ + offset_), size);
    offset_ += size;
    return value;
  }

  void Fail(Status status) {
    if (ok_) {
      ok_ = false;
      status_ = std::move(status);
    }
  }

 private:
  const std::uint8_t* data_ = nullptr;
  std::size_t size_ = 0;
  std::size_t offset_ = 0;
  bool ok_ = true;
  Status status_;
};

inline void WriteType(ByteWriter* writer, const DataType& type) {
  writer->U8(static_cast<std::uint8_t>(type.id));
  writer->U32(static_cast<std::uint32_t>(type.byte_width));
  writer->U32(static_cast<std::uint32_t>(type.precision));
  writer->U32(static_cast<std::uint32_t>(type.scale));
  writer->String(type.timezone);
  writer->U8(type.index_type != nullptr ? 1 : 0);
  if (type.index_type != nullptr) {
    WriteType(writer, *type.index_type);
  }
  writer->U8(type.value_type != nullptr ? 1 : 0);
  if (type.value_type != nullptr) {
    WriteType(writer, *type.value_type);
  }
}

inline DataType ReadType(ByteReader* reader) {
  DataType type;
  type.id = static_cast<TypeId>(reader->U8());
  type.byte_width = static_cast<std::int32_t>(reader->U32());
  type.precision = static_cast<std::int32_t>(reader->U32());
  type.scale = static_cast<std::int32_t>(reader->U32());
  type.timezone = reader->String();
  if (reader->U8() != 0) {
    type.index_type = std::make_shared<DataType>(ReadType(reader));
  }
  if (reader->U8() != 0) {
    type.value_type = std::make_shared<DataType>(ReadType(reader));
  }
  if (!reader->ok()) {
    return DataType();
  }
  return type;
}

inline void WriteField(ByteWriter* writer, const Field& field) {
  writer->String(field.name);
  WriteType(writer, field.type);
  writer->I64(field.dictionary_id);
  WriteType(writer, field.index_type);
  writer->U8(field.nullable ? 1 : 0);
  writer->U8(field.ordered ? 1 : 0);
}

inline Field ReadField(ByteReader* reader) {
  Field field;
  field.name = reader->String();
  field.type = ReadType(reader);
  field.dictionary_id = reader->I64();
  field.index_type = ReadType(reader);
  field.nullable = reader->U8() != 0;
  field.ordered = reader->U8() != 0;
  return field;
}

inline void WriteSchema(ByteWriter* writer, const Schema& schema) {
  writer->U32(static_cast<std::uint32_t>(schema.fields.size()));
  for (const Field& field : schema.fields) {
    WriteField(writer, field);
  }
}

inline Schema ReadSchema(ByteReader* reader) {
  Schema schema;
  const std::uint32_t count = reader->U32();
  schema.fields.reserve(count);
  for (std::uint32_t i = 0; i < count && reader->ok(); ++i) {
    schema.fields.push_back(ReadField(reader));
  }
  return schema;
}

inline bool IsIntEncodedType(const DataType& type) {
  return type.is_bool() || type.is_integer() || type.id == TypeId::Date32 ||
         type.id == TypeId::Date64 || type.id == TypeId::Time32 ||
         type.id == TypeId::Time64 || type.id == TypeId::Timestamp ||
         type.id == TypeId::Duration || type.id == TypeId::Interval ||
         type.id == TypeId::Decimal128 || type.id == TypeId::Decimal256;
}

inline void WriteArray(ByteWriter* writer, const Array& array) {
  WriteType(writer, array.type());
  writer->I64(array.length());
  writer->U8(array.validity().empty() ? 0 : 1);
  if (!array.validity().empty()) {
    writer->Raw(array.validity().data(), array.validity().size());
  }
  writer->U8(array.is_dictionary() ? 1 : 0);
  if (array.is_dictionary()) {
    const auto& dictionary = array.dictionary();
    WriteType(writer, array.index_type());
    writer->I64(dictionary->id);
    writer->U64(dictionary->generation);
    WriteType(writer, dictionary->value_type);
    WriteArray(writer, dictionary->array());
    writer->U64(static_cast<std::uint64_t>(array.indices().size()));
    for (std::int64_t index : array.indices()) {
      writer->I64(index);
    }
    return;
  }
  if (array.type().is_string() || array.type().id == TypeId::Binary ||
      array.type().id == TypeId::LargeBinary) {
    for (std::int64_t i = 0; i < array.length(); ++i) {
      if (array.type().is_string()) {
        const std::string value = array.string_values().empty()
                                      ? std::string()
                                      : array.string_values()[static_cast<
                                            std::size_t>(i)];
        writer->String(value);
      } else {
        if (array.binary_values().empty()) {
          writer->U32(0);
        } else {
          const auto& bytes =
              array.binary_values()[static_cast<std::size_t>(i)];
          writer->U32(static_cast<std::uint32_t>(bytes.size()));
          if (!bytes.empty()) {
            writer->Raw(bytes.data(), bytes.size());
          }
        }
      }
    }
    return;
  }
  if (array.type().is_floating()) {
    for (std::int64_t i = 0; i < array.length(); ++i) {
      const double value = array.double_values().empty()
                               ? static_cast<double>(array.GetInt64(i))
                               : array.double_values()[static_cast<
                                     std::size_t>(i)];
      writer->F64(value);
    }
    return;
  }
  if (array.type().is_null() || array.type().id == TypeId::Unknown) {
    return;
  }
  for (std::int64_t i = 0; i < array.length(); ++i) {
    writer->I64(array.int_values().empty()
                    ? array.GetInt64(i)
                    : array.int_values()[static_cast<std::size_t>(i)]);
  }
}

inline Array ReadArray(ByteReader* reader) {
  Array array;
  array.mutable_type() = ReadType(reader);
  array.length_ = reader->I64();
  if (array.length_ < 0 ||
      static_cast<std::uint64_t>(array.length_) >
          static_cast<std::uint64_t>(std::numeric_limits<std::int32_t>::max())) {
    reader->Fail(Status::Corrupt("invalid array length"));
    return Array();
  }
  const std::uint8_t has_validity = reader->U8();
  if (has_validity != 0) {
    if (!reader->Need(static_cast<std::size_t>(array.length_))) {
      return Array();
    }
    const std::uint8_t* validity =
        reader->Raw(static_cast<std::size_t>(array.length_));
    array.validity_.assign(validity,
                           validity + static_cast<std::size_t>(array.length_));
  }
  const std::uint8_t is_dictionary = reader->U8();
  if (!reader->ok()) {
    return Array();
  }
  if (is_dictionary != 0) {
    const DataType index_type = ReadType(reader);
    const std::int64_t id = reader->I64();
    const std::uint64_t generation_number = reader->U64();
    const DataType value_type = ReadType(reader);
    Array values = ReadArray(reader);
    const std::uint64_t count = reader->U64();
    if (!reader->ok() || count != static_cast<std::uint64_t>(array.length_)) {
      reader->Fail(Status::Corrupt("dictionary index count mismatch"));
      return Array();
    }
    std::vector<std::int64_t> indices;
    indices.reserve(static_cast<std::size_t>(count));
    for (std::uint64_t i = 0; i < count; ++i) {
      indices.push_back(reader->I64());
    }
    auto dictionary = std::make_shared<DictionaryGeneration>();
    dictionary->id = id;
    dictionary->generation = generation_number;
    dictionary->value_type = value_type;
    dictionary->index_type = index_type;
    dictionary->values = std::make_shared<const Array>(std::move(values));
    dictionary->data = dictionary->values;
    array.indices_ = std::move(indices);
    array.dictionary_ = std::move(dictionary);
    array.index_type_ = index_type;
    array.type_ = value_type;
    return array;
  }
  if (array.type().is_string()) {
    array.strings_.reserve(static_cast<std::size_t>(array.length_));
    for (std::int64_t i = 0; i < array.length_; ++i) {
      array.strings_.push_back(reader->String());
    }
    return array;
  }
  if (array.type().id == TypeId::Binary ||
      array.type().id == TypeId::LargeBinary) {
    array.binaries_.reserve(static_cast<std::size_t>(array.length_));
    for (std::int64_t i = 0; i < array.length_; ++i) {
      const std::uint32_t size = reader->U32();
      const std::uint8_t* bytes = reader->Raw(size);
      if (bytes == nullptr) {
        return Array();
      }
      array.binaries_.emplace_back(bytes, bytes + size);
    }
    return array;
  }
  if (array.type().is_floating()) {
    array.doubles_.reserve(static_cast<std::size_t>(array.length_));
    for (std::int64_t i = 0; i < array.length_; ++i) {
      array.doubles_.push_back(reader->F64());
    }
    return array;
  }
  if (array.type().is_null() || array.type().id == TypeId::Unknown) {
    return array;
  }
  array.ints_.reserve(static_cast<std::size_t>(array.length_));
  for (std::int64_t i = 0; i < array.length_; ++i) {
    array.ints_.push_back(reader->I64());
  }
  return array;
}

inline void WriteDictionaryBatch(ByteWriter* writer,
                                 const DictionaryBatch& batch) {
  writer->I64(batch.id);
  writer->U8(batch.is_delta ? 1 : 0);
  writer->I64(batch.offset);
  WriteArray(writer, batch.effective_values());
}

inline DictionaryBatch ReadDictionaryBatch(ByteReader* reader) {
  DictionaryBatch batch;
  batch.id = reader->I64();
  batch.is_delta = reader->U8() != 0;
  batch.offset = reader->I64();
  batch.values = ReadArray(reader);
  return batch;
}

inline void WriteRecordBatch(ByteWriter* writer, const RecordBatch& batch) {
  WriteSchema(writer, batch.schema);
  writer->I64(batch.num_rows);
  writer->U32(static_cast<std::uint32_t>(batch.columns.size()));
  for (const Array& column : batch.columns) {
    WriteArray(writer, column);
  }
}

inline RecordBatch ReadRecordBatch(ByteReader* reader) {
  RecordBatch batch;
  batch.schema = ReadSchema(reader);
  batch.num_rows = reader->I64();
  const std::uint32_t count = reader->U32();
  batch.columns.reserve(count);
  for (std::uint32_t i = 0; i < count && reader->ok(); ++i) {
    batch.columns.push_back(ReadArray(reader));
  }
  return batch;
}

inline void WritePayload(ByteWriter* writer, const Message& message) {
  switch (message.type) {
    case MessageType::Schema:
      WriteSchema(writer, message.schema);
      break;
    case MessageType::DictionaryBatch:
      WriteDictionaryBatch(writer, message.dictionary_batch);
      break;
    case MessageType::RecordBatch:
      WriteRecordBatch(writer, message.record_batch);
      break;
    case MessageType::EndOfStream:
      break;
  }
}

inline Status ReadPayload(std::uint8_t type, ByteReader* reader,
                          Message* message) {
  if (message == nullptr) {
    return Status::Invalid("null message output");
  }
  message->type = static_cast<MessageType>(type);
  switch (message->type) {
    case MessageType::Schema:
      message->schema = ReadSchema(reader);
      break;
    case MessageType::DictionaryBatch:
      message->dictionary_batch = ReadDictionaryBatch(reader);
      break;
    case MessageType::RecordBatch:
      message->record_batch = ReadRecordBatch(reader);
      break;
    case MessageType::EndOfStream:
      break;
    default:
      return Status::Corrupt("unknown message type");
  }
  if (!reader->ok()) {
    return reader->status();
  }
  return Status::Ok();
}

inline constexpr std::uint8_t kMessageMagic[4] = {'D', 'E', 'N', 'G'};
inline constexpr std::size_t kMessageHeaderSize = 16;
inline constexpr std::uint8_t kMessageVersion = 1;

inline std::uint64_t LoadU64(const std::uint8_t* data) {
  std::uint64_t value = 0;
  for (int shift = 0; shift < 64; shift += 8) {
    value |= static_cast<std::uint64_t>(data[shift / 8]) << shift;
  }
  return value;
}

inline void StoreU64(std::uint8_t* data, std::uint64_t value) {
  for (int shift = 0; shift < 64; shift += 8) {
    data[shift / 8] = static_cast<std::uint8_t>(value >> shift);
  }
}

}  // namespace detail

inline std::vector<std::uint8_t> EncodeMessage(const Message& message,
                                               Status* status = nullptr) {
  detail::ByteWriter payload;
  detail::WritePayload(&payload, message);
  const std::vector<std::uint8_t>& bytes = payload.data();
  std::vector<std::uint8_t> frame;
  frame.resize(detail::kMessageHeaderSize);
  std::memcpy(frame.data(), detail::kMessageMagic, 4);
  frame[4] = detail::kMessageVersion;
  frame[5] = static_cast<std::uint8_t>(message.type);
  frame[6] = 0;
  frame[7] = 0;
  detail::StoreU64(frame.data() + 8, bytes.size());
  frame.insert(frame.end(), bytes.begin(), bytes.end());
  if (status != nullptr) {
    *status = Status::Ok();
  }
  return frame;
}

inline std::vector<std::uint8_t> SerializeMessage(const Message& message,
                                                  Status* status = nullptr) {
  return EncodeMessage(message, status);
}

inline std::vector<std::uint8_t> EncodeMessages(
    const std::vector<Message>& messages, Status* status = nullptr) {
  std::vector<std::uint8_t> stream;
  for (const Message& message : messages) {
    Status item_status;
    std::vector<std::uint8_t> frame = EncodeMessage(message, &item_status);
    if (!item_status.ok()) {
      if (status != nullptr) {
        *status = item_status;
      }
      return {};
    }
    stream.insert(stream.end(), frame.begin(), frame.end());
  }
  if (status != nullptr) {
    *status = Status::Ok();
  }
  return stream;
}

inline std::vector<std::uint8_t> SerializeMessages(
    const std::vector<Message>& messages, Status* status = nullptr) {
  return EncodeMessages(messages, status);
}

inline Status DecodeMessage(const std::uint8_t* data, std::size_t size,
                            Message* message,
                            std::size_t* consumed = nullptr) {
  if (data == nullptr || message == nullptr) {
    return Status::Invalid("null message buffer");
  }
  if (size < detail::kMessageHeaderSize) {
    return Status::Truncated("truncated message header");
  }
  if (std::memcmp(data, detail::kMessageMagic, 4) != 0) {
    return Status::Corrupt("invalid message magic");
  }
  if (data[4] != detail::kMessageVersion) {
    return Status::Unsupported("unsupported message version");
  }
  const std::uint64_t payload_size = detail::LoadU64(data + 8);
  if (payload_size >
      static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max() -
                                 detail::kMessageHeaderSize)) {
    return Status::Corrupt("message payload is too large");
  }
  if (size < detail::kMessageHeaderSize +
                 static_cast<std::size_t>(payload_size)) {
    return Status::Truncated("truncated message payload");
  }
  detail::ByteReader reader(data + detail::kMessageHeaderSize,
                            static_cast<std::size_t>(payload_size));
  Status status = detail::ReadPayload(data[5], &reader, message);
  if (!status.ok()) {
    return status;
  }
  if (reader.remaining() != 0) {
    return Status::Corrupt("unexpected trailing message bytes");
  }
  if (consumed != nullptr) {
    *consumed =
        detail::kMessageHeaderSize + static_cast<std::size_t>(payload_size);
  }
  return Status::Ok();
}

inline Status DecodeMessages(const std::uint8_t* data, std::size_t size,
                             std::vector<Message>* messages) {
  if (messages == nullptr) {
    return Status::Invalid("null message output");
  }
  messages->clear();
  std::size_t offset = 0;
  while (offset < size) {
    Message message;
    std::size_t consumed = 0;
    Status status =
        DecodeMessage(data + offset, size - offset, &message, &consumed);
    if (!status.ok()) {
      return status;
    }
    messages->push_back(std::move(message));
    offset += consumed;
  }
  return Status::Ok();
}

inline Status DecodeMessages(const std::vector<std::uint8_t>& bytes,
                             std::vector<Message>* messages) {
  return DecodeMessages(bytes.data(), bytes.size(), messages);
}

// ---------------------------------------------------------------------------
// Minimal Arrow IPC / FlatBuffers reader
// ---------------------------------------------------------------------------

namespace detail {

inline std::uint16_t LoadU16(const std::uint8_t* data) {
  std::uint16_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::uint32_t LoadU32(const std::uint8_t* data) {
  std::uint32_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::uint64_t ReadUnaligned64(const std::uint8_t* data) {
  std::uint64_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::int8_t LoadI8(const std::uint8_t* data) {
  return static_cast<std::int8_t>(*data);
}

inline std::int16_t LoadI16(const std::uint8_t* data) {
  std::int16_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::int32_t LoadI32(const std::uint8_t* data) {
  std::int32_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::int64_t LoadI64(const std::uint8_t* data) {
  std::int64_t value = 0;
  std::memcpy(&value, data, sizeof(value));
  return value;
}

inline std::size_t Align8(std::size_t value) {
  return (value + 7u) & ~static_cast<std::size_t>(7u);
}

class FBTable {
 public:
  FBTable() = default;
  FBTable(const std::uint8_t* buffer, std::size_t size,
          const std::uint8_t* table)
      : buffer_(buffer), size_(size) {
    if (buffer == nullptr || table == nullptr || table < buffer ||
        table + 4 > buffer + size) {
      return;
    }
    const std::int32_t vtable_offset = LoadI32(table);
    if (vtable_offset <= 0) {
      return;
    }
    const std::uint8_t* vtable = table - vtable_offset;
    if (vtable < buffer || vtable + 4 > buffer + size) {
      return;
    }
    vtable_ = vtable;
    vtable_size_ = LoadU16(vtable);
    object_size_ = LoadU16(vtable + 2);
    if (vtable_size_ < 4 || vtable + vtable_size_ > buffer + size ||
        table + object_size_ > buffer + size) {
      vtable_ = nullptr;
      return;
    }
    table_ = table;
  }

  bool valid() const { return table_ != nullptr; }

  std::uint16_t FieldOffset(int field) const {
    if (table_ == nullptr || field < 0) {
      return 0;
    }
    const std::size_t entry = 4u + static_cast<std::size_t>(field) * 2u;
    if (entry + 2u > vtable_size_) {
      return 0;
    }
    return LoadU16(vtable_ + entry);
  }

  template <typename T>
  T Scalar(int field, T fallback) const {
    const std::uint16_t offset = FieldOffset(field);
    if (offset == 0) {
      return fallback;
    }
    const std::uint8_t* position = table_ + offset;
    if (position + sizeof(T) > table_ + object_size_) {
      return fallback;
    }
    T value{};
    std::memcpy(&value, position, sizeof(T));
    return value;
  }

  const std::uint8_t* OffsetTarget(int field) const {
    const std::uint16_t offset = FieldOffset(field);
    if (offset == 0) {
      return nullptr;
    }
    const std::uint8_t* position = table_ + offset;
    if (position + 4 > table_ + object_size_) {
      return nullptr;
    }
    const std::uint32_t relative = LoadU32(position);
    if (relative == 0) {
      return nullptr;
    }
    const std::uint8_t* target = position + relative;
    if (target < buffer_ || target >= buffer_ + size_) {
      return nullptr;
    }
    return target;
  }

  FBTable Table(int field) const {
    return FBTable(buffer_, size_, OffsetTarget(field));
  }

  std::string String(int field) const {
    const std::uint8_t* target = OffsetTarget(field);
    if (target == nullptr || target + 4 > buffer_ + size_) {
      return {};
    }
    const std::uint32_t length = LoadU32(target);
    if (target + 4 + length > buffer_ + size_) {
      return {};
    }
    return std::string(reinterpret_cast<const char*>(target + 4), length);
  }

  std::vector<FBTable> TableVector(int field) const {
    std::vector<FBTable> result;
    const std::uint8_t* target = OffsetTarget(field);
    if (target == nullptr || target + 4 > buffer_ + size_) {
      return result;
    }
    const std::uint32_t count = LoadU32(target);
    if (target + 4 + static_cast<std::uint64_t>(count) * 4 >
        buffer_ + size_) {
      return result;
    }
    result.reserve(count);
    const std::uint8_t* elements = target + 4;
    for (std::uint32_t i = 0; i < count; ++i) {
      const std::uint8_t* entry = elements + static_cast<std::size_t>(i) * 4;
      const std::uint8_t* table = entry + LoadU32(entry);
      result.emplace_back(buffer_, size_, table);
    }
    return result;
  }

  const std::uint8_t* StructVector(int field, std::size_t stride,
                                   std::uint32_t* count) const {
    if (count != nullptr) {
      *count = 0;
    }
    const std::uint8_t* target = OffsetTarget(field);
    if (target == nullptr || target + 4 > buffer_ + size_) {
      return nullptr;
    }
    const std::uint32_t length = LoadU32(target);
    const std::uint64_t bytes =
        static_cast<std::uint64_t>(length) * stride;
    if (target + 4 + bytes > buffer_ + size_) {
      return nullptr;
    }
    if (count != nullptr) {
      *count = length;
    }
    return target + 4;
  }

 private:
  const std::uint8_t* buffer_ = nullptr;
  std::size_t size_ = 0;
  const std::uint8_t* table_ = nullptr;
  const std::uint8_t* vtable_ = nullptr;
  std::uint16_t vtable_size_ = 0;
  std::uint16_t object_size_ = 0;
};

enum class ArrowTypeId : std::int8_t {
  None = 0,
  Null = 1,
  Int = 2,
  FloatingPoint = 3,
  Binary = 4,
  Utf8 = 5,
  Bool = 6,
  Decimal = 7,
  Date = 8,
  Time = 9,
  Timestamp = 10,
  Interval = 11,
  List = 12,
  Struct = 13,
  Union = 14,
  FixedSizeBinary = 15,
  FixedSizeList = 16,
  Map = 17,
  Duration = 18,
  LargeBinary = 19,
  LargeUtf8 = 20,
  LargeList = 21,
};

inline DataType ParseArrowType(std::int8_t type_id, const FBTable& table) {
  switch (static_cast<ArrowTypeId>(type_id)) {
    case ArrowTypeId::Null:
      return DataType::Null();
    case ArrowTypeId::Int: {
      const std::int32_t width = table.Scalar<std::int32_t>(0, 32);
      const bool is_signed = table.Scalar<std::uint8_t>(1, 0) != 0;
      if (width == 8) {
        return is_signed ? DataType::Int8() : DataType::UInt8();
      }
      if (width == 16) {
        return is_signed ? DataType::Int16() : DataType::UInt16();
      }
      if (width == 32) {
        return is_signed ? DataType::Int32() : DataType::UInt32();
      }
      return is_signed ? DataType::Int64() : DataType::UInt64();
    }
    case ArrowTypeId::FloatingPoint: {
      const std::int16_t precision = table.Scalar<std::int16_t>(0, 0);
      if (precision == 0) {
        return DataType(TypeId::Float16);
      }
      return precision == 1 ? DataType::Float32() : DataType::Float64();
    }
    case ArrowTypeId::Binary:
      return DataType::Binary();
    case ArrowTypeId::LargeBinary:
      return DataType::LargeBinary();
    case ArrowTypeId::Utf8:
      return DataType::Utf8();
    case ArrowTypeId::LargeUtf8:
      return DataType::LargeUtf8();
    case ArrowTypeId::Bool:
      return DataType::Bool();
    case ArrowTypeId::Decimal: {
      DataType type(DataType::Decimal(table.Scalar<std::int32_t>(0, 38),
                                      table.Scalar<std::int32_t>(1, 0)));
      const std::int32_t width = table.Scalar<std::int32_t>(2, 128);
      if (width == 256) {
        type.id = TypeId::Decimal256;
        type.byte_width = 32;
      }
      return type;
    }
    case ArrowTypeId::Date: {
      const std::int16_t unit = table.Scalar<std::int16_t>(0, 0);
      return DataType(unit == 0 ? TypeId::Date32 : TypeId::Date64);
    }
    case ArrowTypeId::Time: {
      const std::int16_t unit = table.Scalar<std::int16_t>(0, 0);
      return DataType(unit <= 1 ? TypeId::Time32 : TypeId::Time64);
    }
    case ArrowTypeId::Timestamp: {
      DataType type(TypeId::Timestamp);
      type.timezone = table.String(1);
      return type;
    }
    case ArrowTypeId::Duration:
      return DataType(TypeId::Duration);
    case ArrowTypeId::Interval:
      return DataType(TypeId::Interval);
    case ArrowTypeId::FixedSizeBinary: {
      DataType type(TypeId::FixedSizeBinary);
      type.byte_width = table.Scalar<std::int32_t>(0, 0);
      return type;
    }
    default:
      return DataType(TypeId::Unknown);
  }
}

inline Field ParseArrowField(const FBTable& field_table) {
  Field field;
  field.name = field_table.String(0);
  field.nullable = field_table.Scalar<std::uint8_t>(1, 0) != 0;
  const std::int8_t type_id = field_table.Scalar<std::int8_t>(2, 0);
  field.type = ParseArrowType(type_id, field_table.Table(3));
  field.dictionary_id = -1;
  const FBTable dictionary = field_table.Table(4);
  if (dictionary.valid()) {
    field.dictionary_id = dictionary.Scalar<std::int64_t>(0, 0);
    const FBTable index_type = dictionary.Table(1);
    if (index_type.valid()) {
      field.index_type =
          ParseArrowType(static_cast<std::int8_t>(ArrowTypeId::Int),
                         index_type);
    } else {
      field.index_type = DataType::Int32();
    }
    field.ordered = dictionary.Scalar<std::uint8_t>(2, 0) != 0;
  }
  return field;
}

inline Schema ParseArrowSchema(const FBTable& schema_table) {
  Schema schema;
  for (const FBTable& field_table : schema_table.TableVector(1)) {
    schema.fields.push_back(ParseArrowField(field_table));
  }
  return schema;
}

struct ArrowFieldNode {
  std::int64_t length = 0;
  std::int64_t null_count = 0;
};

struct ArrowBufferView {
  std::int64_t offset = 0;
  std::int64_t length = 0;
};

inline bool ReadArrowNodes(const FBTable& batch_table,
                           std::vector<ArrowFieldNode>* nodes) {
  nodes->clear();
  if (batch_table.FieldOffset(1) == 0) {
    return true;
  }
  std::uint32_t count = 0;
  const std::uint8_t* data = batch_table.StructVector(1, 16, &count);
  if (data == nullptr) {
    return false;
  }
  nodes->reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    ArrowFieldNode node;
    node.length = LoadI64(data + static_cast<std::size_t>(i) * 16);
    node.null_count = LoadI64(data + static_cast<std::size_t>(i) * 16 + 8);
    nodes->push_back(node);
  }
  return true;
}

inline bool ReadArrowBuffers(const FBTable& batch_table,
                             std::vector<ArrowBufferView>* buffers) {
  buffers->clear();
  if (batch_table.FieldOffset(2) == 0) {
    return true;
  }
  std::uint32_t count = 0;
  const std::uint8_t* data = batch_table.StructVector(2, 16, &count);
  if (data == nullptr) {
    return false;
  }
  buffers->reserve(count);
  for (std::uint32_t i = 0; i < count; ++i) {
    ArrowBufferView buffer;
    buffer.offset = LoadI64(data + static_cast<std::size_t>(i) * 16);
    buffer.length = LoadI64(data + static_cast<std::size_t>(i) * 16 + 8);
    buffers->push_back(buffer);
  }
  return true;
}

inline bool ArrowRegion(const std::uint8_t* body, std::int64_t body_length,
                        const ArrowBufferView& buffer,
                        const std::uint8_t** data) {
  if (buffer.offset < 0 || buffer.length < 0 || body_length < 0 ||
      buffer.offset > body_length ||
      buffer.length > body_length - buffer.offset) {
    return false;
  }
  *data = body == nullptr ? nullptr : body + buffer.offset;
  return true;
}

inline bool ArrowBitsToValidity(const std::uint8_t* data,
                                std::int64_t length,
                                std::vector<std::uint8_t>* validity) {
  validity->clear();
  if (data == nullptr || length <= 0) {
    return true;
  }
  validity->resize(static_cast<std::size_t>(length), 1);
  bool has_null = false;
  for (std::int64_t i = 0; i < length; ++i) {
    const bool valid =
        (data[static_cast<std::size_t>(i) / 8] &
         static_cast<std::uint8_t>(1u << (i % 8))) != 0;
    (*validity)[static_cast<std::size_t>(i)] = valid ? 1 : 0;
    has_null = has_null || !valid;
  }
  if (!has_null) {
    validity->clear();
  }
  return true;
}

}  // namespace detail

class ArrowIpcReader {
 public:
  ArrowIpcReader() : manager_(&owned_) {}
  explicit ArrowIpcReader(DictionaryManager* manager)
      : manager_(manager == nullptr ? &owned_ : manager) {}

  void SetManager(DictionaryManager* manager) {
    manager_ = manager == nullptr ? &owned_ : manager;
  }
  DictionaryManager& dictionary_manager() { return *manager_; }
  const DictionaryManager& dictionary_manager() const { return *manager_; }

  BatchList Push(const Message& message) {
    if (fatal_) {
      return BatchList(status_);
    }
    const std::size_t before = manager_->batches().size();
    Status result = manager_->AddMessage(message);
    if (!result.ok()) {
      status_ = result;
      return BatchList(status_);
    }
    status_ = Status::Ok();
    std::vector<RecordBatch> produced;
    const auto& batches = manager_->batches();
    produced.insert(produced.end(), batches.begin() +
                                        static_cast<std::ptrdiff_t>(before),
                    batches.end());
    return BatchList(Status::Ok(), std::move(produced));
  }

  BatchList Feed(const std::uint8_t* data, std::size_t size) {
    if (fatal_) {
      return BatchList(status_);
    }
    if (data == nullptr && size != 0) {
      status_ = Status::Invalid("null input buffer");
      fatal_ = true;
      return BatchList(status_);
    }
    if (size != 0) {
      buffer_.insert(buffer_.end(), data, data + size);
    }
    std::vector<RecordBatch> produced;
    for (;;) {
      Message message;
      std::size_t consumed = 0;
      ParseState state = ParseOne(&message, &consumed);
      if (state == ParseState::NeedMore) {
        break;
      }
      if (state == ParseState::Error) {
        buffer_.clear();
        return BatchList(status_, std::move(produced));
      }
      if (state == ParseState::End) {
        buffer_.erase(buffer_.begin(),
                      buffer_.begin() + static_cast<std::ptrdiff_t>(consumed));
        saw_eos_ = true;
        break;
      }
      BatchList pushed = Push(message);
      if (!pushed.ok()) {
        buffer_.clear();
        return BatchList(pushed.status, std::move(produced));
      }
      produced.insert(produced.end(), pushed.begin(), pushed.end());
      buffer_.erase(buffer_.begin(),
                    buffer_.begin() + static_cast<std::ptrdiff_t>(consumed));
    }
    return BatchList(Status::Ok(), std::move(produced));
  }

  BatchList Feed(std::span<const std::uint8_t> bytes) {
    return Feed(bytes.data(), bytes.size());
  }
  BatchList Feed(const std::vector<std::uint8_t>& bytes) {
    return Feed(bytes.data(), bytes.size());
  }
  BatchList Feed(const std::vector<char>& bytes) {
    return Feed(reinterpret_cast<const std::uint8_t*>(bytes.data()),
                bytes.size());
  }
  BatchList Feed(const void* data, std::size_t size) {
    return Feed(static_cast<const std::uint8_t*>(data), size);
  }
  BatchList Feed(std::initializer_list<std::uint8_t> bytes) {
    return Feed(std::vector<std::uint8_t>(bytes));
  }
  BatchList Feed(std::string_view bytes) {
    return Feed(reinterpret_cast<const std::uint8_t*>(bytes.data()),
                bytes.size());
  }

  BatchList Finish() {
    if (fatal_) {
      return BatchList(status_);
    }
    if (!buffer_.empty()) {
      status_ = Status::Truncated("Arrow stream ended in a partial message");
      fatal_ = true;
      return BatchList(status_);
    }
    return BatchList(Status::Ok(), manager_->batches());
  }

  BatchList ReadAll(const std::uint8_t* data, std::size_t size) {
    BatchList fed = Feed(data, size);
    if (!fed.ok()) {
      return fed;
    }
    return Finish();
  }
  BatchList ReadAll(std::span<const std::uint8_t> bytes) {
    return ReadAll(bytes.data(), bytes.size());
  }
  BatchList ReadAll(const std::vector<std::uint8_t>& bytes) {
    return ReadAll(bytes.data(), bytes.size());
  }

  const std::vector<RecordBatch>& batches() const { return manager_->batches(); }
  std::size_t size() const { return manager_->size(); }
  bool empty() const { return manager_->empty(); }
  const Status& status() const { return status_; }
  std::size_t buffered_bytes() const { return buffer_.size(); }
  bool finished() const { return saw_eos_; }
  void SetMaxMessageSize(std::size_t size) { max_message_size_ = size; }

  void Reset(bool keep_schema = false) {
    manager_->Reset(keep_schema);
    buffer_.clear();
    status_ = Status::Ok();
    fatal_ = false;
    saw_eos_ = false;
    if (!keep_schema) {
      schema_ = Schema();
      has_schema_ = false;
      dictionary_types_.clear();
    }
  }

 private:
  enum class ParseState { NeedMore, Ready, End, Error };

  ParseState ParseOne(Message* message, std::size_t* consumed) {
    if (buffer_.size() < 4) {
      return ParseState::NeedMore;
    }
    std::size_t prefix = 4;
    std::uint32_t metadata_length = detail::LoadU32(buffer_.data());
    if (metadata_length == 0xFFFFFFFFu) {
      if (buffer_.size() < 8) {
        return ParseState::NeedMore;
      }
      prefix = 8;
      metadata_length = detail::LoadU32(buffer_.data() + 4);
    }
    if (metadata_length == 0) {
      *consumed = prefix;
      return ParseState::End;
    }
    if (metadata_length > max_message_size_) {
      status_ = Status::Invalid("Arrow metadata exceeds size limit");
      fatal_ = true;
      return ParseState::Error;
    }
    const std::size_t metadata_total = detail::Align8(metadata_length);
    if (buffer_.size() < prefix + metadata_total) {
      return ParseState::NeedMore;
    }
    const std::uint8_t* metadata = buffer_.data() + prefix;
    if (metadata_length < 4) {
      status_ = Status::Corrupt("Arrow metadata is too short");
      fatal_ = true;
      return ParseState::Error;
    }
    const std::uint32_t root_offset = detail::LoadU32(metadata);
    if (root_offset >= metadata_length) {
      status_ = Status::Corrupt("Arrow FlatBuffer root is out of range");
      fatal_ = true;
      return ParseState::Error;
    }
    detail::FBTable message_table(metadata, metadata_length,
                                  metadata + root_offset);
    if (!message_table.valid()) {
      status_ = Status::Corrupt("invalid Arrow Message table");
      fatal_ = true;
      return ParseState::Error;
    }
    const std::int64_t body_length =
        message_table.Scalar<std::int64_t>(3, 0);
    if (body_length < 0 ||
        static_cast<std::uint64_t>(body_length) > max_message_size_) {
      status_ = Status::Invalid("invalid Arrow message body length");
      fatal_ = true;
      return ParseState::Error;
    }
    const std::size_t body_total =
        detail::Align8(static_cast<std::size_t>(body_length));
    const std::size_t frame_size = prefix + metadata_total + body_total;
    if (buffer_.size() < frame_size) {
      return ParseState::NeedMore;
    }
    const std::uint8_t* body =
        buffer_.data() + prefix + metadata_total;
    Status status =
        ParseArrowMessage(message_table, body, body_length, message);
    if (!status.ok()) {
      status_ = status;
      fatal_ = true;
      return ParseState::Error;
    }
    *consumed = frame_size;
    return ParseState::Ready;
  }

  Status ParseArrowMessage(const detail::FBTable& message_table,
                           const std::uint8_t* body,
                           std::int64_t body_length, Message* message) {
    const std::int8_t header_type =
        message_table.Scalar<std::int8_t>(1, 0);
    const detail::FBTable header = message_table.Table(2);
    if (!header.valid()) {
      return Status::Corrupt("Arrow message has no header");
    }
    switch (header_type) {
      case 1: {
        Message schema_message;
        schema_message.type = MessageType::Schema;
        schema_message.schema = detail::ParseArrowSchema(header);
        for (const Field& field : schema_message.schema.fields) {
          if (field.type.id == TypeId::Unknown) {
            return Status::Unsupported("unsupported Arrow field type");
          }
          if (field.has_dictionary()) {
            const std::int64_t id = field.effective_dictionary_id();
            auto it = dictionary_types_.find(id);
            if (it != dictionary_types_.end() &&
                it->second != field.value_type()) {
              return Status::TypeMismatch(
                  "Arrow schema reuses dictionary id " +
                  std::to_string(id) + " with different types");
            }
            dictionary_types_[id] = field.value_type();
          }
        }
        schema_ = schema_message.schema;
        has_schema_ = true;
        *message = std::move(schema_message);
        return Status::Ok();
      }
      case 2:
        return ParseArrowDictionaryBatch(header, body, body_length, message);
      case 3:
        return ParseArrowRecordBatch(header, body, body_length, message);
      default:
        return Status::Unsupported("unsupported Arrow message header");
    }
  }

  Status ResolveDictionaryType(std::int64_t id, DataType* type) const {
    auto it = dictionary_types_.find(id);
    if (it != dictionary_types_.end() && !it->second.is_null()) {
      *type = it->second;
      return Status::Ok();
    }
    const DictionaryGeneration* current = manager_->Current(id);
    if (current != nullptr && !current->value_type.is_null()) {
      *type = current->value_type;
      return Status::Ok();
    }
    const auto& fields = manager_->dictionary_fields();
    auto field_it = fields.find(id);
    if (field_it != fields.end() && !field_it->second.value_type().is_null()) {
      *type = field_it->second.value_type();
      return Status::Ok();
    }
    return Status::Unsupported("no value type known for dictionary id " +
                               std::to_string(id));
  }

  Status DecodeArrowArray(
      const DataType& storage_type, std::int64_t length,
      const detail::ArrowFieldNode& node,
      const std::vector<detail::ArrowBufferView>& buffers,
      std::size_t* buffer_index, const std::uint8_t* body,
      std::int64_t body_length, Array* result) {
    if (result == nullptr) {
      return Status::Invalid("null Arrow array output");
    }
    if (node.length < 0 || node.length != length) {
      return Status::Corrupt("Arrow field node length mismatch");
    }
    if (storage_type.is_null()) {
      Array array(storage_type, length);
      if (length > 0) {
        array.validity_.assign(static_cast<std::size_t>(length), 0);
      }
      *result = std::move(array);
      return Status::Ok();
    }
    if (*buffer_index >= buffers.size()) {
      return Status::Corrupt("Arrow array is missing its validity buffer");
    }
    const detail::ArrowBufferView validity_buffer = buffers[(*buffer_index)++];
    const std::uint8_t* validity_data = nullptr;
    if (!detail::ArrowRegion(body, body_length, validity_buffer,
                             &validity_data)) {
      return Status::Corrupt("Arrow validity buffer is out of range");
    }
    std::vector<std::uint8_t> validity;
    if (validity_buffer.length > 0) {
      if (validity_buffer.length < (length + 7) / 8) {
        return Status::Corrupt("Arrow validity buffer is too short");
      }
      detail::ArrowBitsToValidity(validity_data, length, &validity);
    }

    Array array(storage_type, length);
    array.validity_ = std::move(validity);

    const auto take_buffer = [&](detail::ArrowBufferView* buffer,
                                 const std::uint8_t** data) -> Status {
      if (*buffer_index >= buffers.size()) {
        return Status::Corrupt("Arrow array is missing a buffer");
      }
      *buffer = buffers[(*buffer_index)++];
      if (!detail::ArrowRegion(body, body_length, *buffer, data)) {
        return Status::Corrupt("Arrow buffer is out of range");
      }
      return Status::Ok();
    };

    if (storage_type.is_integer() || storage_type.is_bool() ||
        storage_type.id == TypeId::Date32 ||
        storage_type.id == TypeId::Date64 ||
        storage_type.id == TypeId::Time32 ||
        storage_type.id == TypeId::Time64 ||
        storage_type.id == TypeId::Timestamp ||
        storage_type.id == TypeId::Duration ||
        storage_type.id == TypeId::Interval ||
        storage_type.id == TypeId::Decimal128 ||
        storage_type.id == TypeId::Decimal256) {
      detail::ArrowBufferView values_buffer;
      const std::uint8_t* values = nullptr;
      Status status = take_buffer(&values_buffer, &values);
      if (!status.ok()) {
        return status;
      }
      if (storage_type.is_bool()) {
        const std::int64_t needed = (length + 7) / 8;
        if (values_buffer.length < needed) {
          return Status::Corrupt("Arrow bool buffer is too short");
        }
        array.ints_.resize(static_cast<std::size_t>(length));
        for (std::int64_t i = 0; i < length; ++i) {
          array.ints_[static_cast<std::size_t>(i)] =
              (values[static_cast<std::size_t>(i) / 8] &
               static_cast<std::uint8_t>(1u << (i % 8))) != 0
                  ? 1
                  : 0;
        }
      } else {
        const std::int64_t width =
            storage_type.id == TypeId::Decimal128 ? 16
            : storage_type.id == TypeId::Decimal256 ? 32
            : storage_type.id == TypeId::Interval       ? 16
                                                        : storage_type.byte_width;
        const bool signed_storage =
            storage_type.is_signed_integer() ||
            storage_type.id == TypeId::Date32 ||
            storage_type.id == TypeId::Date64 ||
            storage_type.id == TypeId::Time32 ||
            storage_type.id == TypeId::Time64 ||
            storage_type.id == TypeId::Timestamp ||
            storage_type.id == TypeId::Duration ||
            storage_type.id == TypeId::Interval ||
            storage_type.id == TypeId::Decimal128 ||
            storage_type.id == TypeId::Decimal256;
        if (width <= 0) {
          return Status::Unsupported("unsupported Arrow integer width");
        }
        if (values_buffer.length < length * width) {
          return Status::Corrupt("Arrow values buffer is too short");
        }
        array.ints_.resize(static_cast<std::size_t>(length));
        for (std::int64_t i = 0; i < length; ++i) {
          const std::uint8_t* element =
              values + static_cast<std::size_t>(i) * static_cast<std::size_t>(width);
          std::int64_t value = 0;
          switch (width) {
            case 1:
              value = signed_storage
                          ? static_cast<std::int64_t>(
                                static_cast<std::int8_t>(*element))
                          : static_cast<std::int64_t>(*element);
              break;
            case 2:
              value = signed_storage
                          ? static_cast<std::int64_t>(
                                detail::LoadI16(element))
                          : static_cast<std::int64_t>(
                                detail::LoadU16(element));
              break;
            case 4:
              value = signed_storage
                          ? static_cast<std::int64_t>(
                                detail::LoadI32(element))
                          : static_cast<std::int64_t>(
                                detail::LoadU32(element));
              break;
            default:
              value = static_cast<std::int64_t>(
                  detail::ReadUnaligned64(element));
              break;
          }
          array.ints_[static_cast<std::size_t>(i)] = value;
        }
      }
      *result = std::move(array);
      return Status::Ok();
    }

    if (storage_type.is_floating()) {
      detail::ArrowBufferView values_buffer;
      const std::uint8_t* values = nullptr;
      Status status = take_buffer(&values_buffer, &values);
      if (!status.ok()) {
        return status;
      }
      const std::int64_t width = storage_type.byte_width;
      if (width != 4 && width != 8) {
        return Status::Unsupported("unsupported Arrow floating width");
      }
      if (values_buffer.length < length * width) {
        return Status::Corrupt("Arrow floating buffer is too short");
      }
      array.doubles_.resize(static_cast<std::size_t>(length));
      for (std::int64_t i = 0; i < length; ++i) {
        if (width == 4) {
          const std::uint32_t bits =
              detail::LoadU32(values + static_cast<std::size_t>(i) * 4);
          float value = 0.0f;
          std::memcpy(&value, &bits, sizeof(value));
          array.doubles_[static_cast<std::size_t>(i)] = value;
        } else {
          const std::uint8_t* element =
              values + static_cast<std::size_t>(i) * 8;
          const std::uint64_t bits = detail::ReadUnaligned64(element);
          double value = 0.0;
          std::memcpy(&value, &bits, sizeof(value));
          array.doubles_[static_cast<std::size_t>(i)] = value;
        }
      }
      *result = std::move(array);
      return Status::Ok();
    }

    if (storage_type.is_binary_like()) {
      detail::ArrowBufferView offsets_buffer;
      const std::uint8_t* offsets = nullptr;
      Status status = take_buffer(&offsets_buffer, &offsets);
      if (!status.ok()) {
        return status;
      }
      detail::ArrowBufferView data_buffer;
      const std::uint8_t* data = nullptr;
      status = take_buffer(&data_buffer, &data);
      if (!status.ok()) {
        return status;
      }
      const bool large = storage_type.id == TypeId::LargeUtf8 ||
                         storage_type.id == TypeId::LargeBinary;
      const std::int64_t width = large ? 8 : 4;
      if (length > 0) {
        if (offsets_buffer.length < (length + 1) * width) {
          return Status::Corrupt("Arrow offset buffer is too short");
        }
        const std::int64_t first_offset =
            large ? detail::LoadI64(offsets)
                  : static_cast<std::int64_t>(detail::LoadI32(offsets));
        if (first_offset < 0 || first_offset > data_buffer.length) {
          return Status::Corrupt("Arrow first offset is out of range");
        }
        if (storage_type.is_string()) {
          array.strings_.resize(static_cast<std::size_t>(length));
        } else {
          array.binaries_.resize(static_cast<std::size_t>(length));
        }
        for (std::int64_t i = 0; i < length; ++i) {
          const std::uint8_t* start_ptr =
              offsets + static_cast<std::size_t>(i) * static_cast<std::size_t>(width);
          const std::uint8_t* end_ptr =
              offsets + static_cast<std::size_t>(i + 1) * static_cast<std::size_t>(width);
          const std::int64_t start =
              large ? detail::LoadI64(start_ptr)
                    : static_cast<std::int64_t>(detail::LoadI32(start_ptr));
          const std::int64_t end =
              large ? detail::LoadI64(end_ptr)
                    : static_cast<std::int64_t>(detail::LoadI32(end_ptr));
          if (start < 0 || end < start || end > data_buffer.length) {
            return Status::Corrupt("Arrow string offset is out of range");
          }
          if (storage_type.is_string()) {
            array.strings_[static_cast<std::size_t>(i)] =
                std::string(reinterpret_cast<const char*>(data + start),
                            static_cast<std::size_t>(end - start));
          } else {
            array.binaries_[static_cast<std::size_t>(i)] =
                std::vector<std::uint8_t>(data + start, data + end);
          }
        }
      }
      *result = std::move(array);
      return Status::Ok();
    }

    if (storage_type.id == TypeId::FixedSizeBinary) {
      detail::ArrowBufferView data_buffer;
      const std::uint8_t* data = nullptr;
      Status status = take_buffer(&data_buffer, &data);
      if (!status.ok()) {
        return status;
      }
      const std::int64_t width = storage_type.byte_width;
      if (width < 0 || data_buffer.length < length * width) {
        return Status::Corrupt("Arrow fixed-size binary buffer is too short");
      }
      array.binaries_.resize(static_cast<std::size_t>(length));
      for (std::int64_t i = 0; i < length; ++i) {
        const std::uint8_t* start =
            data + static_cast<std::size_t>(i) * static_cast<std::size_t>(width);
        array.binaries_[static_cast<std::size_t>(i)] =
            std::vector<std::uint8_t>(start, start + width);
      }
      *result = std::move(array);
      return Status::Ok();
    }

    return Status::Unsupported("unsupported Arrow array type " +
                               storage_type.name());
  }

  Status ParseArrowRecordBatch(const detail::FBTable& header,
                               const std::uint8_t* body,
                               std::int64_t body_length, Message* message) {
    if (header.OffsetTarget(3) != nullptr) {
      return Status::Unsupported(
          "compressed Arrow record batches are not supported");
    }
    Schema schema = has_schema_ ? schema_ : manager_->schema();
    if (schema.fields.empty() && !has_schema_) {
      return Status::InvalidState("Arrow record batch before schema");
    }
    const std::int64_t length = header.Scalar<std::int64_t>(0, 0);
    if (length < 0) {
      return Status::Corrupt("negative Arrow record batch length");
    }
    std::vector<detail::ArrowFieldNode> nodes;
    std::vector<detail::ArrowBufferView> buffers;
    if (!detail::ReadArrowNodes(header, &nodes) ||
        !detail::ReadArrowBuffers(header, &buffers)) {
      return Status::Corrupt("invalid Arrow record batch vectors");
    }
    if (nodes.size() < schema.fields.size()) {
      return Status::Corrupt("Arrow record batch has too few field nodes");
    }
    std::vector<Array> columns;
    columns.reserve(schema.fields.size());
    std::size_t buffer_index = 0;
    for (std::size_t i = 0; i < schema.fields.size(); ++i) {
      const Field& field = schema.fields[i];
      DataType storage_type =
          field.has_dictionary() ? field.dictionary_index_type()
                                 : field.value_type();
      Array column;
      Status status =
          DecodeArrowArray(storage_type, length, nodes[i], buffers,
                           &buffer_index, body, body_length, &column);
      if (!status.ok()) {
        return status;
      }
      columns.push_back(std::move(column));
    }
    if (buffer_index != buffers.size()) {
      return Status::Corrupt("unexpected extra Arrow buffers");
    }
    RecordBatch batch(schema, std::move(columns));
    batch.num_rows = length;
    message->type = MessageType::RecordBatch;
    message->record_batch = std::move(batch);
    return Status::Ok();
  }

  Status ParseArrowDictionaryBatch(const detail::FBTable& header,
                                   const std::uint8_t* body,
                                   std::int64_t body_length,
                                   Message* message) {
    const std::int64_t id = header.Scalar<std::int64_t>(0, 0);
    const bool is_delta = header.Scalar<std::uint8_t>(2, 0) != 0;
    const detail::FBTable data = header.Table(1);
    if (id < 0 || !data.valid()) {
      return Status::Corrupt("invalid Arrow dictionary batch");
    }
    if (data.OffsetTarget(3) != nullptr) {
      return Status::Unsupported(
          "compressed Arrow dictionary batches are not supported");
    }
    DataType value_type;
    Status status = ResolveDictionaryType(id, &value_type);
    if (!status.ok()) {
      return status;
    }
    const std::int64_t length = data.Scalar<std::int64_t>(0, 0);
    if (length < 0) {
      return Status::Corrupt("negative Arrow dictionary length");
    }
    std::vector<detail::ArrowFieldNode> nodes;
    std::vector<detail::ArrowBufferView> buffers;
    if (!detail::ReadArrowNodes(data, &nodes) ||
        !detail::ReadArrowBuffers(data, &buffers) || nodes.empty()) {
      return Status::Corrupt("invalid Arrow dictionary record batch");
    }
    Array values;
    std::size_t buffer_index = 0;
    status = DecodeArrowArray(value_type, length, nodes.front(), buffers,
                              &buffer_index, body, body_length, &values);
    if (!status.ok()) {
      return status;
    }
    if (buffer_index != buffers.size()) {
      return Status::Corrupt("unexpected extra Arrow dictionary buffers");
    }
    DictionaryBatch batch(id, std::move(values), is_delta);
    message->type = MessageType::DictionaryBatch;
    message->dictionary_batch = std::move(batch);
    return Status::Ok();
  }

  DictionaryManager owned_;
  DictionaryManager* manager_ = nullptr;
  std::vector<std::uint8_t> buffer_;
  std::size_t max_message_size_ = static_cast<std::size_t>(1) << 30;
  Status status_;
  bool fatal_ = false;
  bool saw_eos_ = false;
  Schema schema_;
  bool has_schema_ = false;
  std::map<std::int64_t, DataType> dictionary_types_;
};

// ---------------------------------------------------------------------------
// Columnar stream receiver
// ---------------------------------------------------------------------------

class StreamReceiver {
 public:
  StreamReceiver() : manager_(&owned_), arrow_reader_(&owned_) {}
  explicit StreamReceiver(DictionaryManager* manager)
      : manager_(manager == nullptr ? &owned_ : manager),
        arrow_reader_(manager_) {}

  void SetManager(DictionaryManager* manager) {
    manager_ = manager == nullptr ? &owned_ : manager;
    arrow_reader_.SetManager(manager_);
  }
  DictionaryManager& dictionary_manager() { return *manager_; }
  const DictionaryManager& dictionary_manager() const { return *manager_; }
  DictionaryManager& manager() { return *manager_; }
  const DictionaryManager& manager() const { return *manager_; }
  DictionaryManager* manager_ptr() { return manager_; }

  BatchList Push(const Message& message) {
    if (fatal_) {
      return BatchList(status_);
    }
    if (saw_eos_ && message.type != MessageType::EndOfStream) {
      status_ = Status::InvalidState("message received after end of stream");
      return BatchList(status_);
    }
    const std::size_t before = manager_->batches().size();
    Status result = manager_->AddMessage(message);
    if (!result.ok()) {
      status_ = result;
      return BatchList(status_);
    }
    status_ = Status::Ok();
    if (message.type == MessageType::EndOfStream) {
      saw_eos_ = true;
    }
    std::vector<RecordBatch> produced;
    const auto& batches = manager_->batches();
    produced.insert(produced.end(), batches.begin() +
                                        static_cast<std::ptrdiff_t>(before),
                    batches.end());
    return BatchList(Status::Ok(), std::move(produced));
  }
  BatchList AddMessage(const Message& message) { return Push(message); }
  BatchList Receive(const Message& message) { return Push(message); }
  BatchList OnMessage(const Message& message) { return Push(message); }
  BatchList push_message(const Message& message) { return Push(message); }

  BatchList Feed(const std::uint8_t* data, std::size_t size) {
    if (data == nullptr && size != 0) {
      status_ = Status::Invalid("null input buffer");
      fatal_ = true;
      return BatchList(status_);
    }
    if (size == 0) {
      return BatchList(Status::Ok());
    }
    if (wire_format_ == WireFormat::Arrow) {
      BatchList result = arrow_reader_.Feed(data, size);
      status_ = result.status;
      return result;
    }
    if (fatal_) {
      return BatchList(status_);
    }
    buffer_.insert(buffer_.end(), data, data + size);

    if (wire_format_ == WireFormat::Unknown) {
      if (buffer_.size() < 4) {
        const std::uint8_t first = buffer_.front();
        if (first != detail::kMessageMagic[0] && first != 0xFFu) {
          status_ = Status::Corrupt("unrecognized stream wire format");
          fatal_ = true;
          buffer_.clear();
          return BatchList(status_);
        }
        return BatchList(Status::Ok());
      }
      if (std::memcmp(buffer_.data(), detail::kMessageMagic, 4) == 0) {
        wire_format_ = WireFormat::Custom;
      } else {
        wire_format_ = WireFormat::Arrow;
      }
      if (wire_format_ == WireFormat::Arrow) {
        BatchList result = arrow_reader_.Feed(buffer_.data(), buffer_.size());
        status_ = result.status;
        buffer_.clear();
        return result;
      }
    }

    std::vector<RecordBatch> produced;

    while (buffer_.size() >= detail::kMessageHeaderSize) {
      if (std::memcmp(buffer_.data(), detail::kMessageMagic, 4) != 0) {
        status_ = Status::Corrupt("invalid message magic");
        fatal_ = true;
        buffer_.clear();
        return BatchList(status_, std::move(produced));
      }
      const std::uint64_t payload_size =
          detail::LoadU64(buffer_.data() + 8);
      if (payload_size > max_message_size_) {
        status_ = Status::Invalid("message exceeds configured size limit");
        fatal_ = true;
        buffer_.clear();
        return BatchList(status_, std::move(produced));
      }
      const std::size_t frame_size =
          detail::kMessageHeaderSize + static_cast<std::size_t>(payload_size);
      if (buffer_.size() < frame_size) {
        break;
      }
      Message message;
      std::size_t consumed = 0;
      Status result =
          DecodeMessage(buffer_.data(), frame_size, &message, &consumed);
      if (!result.ok()) {
        status_ = result;
        fatal_ = true;
        buffer_.clear();
        return BatchList(status_, std::move(produced));
      }
      BatchList pushed = Push(message);
      if (!pushed.ok()) {
        buffer_.clear();
        return BatchList(pushed.status, std::move(produced));
      }
      produced.insert(produced.end(), pushed.begin(), pushed.end());
      buffer_.erase(buffer_.begin(),
                    buffer_.begin() + static_cast<std::ptrdiff_t>(consumed));
    }

    if (buffer_.size() < detail::kMessageHeaderSize) {
      const std::size_t prefix =
          std::min<std::size_t>(buffer_.size(), sizeof(detail::kMessageMagic));
      if (prefix != 0 &&
          std::memcmp(buffer_.data(), detail::kMessageMagic, prefix) != 0) {
        status_ = Status::Corrupt("invalid message magic");
        fatal_ = true;
        buffer_.clear();
        return BatchList(status_, std::move(produced));
      }
    }
    return BatchList(Status::Ok(), std::move(produced));
  }

  BatchList Feed(std::span<const std::uint8_t> bytes) {
    return Feed(bytes.data(), bytes.size());
  }
  BatchList Feed(const std::vector<std::uint8_t>& bytes) {
    return Feed(bytes.data(), bytes.size());
  }
  BatchList Feed(const std::vector<char>& bytes) {
    return Feed(reinterpret_cast<const std::uint8_t*>(bytes.data()),
                bytes.size());
  }
  BatchList Feed(const void* data, std::size_t size) {
    return Feed(static_cast<const std::uint8_t*>(data), size);
  }
  BatchList Feed(std::initializer_list<std::uint8_t> bytes) {
    return Feed(std::vector<std::uint8_t>(bytes));
  }
  BatchList Feed(std::string_view bytes) {
    return Feed(reinterpret_cast<const std::uint8_t*>(bytes.data()),
                bytes.size());
  }
  BatchList Feed(const char* bytes, std::size_t size) {
    return Feed(reinterpret_cast<const std::uint8_t*>(bytes), size);
  }
  BatchList Feed(const std::vector<Message>& messages) {
    std::vector<RecordBatch> produced;
    for (const Message& message : messages) {
      BatchList result = Push(message);
      if (!result.ok()) {
        return BatchList(result.status, std::move(produced));
      }
      produced.insert(produced.end(), result.begin(), result.end());
    }
    return BatchList(Status::Ok(), std::move(produced));
  }
  BatchList Feed(std::initializer_list<Message> messages) {
    return Feed(std::vector<Message>(messages));
  }
  BatchList feed(const std::uint8_t* data, std::size_t size) {
    return Feed(data, size);
  }
  BatchList feed(std::span<const std::uint8_t> bytes) { return Feed(bytes); }
  BatchList feed(const std::vector<std::uint8_t>& bytes) {
    return Feed(bytes);
  }
  BatchList FeedChunk(const std::uint8_t* data, std::size_t size) {
    return Feed(data, size);
  }
  BatchList FeedChunk(std::span<const std::uint8_t> bytes) {
    return Feed(bytes);
  }
  BatchList ReceiveChunk(const std::uint8_t* data, std::size_t size) {
    return Feed(data, size);
  }
  BatchList PushBytes(const std::uint8_t* data, std::size_t size) {
    return Feed(data, size);
  }
  BatchList AddBytes(const std::uint8_t* data, std::size_t size) {
    return Feed(data, size);
  }

  BatchList Finish() {
    if (wire_format_ == WireFormat::Arrow) {
      BatchList result = arrow_reader_.Finish();
      status_ = result.status;
      return result;
    }
    if (fatal_) {
      return BatchList(status_);
    }
    if (!buffer_.empty()) {
      status_ = Status::Truncated("stream ended in the middle of a message");
      fatal_ = true;
      return BatchList(status_);
    }
    return BatchList(Status::Ok(), manager_->batches());
  }
  BatchList finish() { return Finish(); }
  BatchList take_batches() { return TakeBatches(); }

  BatchList ReadAll(const std::uint8_t* data, std::size_t size) {
    BatchList fed = Feed(data, size);
    if (!fed.ok()) {
      return fed;
    }
    return Finish();
  }
  BatchList ReadAll(std::span<const std::uint8_t> bytes) {
    return ReadAll(bytes.data(), bytes.size());
  }
  BatchList ReadAll(const std::vector<std::uint8_t>& bytes) {
    return ReadAll(bytes.data(), bytes.size());
  }

  BatchList TakeBatches() {
    if (wire_format_ == WireFormat::Arrow) {
      return BatchList(Status::Ok(), manager_->TakeBatches());
    }
    if (fatal_) {
      return BatchList(status_);
    }
    return BatchList(Status::Ok(), manager_->TakeBatches());
  }
  BatchList Take() { return TakeBatches(); }

  const std::vector<RecordBatch>& batches() const { return manager_->batches(); }
  const std::vector<RecordBatch>& records() const { return manager_->batches(); }
  std::size_t size() const { return manager_->size(); }
  bool empty() const { return manager_->empty(); }
  const Status& status() const {
    return wire_format_ == WireFormat::Arrow ? arrow_reader_.status()
                                             : status_;
  }
  bool finished() const {
    return wire_format_ == WireFormat::Arrow ? arrow_reader_.finished()
                                             : saw_eos_;
  }
  std::size_t buffered_bytes() const {
    return wire_format_ == WireFormat::Arrow ? arrow_reader_.buffered_bytes()
                                             : buffer_.size();
  }

  void SetMaxMessageSize(std::size_t size) {
    max_message_size_ = size;
    arrow_reader_.SetMaxMessageSize(size);
  }
  std::size_t max_message_size() const { return max_message_size_; }

  void Reset(bool keep_schema = false) {
    manager_->Reset(keep_schema);
    arrow_reader_.Reset(keep_schema);
    buffer_.clear();
    status_ = Status::Ok();
    fatal_ = false;
    saw_eos_ = false;
    wire_format_ = WireFormat::Unknown;
  }

 private:
  enum class WireFormat { Unknown, Custom, Arrow };

  DictionaryManager owned_;
  DictionaryManager* manager_ = nullptr;
  ArrowIpcReader arrow_reader_;
  std::vector<std::uint8_t> buffer_;
  std::size_t max_message_size_ =
      static_cast<std::size_t>(1) << 30;
  Status status_;
  WireFormat wire_format_ = WireFormat::Unknown;
  bool fatal_ = false;
  bool saw_eos_ = false;
};

using ColumnarStreamReceiver = StreamReceiver;
using IpcStreamReceiver = StreamReceiver;
using DictionaryStreamReceiver = StreamReceiver;
using StreamReader = StreamReceiver;
using StreamDecoder = StreamReceiver;
using Receiver = StreamReceiver;
using ColumnarReceiver = StreamReceiver;
using ArrowStreamReceiver = StreamReceiver;

inline BatchList ReadArrowIpcStream(const std::uint8_t* data,
                                    std::size_t size,
                                    DictionaryManager* manager = nullptr) {
  ArrowIpcReader reader(manager);
  return reader.ReadAll(data, size);
}
inline BatchList ReadArrowIpcStream(
    std::span<const std::uint8_t> bytes,
    DictionaryManager* manager = nullptr) {
  return ReadArrowIpcStream(bytes.data(), bytes.size(), manager);
}
inline BatchList ReadArrowIpcStream(
    const std::vector<std::uint8_t>& bytes,
    DictionaryManager* manager = nullptr) {
  return ReadArrowIpcStream(bytes.data(), bytes.size(), manager);
}
inline BatchList DecodeArrowIpcStream(const std::uint8_t* data,
                                      std::size_t size,
                                      DictionaryManager* manager = nullptr) {
  return ReadArrowIpcStream(data, size, manager);
}

namespace ipc {
using DictionaryManager = dataeng::DictionaryManager;
using DictionaryMemo = dataeng::DictionaryManager;
using DictionaryBatch = dataeng::DictionaryBatch;
using RecordBatch = dataeng::RecordBatch;
using Field = dataeng::Field;
using Schema = dataeng::Schema;
using Array = dataeng::Array;
using ColumnarStreamReceiver = dataeng::StreamReceiver;
using StreamReceiver = dataeng::StreamReceiver;
using ArrowIpcReader = dataeng::ArrowIpcReader;
}  // namespace ipc

namespace stream {
using Receiver = dataeng::StreamReceiver;
using ColumnarStreamReceiver = dataeng::StreamReceiver;
}  // namespace stream

}  // namespace dataeng
