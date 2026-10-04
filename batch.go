package intervalx

// OpKind selects the mutation performed by an Op.
type OpKind int

const (
	// OpAdd inserts Interval for Source. Zero-length intervals are ignored.
	OpAdd OpKind = iota
	// OpRemove deletes one interval exactly matching Source and Interval.
	OpRemove
	// OpDeleteSource withdraws every interval owned by Source.
	OpDeleteSource
)

// Op is a single mutation inside a batch.
type Op struct {
	Kind     OpKind
	Source   SourceID
	Interval Interval
}

// Patch is an inverse patch: applying it to the version produced by Apply
// restores the version Apply started from. Its ops are already ordered for
// replay (reverse of the forward ops).
type Patch struct {
	ops []Op
}

// Ops returns the inverse ops in replay order.
func (p Patch) Ops() []Op {
	out := make([]Op, len(p.ops))
	copy(out, p.ops)
	return out
}

// Apply applies a batch of ops atomically, returning the new Version and
// the inverse Patch that undoes exactly the effective changes (no-ops such
// as zero-length adds or unmatched removes leave no trace in the patch).
func (v *Version) Apply(ops []Op) (*Version, Patch) {
	nv := v.clone()
	var inverse []Op
	for _, op := range ops {
		switch op.Kind {
		case OpAdd:
			iv := op.Interval
			if iv.Lo >= iv.Hi {
				continue
			}
			nv.bySrc[op.Source] = append(nv.bySrc[op.Source], iv)
			inverse = append(inverse, Op{Kind: OpRemove, Source: op.Source, Interval: iv})
		case OpRemove:
			ivs := nv.bySrc[op.Source]
			for i, iv := range ivs {
				if iv == op.Interval {
					nv.bySrc[op.Source] = append(ivs[:i], ivs[i+1:]...)
					if len(nv.bySrc[op.Source]) == 0 {
						delete(nv.bySrc, op.Source)
					}
					inverse = append(inverse, Op{Kind: OpAdd, Source: op.Source, Interval: iv})
					break
				}
			}
		case OpDeleteSource:
			ivs, ok := nv.bySrc[op.Source]
			if !ok {
				continue
			}
			delete(nv.bySrc, op.Source)
			for _, iv := range ivs {
				inverse = append(inverse, Op{Kind: OpAdd, Source: op.Source, Interval: iv})
			}
		}
	}
	// Reverse so replay undoes the last forward op first.
	for i, j := 0, len(inverse)-1; i < j; i, j = i+1, j-1 {
		inverse[i], inverse[j] = inverse[j], inverse[i]
	}
	return nv, Patch{ops: inverse}
}

// Revert replays an inverse patch, returning the restored Version.
func (v *Version) Revert(p Patch) *Version {
	nv, _ := v.Apply(p.ops)
	return nv
}
