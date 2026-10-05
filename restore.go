package main

import "fmt"

// Kind classifies an invalidation edge.
type Kind string

const (
	KindMissingParent   Kind = "missing-parent"   // 缺父包
	KindVersionConflict Kind = "version-conflict" // 重复版本不同内容
	KindMissingBlocks   Kind = "missing-blocks"   // 块缺失
	KindFork            Kind = "fork"             // 同一父摘要对应多个包
)

// Invalidation describes the earliest edge at which a restore becomes invalid.
type Invalidation struct {
	Edge int  // chain position (0-based) of the failing package
	Op   int  // op index inside the package, -1 for package-level failures
	Kind Kind // failure class
	Msg  string
}

func (e *Invalidation) Error() string {
	where := fmt.Sprintf("edge %d", e.Edge)
	if e.Op >= 0 {
		where = fmt.Sprintf("edge %d op %d", e.Edge, e.Op)
	}
	return fmt.Sprintf("%s: %s: %s", where, e.Kind, e.Msg)
}

// applyPackage applies one package's ops to state. Shared by both the
// chain-resolving restore and the serial reference interpreter.
func applyPackage(state *State, pkg *Package, edge int) error {
	for i, op := range pkg.Ops {
		switch op.Op {
		case "put":
			cur, ok := state.Objects[op.Object]
			if ok && cur.Version == op.Version {
				if !equalBlocks(cur.Blocks, op.Blocks) {
					return &Invalidation{Edge: edge, Op: i, Kind: KindVersionConflict,
						Msg: fmt.Sprintf("object %q version %d already exists with different content", op.Object, op.Version)}
				}
				continue // idempotent re-put
			}
			if ok && cur.Version > op.Version {
				continue // stale version, ignore
			}
			var missing []string
			for _, b := range op.Blocks {
				if _, ok := state.Blocks[b]; ok {
					continue
				}
				if _, ok := pkg.Blocks[b]; ok {
					continue
				}
				missing = append(missing, b)
			}
			if len(missing) > 0 {
				return &Invalidation{Edge: edge, Op: i, Kind: KindMissingBlocks,
					Msg: fmt.Sprintf("object %q version %d references missing blocks %v", op.Object, op.Version, missing)}
			}
			state.Objects[op.Object] = Object{Version: op.Version, Blocks: append([]string(nil), op.Blocks...)}
		case "delete":
			delete(state.Objects, op.Object)
		default:
			return &Invalidation{Edge: edge, Op: i, Kind: "unknown-op",
				Msg: fmt.Sprintf("unsupported op %q", op.Op)}
		}
	}
	for k, v := range pkg.Blocks {
		state.Blocks[k] = v
	}
	return nil
}

// Restore resolves an unordered set of incremental packages into a chain by
// matching parent digests, then applies them. On any failure it returns a nil
// state: a restore is all-or-nothing, never partial.
func Restore(m *Manifest, pkgs []*Package) (*State, string, error) {
	state := stateFromManifest(m)
	remaining := append([]*Package(nil), pkgs...)
	digest := Digest(state)
	for edge := 0; len(remaining) > 0; edge++ {
		match := -1
		for i, p := range remaining {
			if p.Parent == digest {
				if match >= 0 {
					return nil, "", &Invalidation{Edge: edge, Op: -1, Kind: KindFork,
						Msg: fmt.Sprintf("multiple packages claim parent digest %s", short(digest))}
				}
				match = i
			}
		}
		if match < 0 {
			return nil, "", &Invalidation{Edge: edge, Op: -1, Kind: KindMissingParent,
				Msg: fmt.Sprintf("no package continues state %s (%d package(s) left unapplied)", short(digest), len(remaining))}
		}
		pkg := remaining[match]
		remaining = append(remaining[:match], remaining[match+1:]...)
		if err := applyPackage(state, pkg, edge); err != nil {
			return nil, "", err
		}
		digest = Digest(state)
	}
	return state, digest, nil
}

// RestoreSerial is the serial manifest interpreter (串行清单解释器): it applies
// packages strictly in the given order, verifying the parent link at each step.
// It serves as the reference implementation for Restore.
func RestoreSerial(m *Manifest, ordered []*Package) (*State, string, error) {
	state := stateFromManifest(m)
	digest := Digest(state)
	for edge, pkg := range ordered {
		if pkg.Parent != digest {
			return nil, "", &Invalidation{Edge: edge, Op: -1, Kind: KindMissingParent,
				Msg: fmt.Sprintf("package %d expects parent %s but state is %s", edge, short(pkg.Parent), short(digest))}
		}
		if err := applyPackage(state, pkg, edge); err != nil {
			return nil, "", err
		}
		digest = Digest(state)
	}
	return state, digest, nil
}

func short(d string) string {
	if len(d) > 12 {
		return d[:12]
	}
	return d
}
