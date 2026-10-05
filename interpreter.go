package backupverify

import "fmt"

// Edge reasons reported by Verify.
const (
	ReasonMissingParent   = "missing-parent"
	ReasonVersionConflict = "version-conflict"
	ReasonMissingChunk    = "missing-chunk"
	ReasonUnknownOp       = "unknown-op"
)

// Edge identifies the earliest point at which a backup chain becomes
// invalid. Position 0 is the manifest; position i (1-based) is the i-th
// package in chain order.
type Edge struct {
	Position int    `json:"position"`
	Package  string `json:"package"` // digest of the failing unit, "manifest" for position 0
	Reason   string `json:"reason"`
	Detail   string `json:"detail"`
}

func (e Edge) Error() string {
	return fmt.Sprintf("position %d (%s): %s: %s", e.Position, e.Package, e.Reason, e.Detail)
}

// Result is the outcome of verifying a chain. Verification is
// all-or-nothing: when Edge is set, State is nil and no partial restore is
// possible.
type Result struct {
	Edge        *Edge
	State       map[string]ObjectVersion // keyed by "id@version", nil on failure
	StateDigest string                   // empty on failure
}

// OK reports whether the whole chain verified.
func (r Result) OK() bool { return r.Edge == nil }

type versionKey struct {
	id      string
	version int
}

func keyOf(id string, version int) versionKey { return versionKey{id, version} }

func stateKey(k versionKey) string { return fmt.Sprintf("%s@%d", k.id, k.version) }

// Verify runs the serial manifest interpreter: it loads the full manifest,
// then applies each incremental package in the given order, checking the
// parent link, per-version delete/replace semantics and chunk availability.
// On the first failure it returns the earliest invalid edge and no state.
func Verify(m *Manifest, pkgs []*Package, chunks ChunkStore) Result {
	state := map[versionKey]ObjectVersion{}
	for _, ov := range m.Objects {
		k := keyOf(ov.ID, ov.Version)
		if prev, dup := state[k]; dup && !sameContent(prev, ov) {
			return fail(Edge{0, "manifest", ReasonVersionConflict,
				fmt.Sprintf("object %s version %d defined twice with different content", ov.ID, ov.Version)})
		}
		state[k] = ov
	}
	if edge := checkChunks(m.Objects, 0, "manifest", chunks); edge != nil {
		return fail(*edge)
	}

	head := m.Digest()
	for i, p := range pkgs {
		pos := i + 1
		if p.Parent != head {
			return fail(Edge{pos, p.Digest(), ReasonMissingParent,
				fmt.Sprintf("parent %q does not match head %q", p.Parent, head)})
		}
		for _, op := range p.Ops {
			k := keyOf(op.ID, op.Version)
			switch op.Kind {
			case "put":
				next := ObjectVersion{ID: op.ID, Version: op.Version, Chunks: op.Chunks}
				if prev, ok := state[k]; ok {
					if !sameContent(prev, next) {
						return fail(Edge{pos, p.Digest(), ReasonVersionConflict,
							fmt.Sprintf("object %s version %d redefined with different content", op.ID, op.Version)})
					}
					continue // idempotent replay
				}
				if edge := checkChunks([]ObjectVersion{next}, pos, p.Digest(), chunks); edge != nil {
					return fail(*edge)
				}
				state[k] = next
			case "delete":
				next := ObjectVersion{ID: op.ID, Version: op.Version, Deleted: true}
				if prev, ok := state[k]; ok {
					if prev.Deleted {
						continue // idempotent replay
					}
					state[k] = next
					continue
				}
				state[k] = next
			default:
				return fail(Edge{pos, p.Digest(), ReasonUnknownOp,
					fmt.Sprintf("unknown op kind %q", op.Kind)})
			}
		}
		head = p.Digest()
	}

	flat := map[string]ObjectVersion{}
	objs := make([]ObjectVersion, 0, len(state))
	for k, ov := range state {
		flat[stateKey(k)] = ov
		objs = append(objs, ov)
	}
	sortObjectVersions(objs)
	return Result{State: flat, StateDigest: digestOf(map[string]any{"type": "state", "objects": objs})}
}

func checkChunks(objs []ObjectVersion, pos int, unit string, chunks ChunkStore) *Edge {
	for _, ov := range objs {
		if ov.Deleted {
			continue
		}
		for _, ref := range ov.Chunks {
			if !chunks.Has(ref) {
				return &Edge{pos, unit, ReasonMissingChunk,
					fmt.Sprintf("object %s version %d references missing chunk %s", ov.ID, ov.Version, ref)}
			}
		}
	}
	return nil
}

func fail(e Edge) Result { return Result{Edge: &e} }
