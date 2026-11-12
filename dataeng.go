// Package dataeng computes the minimum set of records to remove from a
// rejected ingest batch so that the remaining records satisfy every
// caller-supplied constraint.
//
// Constraints are either uniqueness of a field or a functional dependency
// (a set of determinant fields decides a dependent field). Null is compared
// as an ordinary value: two nulls are equal, and a missing field is null.
//
// The search is exact: removal sets are enumerated by increasing size and
// every set of a given size is validated, so the result is provably optimal
// rather than a greedy maximum-independent-set approximation. Ties between
// optimal removals are broken by byte-wise lexicographic order of the
// ascending record-ID list.
package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// MaxRecords is the largest batch the solver accepts. The exact search is
// exponential in the number of records, so inputs are capped.
const MaxRecords = 20

var (
	ErrTooManyRecords    = errors.New("dataeng: batch exceeds 20 records")
	ErrDuplicateRecordID = errors.New("dataeng: duplicate record id")
	ErrEmptyRecordID     = errors.New("dataeng: empty record id")
	ErrInvalidConstraint = errors.New("dataeng: invalid constraint")
)

// Record is one row of the rejected batch. IDs must be unique within a
// batch. A missing field in Fields is treated as null.
type Record struct {
	ID     string
	Fields map[string]any
}

// ConstraintKind selects the shape of a Constraint.
type ConstraintKind int

const (
	// KindUnique requires every kept record to hold a distinct value in
	// Field. Null counts as an ordinary value, so two nulls conflict.
	KindUnique ConstraintKind = iota
	// KindFunctionalDependency requires that kept records agreeing on
	// every Determinants field also agree on Dependent.
	KindFunctionalDependency
)

// Constraint describes one rule the kept records must satisfy. Build
// constraints with Unique or Determines.
type Constraint struct {
	Kind ConstraintKind
	// Field is the constrained field for KindUnique.
	Field string
	// Determinants and Dependent describe a functional dependency
	// Determinants -> Dependent for KindFunctionalDependency.
	Determinants []string
	Dependent    string
}

// Unique returns a constraint requiring field to hold a distinct value in
// every kept record.
func Unique(field string) Constraint {
	return Constraint{Kind: KindUnique, Field: field}
}

// Determines returns a functional dependency constraint: kept records that
// agree on all determinant fields must agree on dependent.
func Determines(determinants []string, dependent string) Constraint {
	return Constraint{
		Kind:         KindFunctionalDependency,
		Determinants: append([]string(nil), determinants...),
		Dependent:    dependent,
	}
}

func (c Constraint) validate() error {
	switch c.Kind {
	case KindUnique:
		if c.Field == "" {
			return fmt.Errorf("%w: unique constraint needs a field", ErrInvalidConstraint)
		}
	case KindFunctionalDependency:
		if len(c.Determinants) == 0 {
			return fmt.Errorf("%w: dependency needs at least one determinant", ErrInvalidConstraint)
		}
		for _, d := range c.Determinants {
			if d == "" {
				return fmt.Errorf("%w: empty determinant field", ErrInvalidConstraint)
			}
		}
		if c.Dependent == "" {
			return fmt.Errorf("%w: dependency needs a dependent field", ErrInvalidConstraint)
		}
	default:
		return fmt.Errorf("%w: unknown kind %d", ErrInvalidConstraint, c.Kind)
	}
	return nil
}

// Conflict is evidence that a group of records violates a constraint in the
// original batch.
type Conflict struct {
	// Constraint is the violated rule.
	Constraint Constraint
	// Key identifies the colliding value: the duplicated field value for a
	// unique constraint, or the determinant tuple for a functional
	// dependency. It is a canonical encoding; null renders as "null".
	Key string
	// RecordIDs lists the records involved, sorted ascending.
	RecordIDs []string
}

// Removal pairs a removed record ID with the original-batch conflicts that
// involve it.
type Removal struct {
	RecordID  string
	Conflicts []Conflict
}

// Result is the outcome of MinRemovalSet.
type Result struct {
	// RemovedIDs is the minimum removal set, sorted ascending.
	RemovedIDs []string
	// KeptIDs lists the surviving record IDs, sorted ascending.
	KeptIDs []string
	// Removals carries, for each removed record, the original conflict
	// evidence involving it, in the same order as RemovedIDs.
	Removals []Removal
}

// MinRemovalSet finds the smallest set of records whose removal makes the
// remaining batch satisfy every constraint. Among minimum sets it picks the
// one whose ascending ID list is byte-wise lexicographically smallest.
//
// The search enumerates and validates all subsets of each candidate size,
// so the returned set is guaranteed optimal; no greedy heuristic is used.
func MinRemovalSet(records []Record, constraints []Constraint) (*Result, error) {
	if err := validateInput(records, constraints); err != nil {
		return nil, err
	}

	original := findConflicts(records, constraints)
	v := newValidator(records, constraints)

	n := len(records)
	for size := 0; size <= n; size++ {
		var best []int
		var bestIDs []string
		found := false
		eachCombination(n, size, func(comb []int) {
			if !v.valid(comb) {
				return
			}
			ids := sortedIDs(records, comb)
			if !found || lessIDs(ids, bestIDs) {
				found = true
				best = append([]int(nil), comb...)
				bestIDs = ids
			}
		})
		if found {
			return buildResult(records, best, original), nil
		}
	}
	// Unreachable: removing every record always satisfies all constraints.
	return buildResult(records, allIndices(n), original), nil
}

func validateInput(records []Record, constraints []Constraint) error {
	if len(records) > MaxRecords {
		return fmt.Errorf("%w: got %d", ErrTooManyRecords, len(records))
	}
	seen := make(map[string]struct{}, len(records))
	for _, r := range records {
		if r.ID == "" {
			return ErrEmptyRecordID
		}
		if _, dup := seen[r.ID]; dup {
			return fmt.Errorf("%w: %q", ErrDuplicateRecordID, r.ID)
		}
		seen[r.ID] = struct{}{}
	}
	for _, c := range constraints {
		if err := c.validate(); err != nil {
			return err
		}
	}
	return nil
}

// validator decides whether a removal set leaves a constraint-satisfying
// batch. It works from the conflict groups of the original batch: removing
// records can only shrink groups, so a removal set is valid exactly when it
// resolves every originally-violating group. This keeps each of the up to
// 2^20 subset checks allocation-free.
type validator struct {
	n       int
	uniques [][]int // record indices sharing one unique-constrained value
	fds     []fdGroup
}

type fdGroup struct {
	idx  []int
	deps []string // dependent value keys, parallel to idx
}

func newValidator(records []Record, constraints []Constraint) *validator {
	v := &validator{n: len(records)}
	for _, c := range constraints {
		switch c.Kind {
		case KindUnique:
			groups := make(map[string][]int)
			for i, r := range records {
				k := valueKey(r.Fields[c.Field])
				groups[k] = append(groups[k], i)
			}
			for _, g := range groups {
				if len(g) > 1 {
					v.uniques = append(v.uniques, g)
				}
			}
		case KindFunctionalDependency:
			groups := make(map[string]*fdGroup)
			for i, r := range records {
				parts := make([]string, len(c.Determinants))
				for j, d := range c.Determinants {
					parts[j] = valueKey(r.Fields[d])
				}
				k := "[" + strings.Join(parts, ",") + "]"
				g, ok := groups[k]
				if !ok {
					g = &fdGroup{}
					groups[k] = g
				}
				g.idx = append(g.idx, i)
				g.deps = append(g.deps, valueKey(r.Fields[c.Dependent]))
			}
			for _, g := range groups {
				if distinctStrings(g.deps) > 1 {
					v.fds = append(v.fds, *g)
				}
			}
		}
	}
	return v
}

// valid reports whether dropping the given record indices resolves every
// original conflict group.
func (v *validator) valid(removed []int) bool {
	var dropped [MaxRecords]bool
	for _, i := range removed {
		dropped[i] = true
	}
	for _, g := range v.uniques {
		kept := 0
		for _, i := range g {
			if !dropped[i] {
				kept++
			}
		}
		if kept > 1 {
			return false
		}
	}
	for _, g := range v.fds {
		first := ""
		seen := false
		for k, i := range g.idx {
			if dropped[i] {
				continue
			}
			if !seen {
				first, seen = g.deps[k], true
			} else if g.deps[k] != first {
				return false
			}
		}
	}
	return true
}

func distinctStrings(list []string) int {
	seen := make(map[string]struct{}, len(list))
	for _, s := range list {
		seen[s] = struct{}{}
	}
	return len(seen)
}

// findConflicts lists every constraint violation among the given records.
// The result is deterministic: conflicts are ordered by constraint position
// and then by key, and record IDs within a conflict are sorted.
func findConflicts(records []Record, constraints []Constraint) []Conflict {
	var out []Conflict
	for _, c := range constraints {
		switch c.Kind {
		case KindUnique:
			groups := make(map[string][]string)
			for _, r := range records {
				k := valueKey(r.Fields[c.Field])
				groups[k] = append(groups[k], r.ID)
			}
			keys := make([]string, 0, len(groups))
			for k := range groups {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if ids := groups[k]; len(ids) > 1 {
					sort.Strings(ids)
					out = append(out, Conflict{Constraint: c, Key: k, RecordIDs: ids})
				}
			}
		case KindFunctionalDependency:
			type group struct {
				ids       []string
				depValues map[string]struct{}
			}
			groups := make(map[string]*group)
			for _, r := range records {
				parts := make([]string, len(c.Determinants))
				for i, d := range c.Determinants {
					parts[i] = valueKey(r.Fields[d])
				}
				k := "[" + strings.Join(parts, ",") + "]"
				g, ok := groups[k]
				if !ok {
					g = &group{depValues: make(map[string]struct{})}
					groups[k] = g
				}
				g.ids = append(g.ids, r.ID)
				g.depValues[valueKey(r.Fields[c.Dependent])] = struct{}{}
			}
			keys := make([]string, 0, len(groups))
			for k := range groups {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				g := groups[k]
				if len(g.depValues) > 1 {
					ids := append([]string(nil), g.ids...)
					sort.Strings(ids)
					out = append(out, Conflict{Constraint: c, Key: k, RecordIDs: ids})
				}
			}
		}
	}
	return out
}

func buildResult(records []Record, removed []int, original []Conflict) *Result {
	dropped := make(map[int]struct{}, len(removed))
	for _, i := range removed {
		dropped[i] = struct{}{}
	}
	res := &Result{
		RemovedIDs: sortedIDs(records, removed),
		KeptIDs:    make([]string, 0, len(records)-len(removed)),
	}
	for i, r := range records {
		if _, ok := dropped[i]; !ok {
			res.KeptIDs = append(res.KeptIDs, r.ID)
		}
	}
	sort.Strings(res.KeptIDs)
	for _, id := range res.RemovedIDs {
		rm := Removal{RecordID: id}
		for _, c := range original {
			if containsString(c.RecordIDs, id) {
				rm.Conflicts = append(rm.Conflicts, c)
			}
		}
		res.Removals = append(res.Removals, rm)
	}
	return res
}

func sortedIDs(records []Record, indices []int) []string {
	ids := make([]string, len(indices))
	for i, idx := range indices {
		ids[i] = records[idx].ID
	}
	sort.Strings(ids)
	return ids
}

// lessIDs compares two equal-length ascending ID lists byte-wise.
func lessIDs(a, b []string) bool {
	for i := range a {
		if a[i] != b[i] {
			return strings.Compare(a[i], b[i]) < 0
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func allIndices(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

// eachCombination calls fn with every size-k index combination of
// 0..n-1 in lexicographic index order.
func eachCombination(n, k int, fn func(comb []int)) {
	comb := make([]int, k)
	var walk func(start, depth int)
	walk = func(start, depth int) {
		if depth == k {
			fn(comb)
			return
		}
		for i := start; i <= n-(k-depth); i++ {
			comb[depth] = i
			walk(i+1, depth+1)
		}
	}
	walk(0, 0)
}

// valueKey renders a field value as a canonical, comparable string. Null
// (including a missing field) is an ordinary value: it encodes as "null"
// and therefore compares equal to any other null.
func valueKey(v any) string {
	var sb strings.Builder
	writeValueKey(&sb, v)
	return sb.String()
}

func writeValueKey(sb *strings.Builder, v any) {
	switch t := v.(type) {
	case nil:
		sb.WriteString("null")
	case string:
		b, _ := json.Marshal(t)
		sb.Write(b)
	case bool:
		if t {
			sb.WriteString("true")
		} else {
			sb.WriteString("false")
		}
	case float64:
		b, _ := json.Marshal(t)
		sb.Write(b)
	case json.Number:
		sb.WriteString(t.String())
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		sb.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				sb.WriteByte(',')
			}
			kb, _ := json.Marshal(k)
			sb.Write(kb)
			sb.WriteByte(':')
			writeValueKey(sb, t[k])
		}
		sb.WriteByte('}')
	case []any:
		sb.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				sb.WriteByte(',')
			}
			writeValueKey(sb, e)
		}
		sb.WriteByte(']')
	default:
		if b, err := json.Marshal(v); err == nil {
			sb.Write(b)
		} else {
			fmt.Fprintf(sb, "%#v", v)
		}
	}
}
