#include "pta/points_to.hpp"

namespace pta {

namespace {
const std::set<ObjectId> kEmpty;

template <typename T>
bool union_into(std::set<T>& dst, const std::set<T>& src) {
  bool changed = false;
  for (const auto& elem : src)
    changed = dst.insert(elem).second || changed;
  return changed;
}
} // namespace

Statement Statement::alloc(Var dst, ObjectId site) {
  return {Kind::Alloc, std::move(dst), {}, {}, std::move(site)};
}
Statement Statement::addr_of(Var dst, Var src) {
  return {Kind::AddrOf, std::move(dst), std::move(src), {}, {}};
}
Statement Statement::copy(Var dst, Var src) {
  return {Kind::Copy, std::move(dst), std::move(src), {}, {}};
}
Statement Statement::store(Var dst, Field field, Var src) {
  return {Kind::Store, std::move(dst), std::move(src), std::move(field), {}};
}
Statement Statement::load(Var dst, Var src, Field field) {
  return {Kind::Load, std::move(dst), std::move(src), std::move(field), {}};
}

const std::set<ObjectId>& PointsToState::points_to(const Var& var) const {
  auto it = pts.find(var);
  return it == pts.end() ? kEmpty : it->second;
}

const std::set<ObjectId>& PointsToState::field_points_to(
    const ObjectId& obj, const Field& field) const {
  auto obj_it = fields.find(obj);
  if (obj_it == fields.end())
    return kEmpty;
  auto field_it = obj_it->second.find(field);
  return field_it == obj_it->second.end() ? kEmpty : field_it->second;
}

bool apply(const Statement& stmt, PointsToState& state) {
  switch (stmt.kind) {
  case Statement::Kind::Alloc:
    return state.pts[stmt.dst].insert("alloc:" + stmt.site).second;
  case Statement::Kind::AddrOf:
    return state.pts[stmt.dst].insert("stack:" + stmt.src).second;
  case Statement::Kind::Copy:
    // pts(dst) ⊇ pts(src)
    return union_into(state.pts[stmt.dst], state.points_to(stmt.src));
  case Statement::Kind::Store: {
    // 对每个 o ∈ pts(dst)：fields(o, f) ⊇ pts(src)
    bool changed = false;
    for (const auto& obj : state.points_to(stmt.dst))
      changed = union_into(state.fields[obj][stmt.field],
                           state.points_to(stmt.src)) ||
                changed;
    return changed;
  }
  case Statement::Kind::Load: {
    // 对每个 o ∈ pts(src)：pts(dst) ⊇ fields(o, f)
    bool changed = false;
    for (const auto& obj : state.points_to(stmt.src))
      changed = union_into(state.pts[stmt.dst],
                           state.field_points_to(obj, stmt.field)) ||
                changed;
    return changed;
  }
  }
  return false;
}

Analyzer::StmtId Analyzer::add(Statement stmt) {
  stmts_.push_back(std::move(stmt));
  return stmts_.size() - 1;
}

bool Analyzer::remove(StmtId id) {
  if (id >= stmts_.size() || !stmts_[id].has_value())
    return false;
  stmts_[id].reset();
  return true;
}

std::vector<Statement> Analyzer::statements() const {
  std::vector<Statement> out;
  for (const auto& stmt : stmts_)
    if (stmt.has_value())
      out.push_back(*stmt);
  return out;
}

std::size_t Analyzer::solve() {
  // 从空状态重算：删除语句后不会残留无支撑的别名。
  state_ = PointsToState{};
  std::size_t rounds = 0;
  bool changed = true;
  while (changed) {
    changed = false;
    for (const auto& stmt : stmts_)
      if (stmt.has_value())
        changed = apply(*stmt, state_) || changed;
    ++rounds;
  }
  return rounds;
}

} // namespace pta
