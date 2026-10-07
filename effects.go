package effectcheck

import (
	"fmt"
	"sort"
	"strings"
)

// EffectSet is the set of effects a function may perform: regions it
// reads, regions it writes, and exceptions it may throw.
type EffectSet struct {
	Reads  map[string]bool
	Writes map[string]bool
	Throws map[string]bool
}

// NewEffectSet returns the empty (bottom) effect set.
func NewEffectSet() *EffectSet {
	return &EffectSet{
		Reads:  map[string]bool{},
		Writes: map[string]bool{},
		Throws: map[string]bool{},
	}
}

// Clone returns a deep copy.
func (e *EffectSet) Clone() *EffectSet {
	out := NewEffectSet()
	out.Union(e)
	return out
}

func (e *EffectSet) AddRead(r string)  { e.Reads[r] = true }
func (e *EffectSet) AddWrite(r string) { e.Writes[r] = true }
func (e *EffectSet) AddThrow(x string) { e.Throws[x] = true }

// Union merges other into e, reporting whether e changed.
func (e *EffectSet) Union(other *EffectSet) bool {
	changed := false
	for r := range other.Reads {
		if !e.Reads[r] {
			e.Reads[r] = true
			changed = true
		}
	}
	for r := range other.Writes {
		if !e.Writes[r] {
			e.Writes[r] = true
			changed = true
		}
	}
	for x := range other.Throws {
		if !e.Throws[x] {
			e.Throws[x] = true
			changed = true
		}
	}
	return changed
}

// Equal reports whether both sets contain exactly the same effects.
func (e *EffectSet) Equal(other *EffectSet) bool {
	return sameKeys(e.Reads, other.Reads) &&
		sameKeys(e.Writes, other.Writes) &&
		sameKeys(e.Throws, other.Throws)
}

func sameKeys(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// Subst returns a copy with regions renamed through m; unmapped regions
// (e.g. globals) are kept as-is. Exceptions are never renamed.
func (e *EffectSet) Subst(m map[string]string) *EffectSet {
	out := NewEffectSet()
	for r := range e.Reads {
		if v, ok := m[r]; ok {
			out.Reads[v] = true
		} else {
			out.Reads[r] = true
		}
	}
	for r := range e.Writes {
		if v, ok := m[r]; ok {
			out.Writes[v] = true
		} else {
			out.Writes[r] = true
		}
	}
	for x := range e.Throws {
		out.Throws[x] = true
	}
	return out
}

// Mask drops function-local regions from the read/write sets; effects on
// locals are not observable by callers.
func (e *EffectSet) Mask(locals map[string]bool) {
	for r := range locals {
		delete(e.Reads, r)
		delete(e.Writes, r)
	}
}

func (e *EffectSet) String() string {
	return fmt.Sprintf("reads{%s} writes{%s} throws{%s}",
		strings.Join(sortedKeys(e.Reads), ", "),
		strings.Join(sortedKeys(e.Writes), ", "),
		strings.Join(sortedKeys(e.Throws), ", "))
}

func sortedKeys(m map[string]bool) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
