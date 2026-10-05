#pragma once

// ser::serializer — 保留对象共享与环的图序列化库（仅依赖 C++20 标准库）。
//
// 设计要点:
//  * 稳定 ID: 从根出发按字段声明序做广度优先首访分配 (1..N), 与指针地址无关,
//    因此同一逻辑图无论分配顺序如何都产生字节级一致的输出。
//  * 共享与环: 指针字段序列化为对象 ID (0 表示空), 反序列化两阶段
//    (先构造全部对象, 再统一回填引用), 天然支持任意环与共享。
//  * 异常安全: 反序列化期间所有已构造对象由 unique_ptr 守卫持有,
//    任何异常 (未知类型 / 格式错误 / 工厂抛出的注入失败) 都会全部释放。
//  * 未知类型拒绝: 类型名必须在 Registry 中注册, 否则抛 UnknownTypeError。

#include <charconv>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <typeindex>
#include <typeinfo>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ser {

class Error : public std::runtime_error {
public:
  using std::runtime_error::runtime_error;
};

class UnknownTypeError : public Error {
public:
  explicit UnknownTypeError(const std::string& type_name)
      : Error("unknown type: " + type_name) {}
};

class FormatError : public Error {
public:
  using Error::Error;
};

class Serializable {
public:
  virtual ~Serializable() = default;
  virtual void write_fields(class FieldWriter& w) const = 0;
  virtual void read_fields(class FieldReader& r) = 0;
};

class FieldWriter {
public:
  virtual ~FieldWriter() = default;
  virtual void field_int(std::int64_t value) = 0;
  virtual void field_str(const std::string& value) = 0;
  virtual void field_ref(const Serializable* ptr) = 0;
};

class FieldReader {
public:
  virtual ~FieldReader() = default;
  virtual std::int64_t read_int() = 0;
  virtual std::string read_str() = 0;

  template <typename T>
  void read_ref(T*& ptr) {
    const std::uint32_t id = read_ref_id();
    add_fixup(id, [slot = &ptr](Serializable* resolved) {
      if (!resolved) {
        *slot = nullptr;
        return;
      }
      auto* casted = dynamic_cast<T*>(resolved);
      if (!casted)
        throw FormatError("reference points to incompatible type");
      *slot = casted;
    });
  }

protected:
  virtual std::uint32_t read_ref_id() = 0;
  virtual void add_fixup(std::uint32_t id,
                         std::function<void(Serializable*)> apply) = 0;
};

class Registry {
public:
  template <typename T>
  void add(std::string name) {
    static_assert(std::is_base_of_v<Serializable, T>,
                  "registered type must derive from ser::Serializable");
    add_factory(std::move(name), typeid(T), []() -> std::unique_ptr<Serializable> {
      return std::make_unique<T>();
    });
  }

  void add_factory(std::string name, const std::type_info& type,
                   std::function<std::unique_ptr<Serializable>()> factory) {
    if (name.empty() || name.find_first_of(" \n") != std::string::npos)
      throw Error("invalid type name: " + name);
    if (!factory)
      throw Error("null factory for type: " + name);
    if (by_name_.count(name))
      throw Error("duplicate type name: " + name);
    if (by_type_.count(std::type_index(type)))
      throw Error("type already registered: " + name);
    by_name_.emplace(name, std::move(factory));
    by_type_.emplace(std::type_index(type), std::move(name));
  }

  const std::string& name_of(const std::type_info& type) const {
    auto it = by_type_.find(std::type_index(type));
    if (it == by_type_.end())
      throw Error(std::string("unregistered type: ") + type.name());
    return it->second;
  }

  std::unique_ptr<Serializable> create(const std::string& name) const {
    auto it = by_name_.find(name);
    if (it == by_name_.end())
      throw UnknownTypeError(name);
    return it->second();
  }

private:
  std::unordered_map<std::string, std::function<std::unique_ptr<Serializable>()>>
      by_name_;
  std::unordered_map<std::type_index, std::string> by_type_;
};

namespace detail {

class ScanWriter final : public FieldWriter {
public:
  explicit ScanWriter(std::function<void(const Serializable*)> on_ref)
      : on_ref_(std::move(on_ref)) {}
  void field_int(std::int64_t) override {}
  void field_str(const std::string&) override {}
  void field_ref(const Serializable* ptr) override { on_ref_(ptr); }

private:
  std::function<void(const Serializable*)> on_ref_;
};

class EmitWriter final : public FieldWriter {
public:
  EmitWriter(std::string& out,
             const std::unordered_map<const Serializable*, std::uint32_t>& ids)
      : out_(out), ids_(ids) {}
  void field_int(std::int64_t value) override {
    out_ += "I " + std::to_string(value) + "\n";
  }
  void field_str(const std::string& value) override {
    out_ += "S " + std::to_string(value.size()) + " ";
    out_ += value;
    out_ += "\n";
  }
  void field_ref(const Serializable* ptr) override {
    std::uint32_t id = 0;
    if (ptr)
      id = ids_.at(ptr);
    out_ += "R " + std::to_string(id) + "\n";
  }

private:
  std::string& out_;
  const std::unordered_map<const Serializable*, std::uint32_t>& ids_;
};

class Cursor {
public:
  explicit Cursor(std::string_view sv) : sv_(sv) {}

  bool eof() {
    skip_ws();
    return pos_ == sv_.size();
  }

  std::string_view token() {
    skip_ws();
    if (pos_ == sv_.size())
      throw FormatError("unexpected end of input");
    const std::size_t start = pos_;
    while (pos_ < sv_.size() && sv_[pos_] != ' ' && sv_[pos_] != '\n')
      ++pos_;
    return sv_.substr(start, pos_ - start);
  }

  void expect(std::string_view want, const char* what) {
    if (token() != want)
      throw FormatError(what);
  }

  std::uint32_t parse_u32() {
    const std::string_view t = token();
    std::uint64_t value = 0;
    const auto* first = t.data();
    const auto* last = t.data() + t.size();
    auto [ptr, ec] = std::from_chars(first, last, value);
    if (ec != std::errc() || ptr != last || value > 0xFFFFFFFFull)
      throw FormatError("invalid unsigned integer");
    return static_cast<std::uint32_t>(value);
  }

  std::int64_t parse_i64() {
    const std::string_view t = token();
    std::int64_t value = 0;
    const auto* first = t.data();
    const auto* last = t.data() + t.size();
    auto [ptr, ec] = std::from_chars(first, last, value);
    if (ec != std::errc() || ptr != last)
      throw FormatError("invalid integer");
    return value;
  }

  // 读取恰好一个空格分隔符后的 n 个原始字节 (字符串字段, 可含任意字节)。
  std::string bytes(std::size_t n) {
    if (pos_ >= sv_.size() || sv_[pos_] != ' ')
      throw FormatError("expected space before string payload");
    ++pos_;
    if (sv_.size() - pos_ < n)
      throw FormatError("truncated string payload");
    std::string out(sv_.substr(pos_, n));
    pos_ += n;
    return out;
  }

private:
  void skip_ws() {
    while (pos_ < sv_.size() && (sv_[pos_] == ' ' || sv_[pos_] == '\n'))
      ++pos_;
  }

  std::string_view sv_;
  std::size_t pos_ = 0;
};

using Fixup = std::pair<std::uint32_t, std::function<void(Serializable*)>>;

class StreamReader final : public FieldReader {
public:
  StreamReader(Cursor& cur, std::vector<Fixup>& fixups)
      : cur_(cur), fixups_(fixups) {}

  std::int64_t read_int() override {
    cur_.expect("I", "expected int field");
    return cur_.parse_i64();
  }

  std::string read_str() override {
    cur_.expect("S", "expected string field");
    return cur_.bytes(cur_.parse_u32());
  }

protected:
  std::uint32_t read_ref_id() override {
    cur_.expect("R", "expected ref field");
    return cur_.parse_u32();
  }

  void add_fixup(std::uint32_t id,
                 std::function<void(Serializable*)> apply) override {
    fixups_.emplace_back(id, std::move(apply));
  }

private:
  Cursor& cur_;
  std::vector<Fixup>& fixups_;
};

}  // namespace detail

inline std::string serialize(const Registry& reg, const Serializable* root) {
  // 阶段一: 从根按字段序 BFS, 首访即分配递增 ID。键用指针仅作去重,
  // ID 取值只取决于遍历顺序, 与地址无关。
  std::vector<const Serializable*> order;
  std::unordered_map<const Serializable*, std::uint32_t> ids;
  const auto assign = [&](const Serializable* ptr) {
    if (!ptr)
      return;
    if (ids.emplace(ptr, static_cast<std::uint32_t>(order.size() + 1)).second)
      order.push_back(ptr);
  };
  assign(root);
  detail::ScanWriter scan(assign);
  for (std::size_t i = 0; i < order.size(); ++i)
    order[i]->write_fields(scan);

  // 阶段二: 按 ID 顺序输出记录。
  std::string out = "SER1 " + std::to_string(order.size()) + "\n";
  detail::EmitWriter emit(out, ids);
  for (std::size_t i = 0; i < order.size(); ++i) {
    out += "O " + std::to_string(i + 1) + " " +
           reg.name_of(typeid(*order[i])) + "\n";
    order[i]->write_fields(emit);
    out += "E\n";
  }
  return out;
}

class Graph {
public:
  Graph(Graph&&) = default;
  Graph& operator=(Graph&&) = default;
  Graph(const Graph&) = delete;
  Graph& operator=(const Graph&) = delete;

  Serializable* root() const {
    return objects_.empty() ? nullptr : objects_.front().get();
  }
  template <typename T>
  T* root_as() const {
    return dynamic_cast<T*>(root());
  }
  const std::vector<std::unique_ptr<Serializable>>& objects() const {
    return objects_;
  }
  std::size_t size() const { return objects_.size(); }

private:
  friend Graph deserialize(const Registry&, std::string_view);
  explicit Graph(std::vector<std::unique_ptr<Serializable>> objects)
      : objects_(std::move(objects)) {}
  std::vector<std::unique_ptr<Serializable>> objects_;
};

inline Graph deserialize(const Registry& reg, std::string_view data) {
  detail::Cursor cur(data);
  cur.expect("SER1", "bad magic");
  const std::uint32_t count = cur.parse_u32();
  // 每条记录至少 "O 1 a\nE\n" 数字节, 借此拒绝荒谬的计数, 避免恶意输入触发巨额分配。
  if (count > data.size() / 4 + 1)
    throw FormatError("implausible object count");

  // 异常安全核心: 守卫向量持有全部已构造对象, 任何抛出都会整体释放。
  std::vector<std::unique_ptr<Serializable>> objects;
  objects.reserve(count);
  std::vector<detail::Fixup> fixups;

  for (std::uint32_t i = 1; i <= count; ++i) {
    cur.expect("O", "expected object record");
    if (cur.parse_u32() != i)
      throw FormatError("non-sequential object id");
    const std::string type_name(cur.token());
    auto object = reg.create(type_name);  // 未知类型 / 工厂失败: 抛出让守卫清理
    if (!object)
      throw Error("factory returned null for type: " + type_name);
    detail::StreamReader reader(cur, fixups);
    object->read_fields(reader);
    cur.expect("E", "expected end of object record");
    objects.push_back(std::move(object));
  }
  if (!cur.eof())
    throw FormatError("trailing data after graph");

  // 阶段二: 全部对象就位后统一回填引用 (支持前向引用与环)。
  for (auto& [id, apply] : fixups) {
    if (id == 0) {
      apply(nullptr);
    } else {
      if (id > objects.size())
        throw FormatError("dangling reference id");
      apply(objects[id - 1].get());
    }
  }
  return Graph(std::move(objects));
}

}  // namespace ser
