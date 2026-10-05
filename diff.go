package dirdiff

import (
	"fmt"
	"sort"
	"strings"
)

// OpKind identifies the kind of a plan operation.
type OpKind int

const (
	OpCreate OpKind = iota
	OpDelete
	OpMove
)

func (k OpKind) String() string {
	switch k {
	case OpCreate:
		return "create"
	case OpDelete:
		return "delete"
	case OpMove:
		return "move"
	}
	return "unknown"
}

// Op is a single executable step. From is set for deletes and moves, To is
// set for creates and moves.
type Op struct {
	Kind OpKind
	ID   string
	From string
	To   string
}

func (op Op) String() string {
	switch op.Kind {
	case OpCreate:
		return fmt.Sprintf("create %s @ %s", op.ID, op.To)
	case OpDelete:
		return fmt.Sprintf("delete %s @ %s", op.ID, op.From)
	default:
		return fmt.Sprintf("move %s %s -> %s", op.ID, op.From, op.To)
	}
}

// Plan is a dependency-ordered list of operations that transforms the
// manifest with version FromVersion into the manifest with version
// ToVersion.
type Plan struct {
	Ops         []Op
	FromVersion uint64
	ToVersion   uint64
}

// tempPrefix marks scratch paths used to break move cycles. Temp paths are
// always chosen outside the source and target path sets, so they never
// occupy a final name.
const tempPrefix = ".dirdiff-tmp-"

func depth(p string) int { return strings.Count(p, "/") }

// Diff computes the plan transforming oldM into newM. Entries present in
// both manifests with different paths become moves; entries only in oldM
// become deletes; entries only in newM become creates. Operations are
// ordered so that every step is executable: deletes are emitted deepest
// first, creates shallowest first, and moves are topologically ordered by
// path occupancy, with cycles broken by moves through temp paths that never
// collide with any source or final name.
func Diff(oldM, newM Manifest) Plan {
	var deletes, moves, creates []Op
	for _, id := range oldM.ids {
		if _, ok := newM.byID[id]; !ok {
			deletes = append(deletes, Op{Kind: OpDelete, ID: id, From: oldM.byID[id]})
		}
	}
	for _, id := range newM.ids {
		oldPath, ok := oldM.byID[id]
		switch {
		case !ok:
			creates = append(creates, Op{Kind: OpCreate, ID: id, To: newM.byID[id]})
		case oldPath != newM.byID[id]:
			moves = append(moves, Op{Kind: OpMove, ID: id, From: oldPath, To: newM.byID[id]})
		}
	}
	sort.Slice(deletes, func(i, j int) bool {
		if di, dj := depth(deletes[i].From), depth(deletes[j].From); di != dj {
			return di > dj // children before parents
		}
		return deletes[i].From < deletes[j].From
	})
	sort.Slice(moves, func(i, j int) bool { return moves[i].From < moves[j].From })
	sort.Slice(creates, func(i, j int) bool {
		if di, dj := depth(creates[i].To), depth(creates[j].To); di != dj {
			return di < dj // parents before children
		}
		return creates[i].To < creates[j].To
	})

	pending := make([]Op, 0, len(deletes)+len(moves)+len(creates))
	pending = append(pending, deletes...)
	pending = append(pending, moves...)
	pending = append(pending, creates...)

	occupied := make(map[string]bool, oldM.Len())
	forbidden := make(map[string]bool, oldM.Len()+newM.Len())
	for _, id := range oldM.ids {
		occupied[oldM.byID[id]] = true
		forbidden[oldM.byID[id]] = true
	}
	for _, id := range newM.ids {
		forbidden[newM.byID[id]] = true
	}

	var ops []Op
	temps := 0
	for len(pending) > 0 {
		idx := -1
		for i := range pending {
			if satisfiable(pending[i], occupied) {
				idx = i
				break
			}
		}
		if idx >= 0 {
			op := pending[idx]
			pending = append(pending[:idx], pending[idx+1:]...)
			ops = append(ops, op)
			applyOccupancy(op, occupied)
			continue
		}
		// No op is executable: the remaining moves form an occupancy cycle.
		// Relocate the first pending move's source to a temp path that is
		// neither a source nor a final name, breaking the cycle.
		mi := -1
		for i := range pending {
			if pending[i].Kind == OpMove {
				mi = i
				break
			}
		}
		if mi < 0 {
			panic("dirdiff: unsatisfiable plan with no pending move")
		}
		var tmp string
		for {
			tmp = fmt.Sprintf("%s%d", tempPrefix, temps)
			temps++
			if !forbidden[tmp] {
				break
			}
		}
		forbidden[tmp] = true
		op := pending[mi]
		ops = append(ops, Op{Kind: OpMove, ID: op.ID, From: op.From, To: tmp})
		delete(occupied, op.From)
		occupied[tmp] = true
		pending[mi].From = tmp
	}
	return Plan{Ops: ops, FromVersion: oldM.Version(), ToVersion: newM.Version()}
}

func satisfiable(op Op, occupied map[string]bool) bool {
	switch op.Kind {
	case OpDelete:
		return occupied[op.From]
	case OpCreate:
		return !occupied[op.To]
	default: // OpMove
		return occupied[op.From] && !occupied[op.To]
	}
}

func applyOccupancy(op Op, occupied map[string]bool) {
	switch op.Kind {
	case OpDelete:
		delete(occupied, op.From)
	case OpCreate:
		occupied[op.To] = true
	default: // OpMove
		delete(occupied, op.From)
		occupied[op.To] = true
	}
}

// Inverse returns the reverse plan: operations inverted and in reverse
// order, with versions swapped. Applying it to the diff's target manifest
// restores the source manifest. Because Inverse records the forward target
// version as its own FromVersion, Apply refuses to run unless the current
// manifest is exactly the forward diff's result.
func (p Plan) Inverse() Plan {
	inv := Plan{FromVersion: p.ToVersion, ToVersion: p.FromVersion}
	for i := len(p.Ops) - 1; i >= 0; i-- {
		op := p.Ops[i]
		switch op.Kind {
		case OpCreate:
			inv.Ops = append(inv.Ops, Op{Kind: OpDelete, ID: op.ID, From: op.To})
		case OpDelete:
			inv.Ops = append(inv.Ops, Op{Kind: OpCreate, ID: op.ID, To: op.From})
		default: // OpMove
			inv.Ops = append(inv.Ops, Op{Kind: OpMove, ID: op.ID, From: op.To, To: op.From})
		}
	}
	return inv
}

// Apply verifies that m matches the plan's source version, executes every
// operation checking its preconditions, and verifies that the result matches
// the plan's target version.
func (p Plan) Apply(m Manifest) (Manifest, error) {
	if m.Version() != p.FromVersion {
		return Manifest{}, fmt.Errorf("dirdiff: version mismatch: plan source is %016x, manifest is %016x",
			p.FromVersion, m.Version())
	}
	byID := make(map[string]string, m.Len())
	byPath := make(map[string]string, m.Len())
	for _, e := range m.Entries() {
		byID[e.ID] = e.Path
		byPath[e.Path] = e.ID
	}
	for i, op := range p.Ops {
		switch op.Kind {
		case OpCreate:
			if _, ok := byPath[op.To]; ok {
				return Manifest{}, fmt.Errorf("dirdiff: op %d (%s): path %q is occupied", i, op, op.To)
			}
			byID[op.ID] = op.To
			byPath[op.To] = op.ID
		case OpDelete:
			if cur, ok := byID[op.ID]; !ok || cur != op.From {
				return Manifest{}, fmt.Errorf("dirdiff: op %d (%s): entry not at %q", i, op, op.From)
			}
			delete(byID, op.ID)
			delete(byPath, op.From)
		default: // OpMove
			if cur, ok := byID[op.ID]; !ok || cur != op.From {
				return Manifest{}, fmt.Errorf("dirdiff: op %d (%s): entry not at %q", i, op, op.From)
			}
			if _, ok := byPath[op.To]; ok {
				return Manifest{}, fmt.Errorf("dirdiff: op %d (%s): path %q is occupied", i, op, op.To)
			}
			delete(byPath, op.From)
			byID[op.ID] = op.To
			byPath[op.To] = op.ID
		}
	}
	entries := make([]Entry, 0, len(byID))
	for id, path := range byID {
		entries = append(entries, Entry{ID: id, Path: path})
	}
	res, err := NewManifest(entries)
	if err != nil {
		return Manifest{}, err
	}
	if res.Version() != p.ToVersion {
		return Manifest{}, fmt.Errorf("dirdiff: plan reached %016x, target is %016x", res.Version(), p.ToVersion)
	}
	return res, nil
}
