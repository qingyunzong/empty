package trafficsim

import "sort"

// ConflictTable is the public mutual-exclusion table for intersections.
// Two movements at the same node conflict (may not both be granted in the
// same tick) unless explicitly allowed with Allow. Movements default to
// conflicting, which is the conservative choice.
type ConflictTable struct {
	allowed map[NodeID]map[Movement]map[Movement]bool
}

func NewConflictTable() *ConflictTable {
	return &ConflictTable{allowed: make(map[NodeID]map[Movement]map[Movement]bool)}
}

// Allow marks movements a and b at node as compatible: both may be
// granted in the same tick. The relation is symmetric.
func (t *ConflictTable) Allow(node NodeID, a, b Movement) {
	if t.allowed[node] == nil {
		t.allowed[node] = make(map[Movement]map[Movement]bool)
	}
	if t.allowed[node][a] == nil {
		t.allowed[node][a] = make(map[Movement]bool)
	}
	if t.allowed[node][b] == nil {
		t.allowed[node][b] = make(map[Movement]bool)
	}
	t.allowed[node][a][b] = true
	t.allowed[node][b][a] = true
}

// Forbid removes a previous Allow, restoring mutual exclusion.
func (t *ConflictTable) Forbid(node NodeID, a, b Movement) {
	delete(t.allowed[node][a], b)
	delete(t.allowed[node][b], a)
}

// Conflicts reports whether movements a and b are mutually exclusive at
// node. A movement always conflicts with itself; anything not explicitly
// allowed conflicts by default.
func (t *ConflictTable) Conflicts(node NodeID, a, b Movement) bool {
	if a == b {
		return true
	}
	if t == nil {
		return true
	}
	return !t.allowed[node][a][b]
}

// allowEntry is a flattened, sorted record used for snapshots.
type allowEntry struct {
	Node NodeID
	A, B Movement
}

func (t *ConflictTable) entries() []allowEntry {
	var out []allowEntry
	for node, moves := range t.allowed {
		for a, bs := range moves {
			for b := range bs {
				if movementLess(a, b) {
					out = append(out, allowEntry{Node: node, A: a, B: b})
				}
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Node != out[j].Node {
			return out[i].Node < out[j].Node
		}
		if out[i].A != out[j].A {
			return movementLess(out[i].A, out[j].A)
		}
		return movementLess(out[i].B, out[j].B)
	})
	return out
}

func movementLess(a, b Movement) bool {
	if a.From != b.From {
		return a.From < b.From
	}
	return a.To < b.To
}
