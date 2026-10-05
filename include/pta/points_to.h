#pragma once

#include <cstddef>
#include <optional>
#include <map>
#include <set>
#include <string>
#include <unordered_map>
#include <vector>

namespace pta {

using Var = std::string;
using Field = std::string;

// Heap object, distinguished by allocation site.
struct Obj {
  std::size_t site;
  friend bool operator==(const Obj&, const Obj&) = default;
  friend auto operator<=>(const Obj&, const Obj&) = default;
};

struct Stmt {
  enum class Kind {
    Alloc,  // dst = new <site>
    Copy,   // dst = src
    Load,   // dst = src->field
    Store,  // dst->field = src
  };
  Kind kind;
  Var dst;
  Var src;
  Field field;
  std::size_t site = 0;
  friend bool operator==(const Stmt&, const Stmt&) = default;
};

Stmt alloc(Var dst, std::size_t site);
Stmt copy(Var dst, Var src);
Stmt load(Var dst, Var src, Field field);
Stmt store(Var dst, Field field, Var src);

// Inclusion-constraint (Andersen style) points-to analysis.
//
// Statements can be added and removed. The solution is always recomputed
// from scratch (from the empty solution) to a least fixpoint, so removing a
// statement can never leave behind unsupported aliases.
class Analysis {
public:
  using ObjSet = std::set<Obj>;
  using VarPts = std::unordered_map<Var, ObjSet>;
  using FieldPts = std::map<Obj, std::map<Field, ObjSet>>;

  // Adds a statement, returns its id. Invalidates the current solution.
  std::size_t add(Stmt stmt);
  // Removes a previously added statement. Returns false if id is invalid
  // or already removed. Invalidates the current solution.
  bool remove(std::size_t id);

  // (Re)solves to the least fixpoint. Called lazily by the accessors.
  void solve();

  const VarPts& var_points_to();
  const FieldPts& field_points_to();
  ObjSet points_to(const Var& var);

  // Live (non-removed) statements, in insertion order.
  std::vector<Stmt> statements() const;

private:
  std::vector<std::optional<Stmt>> stmts_;
  VarPts var_pts_;
  FieldPts field_pts_;
  bool dirty_ = false;
};

// Convenience: solve a whole program from empty.
Analysis analyze(const std::vector<Stmt>& stmts);

}  // namespace pta
