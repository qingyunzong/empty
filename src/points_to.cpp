#include "pta/points_to.h"

namespace pta {

Stmt alloc(Var dst, std::size_t site) {
  return Stmt{Stmt::Kind::Alloc, std::move(dst), {}, {}, site};
}
Stmt copy(Var dst, Var src) {
  return Stmt{Stmt::Kind::Copy, std::move(dst), std::move(src), {}, 0};
}
Stmt load(Var dst, Var src, Field field) {
  return Stmt{Stmt::Kind::Load, std::move(dst), std::move(src),
              std::move(field), 0};
}
Stmt store(Var dst, Field field, Var src) {
  return Stmt{Stmt::Kind::Store, std::move(dst), std::move(src),
              std::move(field), 0};
}

std::size_t Analysis::add(Stmt stmt) {
  stmts_.push_back(std::move(stmt));
  dirty_ = true;
  return stmts_.size() - 1;
}

bool Analysis::remove(std::size_t id) {
  if (id >= stmts_.size() || !stmts_[id].has_value()) return false;
  stmts_[id].reset();
  dirty_ = true;
  return true;
}

std::vector<Stmt> Analysis::statements() const {
  std::vector<Stmt> out;
  for (const auto& s : stmts_)
    if (s.has_value()) out.push_back(*s);
  return out;
}

void Analysis::solve() {
  if (!dirty_) return;
  // Recompute from the empty solution: no alias can survive without support
  // from the live statements.
  var_pts_.clear();
  field_pts_.clear();

  bool changed = true;
  while (changed) {  // least-fixpoint iteration (handles loops/cycles)
    changed = false;
    for (const auto& opt : stmts_) {
      if (!opt.has_value()) continue;
      const Stmt& s = *opt;
      auto& dst_pts = var_pts_[s.dst];
      auto absorb = [](ObjSet& into, const ObjSet& from, bool& changed) {
        for (const Obj& o : from)
          if (into.insert(o).second) changed = true;
      };
      switch (s.kind) {
        case Stmt::Kind::Alloc:
          // Inclusion constraint: {obj@site} ⊆ pts(dst)
          if (dst_pts.insert(Obj{s.site}).second) changed = true;
          break;
        case Stmt::Kind::Copy:
          // pts(src) ⊆ pts(dst)
          if (auto it = var_pts_.find(s.src); it != var_pts_.end())
            absorb(dst_pts, it->second, changed);
          break;
        case Stmt::Kind::Load:
          // ∀o ∈ pts(src): fld(o, field) ⊆ pts(dst)
          if (auto it = var_pts_.find(s.src); it != var_pts_.end())
            for (const Obj& o : it->second)
              if (auto fit = field_pts_.find(o); fit != field_pts_.end())
                if (auto fit2 = fit->second.find(s.field);
                    fit2 != fit->second.end())
                  absorb(dst_pts, fit2->second, changed);
          break;
        case Stmt::Kind::Store: {
          // ∀o ∈ pts(dst): pts(src) ⊆ fld(o, field)
          auto src_it = var_pts_.find(s.src);
          if (src_it == var_pts_.end() || src_it->second.empty()) break;
          ObjSet dst_snapshot = dst_pts;  // iterate over a stable snapshot
          for (const Obj& o : dst_snapshot)
            absorb(field_pts_[o][s.field], src_it->second, changed);
          break;
        }
      }
    }
  }
  dirty_ = false;
}

const Analysis::VarPts& Analysis::var_points_to() {
  solve();
  return var_pts_;
}

const Analysis::FieldPts& Analysis::field_points_to() {
  solve();
  return field_pts_;
}

Analysis::ObjSet Analysis::points_to(const Var& var) {
  solve();
  if (auto it = var_pts_.find(var); it != var_pts_.end()) return it->second;
  return {};
}

Analysis analyze(const std::vector<Stmt>& stmts) {
  Analysis a;
  for (const Stmt& s : stmts) a.add(s);
  a.solve();
  return a;
}

}  // namespace pta
