#pragma once

#include <cstddef>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace pta {

using Var = std::string;
using Field = std::string;
// 抽象对象标识：堆对象按分配点区分（"alloc:<site>"），栈对象按变量名（"stack:<var>"）。
using ObjectId = std::string;

// 受限语句集：分配、取地址、指针赋值、字段写、字段读。
struct Statement {
  enum class Kind { Alloc, AddrOf, Copy, Store, Load };

  Kind kind;
  Var dst;       // Alloc/AddrOf/Copy/Load 的目标；Store 的基指针
  Var src;       // Copy/Store/Load 的源
  Field field;   // Store/Load 的字段
  ObjectId site; // Alloc 的分配点标签

  static Statement alloc(Var dst, ObjectId site);
  static Statement addr_of(Var dst, Var src);
  static Statement copy(Var dst, Var src);
  static Statement store(Var dst, Field field, Var src); // dst->field = src
  static Statement load(Var dst, Var src, Field field);  // dst = src->field

  bool operator==(const Statement&) const = default;
};

// 分析状态：变量 points-to 集合 + 对象字段的 points-to 集合。
struct PointsToState {
  std::map<Var, std::set<ObjectId>> pts;
  std::map<ObjectId, std::map<Field, std::set<ObjectId>>> fields;

  const std::set<ObjectId>& points_to(const Var& var) const;
  const std::set<ObjectId>& field_points_to(const ObjectId& obj,
                                            const Field& field) const;

  bool operator==(const PointsToState&) const = default;
};

// 包含约束求解器。语句可增删；任何变更后 solve() 从空状态重新求
// 最小不动点，保证结果不保留无支撑的别名。
class Analyzer {
public:
  using StmtId = std::size_t;

  StmtId add(Statement stmt);
  bool remove(StmtId id);

  // 从空状态迭代包含约束直到不动点（最小 points-to 集合），返回迭代轮数。
  std::size_t solve();

  const PointsToState& state() const { return state_; }
  std::vector<Statement> statements() const;

private:
  std::vector<std::optional<Statement>> stmts_;
  PointsToState state_;
};

// 对单条语句应用一次包含约束转移；状态有变化时返回 true。
bool apply(const Statement& stmt, PointsToState& state);

} // namespace pta
