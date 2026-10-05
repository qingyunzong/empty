// graphser - deterministic object-graph serialization for C++20.
//
// Properties:
//  * Preserves object sharing (aliasing) and reference cycles.
//  * Object IDs are assigned by a pre-order DFS from the root, visiting
//    fields in the order write_fields() emits them. IDs never depend on
//    pointer addresses, so logically identical graphs serialize to
//    identical bytes.
//  * Deserialization is exception-safe: any failure (unknown type tag,
//    corrupt data, throwing factory, throwing read_fields) releases every
//    object created so far, including ones already linked into cycles.
//  * Unknown type tags are rejected with unknown_type_error.
//
// Wire format (all integers little-endian):
//   magic   : 4 bytes "GSER"
//   version : u8 (currently 1)
//   count   : u32 number of objects
//   tags    : count x (u16 length + tag bytes), in ID order
//   fields  : per-object field data, in ID order (layout defined by each type)
//   root    : u32 ID of the root object (always 0 for graphs produced here)
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace graphser {

class error : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class unknown_type_error : public error {
public:
  explicit unknown_type_error(const std::string& tag)
      : error("unknown type tag: " + tag) {}
};

class format_error : public error {
public:
  using error::error;
};

using Id = std::uint32_t;
inline constexpr Id null_id = 0xFFFFFFFFu;

class Serializable;

// ---------------------------------------------------------------------------
// Field-level interfaces. User types implement write_fields/read_fields
// against these; the library drives them with different concrete backends
// (numbering, binary emit, binary parse).
// ---------------------------------------------------------------------------

struct FieldWriter {
  virtual ~FieldWriter() = default;
  virtual void u8(std::uint8_t v) = 0;
  virtual void u32(std::uint32_t v) = 0;
  virtual void u64(std::uint64_t v) = 0;
  virtual void i64(std::int64_t v) = 0;
  virtual void f64(double v) = 0;
  virtual void str(std::string_view v) = 0;
  virtual void ref_any(const std::shared_ptr<const Serializable>& p) = 0;

  template <typename T>
  void ref(const std::shared_ptr<T>& p) {
    ref_any(p);
  }
};

struct FieldReader {
  virtual ~FieldReader() = default;
  virtual std::uint8_t u8() = 0;
  virtual std::uint32_t u32() = 0;
  virtual std::uint64_t u64() = 0;
  virtual std::int64_t i64() = 0;
  virtual double f64() = 0;
  virtual std::string str() = 0;
  virtual std::shared_ptr<Serializable> ref_any() = 0;

  template <typename T>
  void ref(std::shared_ptr<T>& out) {
    std::shared_ptr<Serializable> p = ref_any();
    if (!p) {
      out.reset();
      return;
    }
    out = std::dynamic_pointer_cast<T>(std::move(p));
    if (!out)
      throw format_error("reference points to an incompatible type");
  }
};

// Base class for serializable objects.
class Serializable {
public:
  virtual ~Serializable() = default;
  virtual std::string_view type_tag() const noexcept = 0;
  virtual void write_fields(FieldWriter& w) const = 0;
  virtual void read_fields(FieldReader& r) = 0;
  // Reset every reference field. Called by the deserializer on failure so
  // that partially built cycles cannot leak. Must not throw.
  virtual void break_cycles() noexcept = 0;
};

// ---------------------------------------------------------------------------
// Type registry: tag -> factory. Unknown tags are rejected.
// ---------------------------------------------------------------------------

class TypeRegistry {
public:
  template <typename T>
  void register_type(std::string tag) {
    static_assert(std::is_base_of_v<Serializable, T>);
    register_factory(std::move(tag),
                     [] {
                       return std::static_pointer_cast<Serializable>(
                           std::make_shared<T>());
                     });
  }

  void register_factory(
      std::string tag,
      std::function<std::shared_ptr<Serializable>()> factory) {
    factories_[std::move(tag)] = std::move(factory);
  }

  [[nodiscard]] std::shared_ptr<Serializable> create(
      std::string_view tag) const {
    auto it = factories_.find(tag);
    if (it == factories_.end())
      throw unknown_type_error(std::string(tag));
    std::shared_ptr<Serializable> obj = it->second();
    if (!obj)
      throw format_error("factory returned null for tag: " +
                         std::string(tag));
    return obj;
  }

private:
  std::map<std::string, std::function<std::shared_ptr<Serializable>()>,
           std::less<>>
      factories_;
};

namespace detail {

inline void append_u8(std::vector<std::byte>& buf, std::uint8_t v) {
  buf.push_back(static_cast<std::byte>(v));
}

inline void append_u16(std::vector<std::byte>& buf, std::uint16_t v) {
  buf.push_back(static_cast<std::byte>(v & 0xFFu));
  buf.push_back(static_cast<std::byte>((v >> 8u) & 0xFFu));
}

inline void append_u32(std::vector<std::byte>& buf, std::uint32_t v) {
  for (unsigned shift = 0; shift < 32; shift += 8)
    buf.push_back(static_cast<std::byte>((v >> shift) & 0xFFu));
}

inline void append_u64(std::vector<std::byte>& buf, std::uint64_t v) {
  for (unsigned shift = 0; shift < 64; shift += 8)
    buf.push_back(static_cast<std::byte>((v >> shift) & 0xFFu));
}

// Assigns IDs by pre-order DFS from the root, recursing into reference
// fields in the order write_fields() visits them. Address-independent:
// the map is only consulted for "have we seen this object", never ordered.
class NumberingWriter final : public FieldWriter {
public:
  void u8(std::uint8_t) override {}
  void u32(std::uint32_t) override {}
  void u64(std::uint64_t) override {}
  void i64(std::int64_t) override {}
  void f64(double) override {}
  void str(std::string_view) override {}

  void ref_any(const std::shared_ptr<const Serializable>& p) override {
    if (!p)
      return;
    const Serializable* raw = p.get();
    if (ids_.contains(raw))
      return;
    ids_.emplace(raw, static_cast<Id>(order_.size()));
    order_.push_back(raw);
    p->write_fields(*this); // recurse: pre-order DFS in field order
  }

  [[nodiscard]] const std::unordered_map<const Serializable*, Id>&
  ids() const {
    return ids_;
  }
  [[nodiscard]] const std::vector<const Serializable*>& order() const {
    return order_;
  }

private:
  std::unordered_map<const Serializable*, Id> ids_;
  std::vector<const Serializable*> order_;
};

class BinaryFieldWriter final : public FieldWriter {
public:
  BinaryFieldWriter(
      std::vector<std::byte>& buf,
      const std::unordered_map<const Serializable*, Id>& ids)
      : buf_(buf), ids_(ids) {}

  void u8(std::uint8_t v) override { append_u8(buf_, v); }
  void u32(std::uint32_t v) override { append_u32(buf_, v); }
  void u64(std::uint64_t v) override { append_u64(buf_, v); }
  void i64(std::int64_t v) override {
    append_u64(buf_, static_cast<std::uint64_t>(v));
  }
  void f64(double v) override {
    static_assert(sizeof(double) == sizeof(std::uint64_t));
    std::uint64_t bits;
    std::memcpy(&bits, &v, sizeof(bits));
    append_u64(buf_, bits);
  }
  void str(std::string_view v) override {
    if (v.size() > 0xFFFFu)
      throw error("string field too long");
    append_u16(buf_, static_cast<std::uint16_t>(v.size()));
    for (char c : v)
      buf_.push_back(static_cast<std::byte>(c));
  }
  void ref_any(const std::shared_ptr<const Serializable>& p) override {
    if (!p) {
      append_u32(buf_, null_id);
      return;
    }
    auto it = ids_.find(p.get());
    if (it == ids_.end())
      throw error("reference to object outside the serialized graph");
    append_u32(buf_, it->second);
  }

private:
  std::vector<std::byte>& buf_;
  const std::unordered_map<const Serializable*, Id>& ids_;
};

class ByteReader {
public:
  explicit ByteReader(std::span<const std::byte> data) : data_(data) {}

  std::uint8_t u8() {
    require(1);
    return static_cast<std::uint8_t>(data_[pos_++]);
  }
  std::uint16_t u16() {
    require(2);
    std::uint16_t v =
        static_cast<std::uint16_t>(data_[pos_]) |
        static_cast<std::uint16_t>(
            static_cast<std::uint16_t>(data_[pos_ + 1]) << 8u);
    pos_ += 2;
    return v;
  }
  std::uint32_t u32() {
    require(4);
    std::uint32_t v = 0;
    for (unsigned i = 0; i < 4; ++i)
      v |= static_cast<std::uint32_t>(data_[pos_ + i]) << (8u * i);
    pos_ += 4;
    return v;
  }
  std::uint64_t u64() {
    require(8);
    std::uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i)
      v |= static_cast<std::uint64_t>(data_[pos_ + i]) << (8u * i);
    pos_ += 8;
    return v;
  }
  std::string str() {
    std::uint16_t len = u16();
    require(len);
    std::string s(reinterpret_cast<const char*>(data_.data() + pos_), len);
    pos_ += len;
    return s;
  }
  void expect_magic(std::string_view magic) {
    require(magic.size());
    for (char c : magic) {
      if (static_cast<char>(data_[pos_++]) != c)
        throw format_error("bad magic header");
    }
  }
  [[nodiscard]] bool at_end() const { return pos_ == data_.size(); }
  [[nodiscard]] std::size_t remaining() const { return data_.size() - pos_; }

private:
  void require(std::size_t n) const {
    if (remaining() < n)
      throw format_error("unexpected end of data");
  }
  std::span<const std::byte> data_;
  std::size_t pos_ = 0;
};

class BinaryFieldReader final : public FieldReader {
public:
  BinaryFieldReader(
      ByteReader& r,
      const std::vector<std::shared_ptr<Serializable>>& objects)
      : r_(r), objects_(objects) {}

  std::uint8_t u8() override { return r_.u8(); }
  std::uint32_t u32() override { return r_.u32(); }
  std::uint64_t u64() override { return r_.u64(); }
  std::int64_t i64() override {
    return static_cast<std::int64_t>(r_.u64());
  }
  double f64() override {
    std::uint64_t bits = r_.u64();
    double v;
    std::memcpy(&v, &bits, sizeof(v));
    return v;
  }
  std::string str() override { return r_.str(); }
  std::shared_ptr<Serializable> ref_any() override {
    Id id = r_.u32();
    if (id == null_id)
      return nullptr;
    if (id >= objects_.size())
      throw format_error("reference id out of range");
    return objects_[id];
  }

private:
  ByteReader& r_;
  const std::vector<std::shared_ptr<Serializable>>& objects_;
};

} // namespace detail

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

[[nodiscard]] inline std::vector<std::byte>
serialize(const std::shared_ptr<const Serializable>& root) {
  if (!root)
    throw error("cannot serialize a null root");

  detail::NumberingWriter numbering;
  numbering.ref_any(root);
  const auto& order = numbering.order();

  std::vector<std::byte> buf;
  buf.reserve(64 * order.size());
  for (char c : std::string_view("GSER"))
    buf.push_back(static_cast<std::byte>(c));
  detail::append_u8(buf, 1); // version
  detail::append_u32(buf, static_cast<std::uint32_t>(order.size()));

  for (const Serializable* obj : order) {
    std::string_view tag = obj->type_tag();
    if (tag.empty() || tag.size() > 0xFFFFu)
      throw error("invalid type tag");
    detail::append_u16(buf, static_cast<std::uint16_t>(tag.size()));
    for (char c : tag)
      buf.push_back(static_cast<std::byte>(c));
  }

  detail::BinaryFieldWriter writer(buf, numbering.ids());
  for (const Serializable* obj : order)
    obj->write_fields(writer);

  detail::append_u32(buf, 0); // root id: DFS from root => always 0
  return buf;
}

[[nodiscard]] inline std::shared_ptr<Serializable>
deserialize(std::span<const std::byte> data, const TypeRegistry& registry) {
  detail::ByteReader r(data);
  r.expect_magic("GSER");
  if (r.u8() != 1)
    throw format_error("unsupported format version");

  const std::uint32_t count = r.u32();
  // Every object needs at least a 2-byte tag length, so a larger count is
  // impossible; this guards against corrupt counts causing huge reserves.
  if (count > r.remaining() / 2 + 1)
    throw format_error("implausible object count");

  std::vector<std::string> tags;
  tags.reserve(count);
  for (std::uint32_t i = 0; i < count; ++i)
    tags.push_back(r.str());

  std::vector<std::shared_ptr<Serializable>> objects;
  objects.reserve(count);
  try {
    for (const std::string& tag : tags)
      objects.push_back(registry.create(tag)); // rejects unknown tags

    detail::BinaryFieldReader fields(r, objects);
    for (const auto& obj : objects)
      obj->read_fields(fields);

    const Id root_id = r.u32();
    if (root_id >= count)
      throw format_error("root id out of range");
    if (!r.at_end())
      throw format_error("trailing bytes after graph");
    return objects[root_id];
  } catch (...) {
    // Break every partially built cycle, then release all objects. After
    // break_cycles() the only owners are this vector, so clear() frees
    // everything that was created.
    for (const auto& obj : objects)
      obj->break_cycles();
    objects.clear();
    throw;
  }
}

} // namespace graphser
