package sigdb

import (
	"encoding/binary"
	"fmt"
	"math/big"
	"sort"
)

// Kind describes what an entry at a timestamp represents.
type Kind byte

const (
	// KindPresent is a real sample with a value.
	KindPresent Kind = iota
	// KindMissing is an explicit missing-value marker: it cuts the
	// piecewise-linear signal, no segment crosses it.
	KindMissing
	// KindTombstone is a deletion record. It keeps the version so that
	// older re-writes stay rejected, and it also cuts the signal.
	KindTombstone
)

// Op is a single mutation addressed by timestamp. Within one timestamp the op
// with the highest version wins; lower or equal versions are discarded.
type Op struct {
	T       int64
	Version uint64
	Kind    Kind
	V       *big.Rat // only for KindPresent
}

// Put returns an upsert op for a present sample.
func toPut(t int64, version uint64, v *big.Rat) Op {
	return Op{T: t, Version: version, Kind: KindPresent, V: new(big.Rat).Set(v)}
}

// Missing returns an op that records an explicit missing value.
func Missing(t int64, version uint64) Op {
	return Op{T: t, Version: version, Kind: KindMissing}
}

// Delete returns an op that removes the sample at t (tombstone).
func Delete(t int64, version uint64) Op {
	return Op{T: t, Version: version, Kind: KindTombstone}
}

// entry is the resolved state for one timestamp.
type entry struct {
	t       int64
	version uint64
	kind    Kind
	v       *big.Rat // non-nil iff kind == KindPresent
}

// applyOps folds a batch of ops into the sorted entry slice and returns the
// new slice plus the timestamps whose effective entry actually changed.
// entries must be sorted by t and contain at most one entry per t.
func applyOps(entries []entry, ops []Op) ([]entry, []int64) {
	idx := make(map[int64]int, len(entries))
	for i, e := range entries {
		idx[e.t] = i
	}
	out := make([]entry, len(entries))
	copy(out, entries)
	changedSet := make(map[int64]struct{})
	for _, op := range ops {
		if op.Kind == KindPresent && op.V == nil {
			panic("sigdb: present op with nil value")
		}
		i, ok := idx[op.T]
		if ok && op.Version <= out[i].version {
			continue // higher version wins; ties keep the incumbent
		}
		ne := entry{t: op.T, version: op.Version, kind: op.Kind}
		if op.Kind == KindPresent {
			ne.v = new(big.Rat).Set(op.V)
		}
		if ok {
			if out[i] == ne || (out[i].kind == ne.kind && out[i].version == ne.version &&
				(out[i].v == nil) == (ne.v == nil) &&
				(out[i].v == nil || out[i].v.Cmp(ne.v) == 0)) {
				continue
			}
			out[i] = ne
		} else {
			idx[op.T] = len(out)
			out = append(out, ne)
		}
		changedSet[op.T] = struct{}{}
	}
	if len(changedSet) == 0 {
		return entries, nil
	}
	sort.Slice(out, func(i, j int) bool { return out[i].t < out[j].t })
	changed := make([]int64, 0, len(changedSet))
	for t := range changedSet {
		changed = append(changed, t)
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i] < changed[j] })
	return out, changed
}

// segment is one piecewise-linear piece between two consecutive present
// entries. Its integral over [t0, t1] is the exact trapezoid.
type segment struct {
	t0, t1 int64
	v0, v1 *big.Rat
}

func (s segment) integral() *big.Rat {
	return segIntegral(s.t0, s.v0, s.t1, s.v1, s.t0, s.t1)
}

// segIntegral integrates the linear interpolation between (t0,v0) and
// (t1,v1) over [a,b] (clipped to [t0,t1]) with exact rational arithmetic.
func segIntegral(t0 int64, v0 *big.Rat, t1 int64, v1 *big.Rat, a, b int64) *big.Rat {
	if a < t0 {
		a = t0
	}
	if b > t1 {
		b = t1
	}
	if a >= b {
		return new(big.Rat)
	}
	span := big.NewRat(t1-t0, 1)
	slope := new(big.Rat).Sub(v1, v0)
	slope.Mul(slope, new(big.Rat).Inv(span))
	at := func(t int64) *big.Rat {
		d := big.NewRat(t-t0, 1)
		d.Mul(d, slope)
		return d.Add(d, v0)
	}
	va, vb := at(a), at(b)
	avg := new(big.Rat).Add(va, vb)
	avg.Mul(avg, big.NewRat(1, 2))
	return avg.Mul(avg, big.NewRat(b-a, 1))
}

// segments derives all segments from sorted entries. Missing values and
// tombstones cut the signal: only consecutive present entries form a
// segment, so interpolation never crosses a hole.
func segments(entries []entry) []segment {
	var segs []segment
	for i := 0; i+1 < len(entries); i++ {
		a, b := entries[i], entries[i+1]
		if a.kind != KindPresent || b.kind != KindPresent {
			continue
		}
		segs = append(segs, segment{t0: a.t, t1: b.t, v0: a.v, v1: b.v})
	}
	return segs
}

// segmentsInRange returns the segments whose start t0 lies in [lo, hi].
func segmentsInRange(entries []entry, lo, hi int64) []segment {
	var segs []segment
	for _, s := range segments(entries) {
		if s.t0 >= lo && s.t0 <= hi {
			segs = append(segs, s)
		}
	}
	return segs
}

// segmentDiff computes the local inverse difference produced by a batch:
// the segments that must be removed from and added to the index. Only the
// neighbourhood of changed timestamps is affected; everything else is
// guaranteed untouched.
func segmentDiff(oldEntries, newEntries []entry, changed []int64) (removed, added []segment) {
	if len(changed) == 0 {
		return nil, nil
	}
	lo, hi := changed[0], changed[len(changed)-1]
	// Extend one entry to the left: the segment bridging into the changed
	// region starts at the predecessor of the first changed timestamp.
	pred := func(entries []entry, t int64) int64 {
		p := t
		for _, e := range entries {
			if e.t < t && (p == t || e.t > p) {
				p = e.t
			}
		}
		return p
	}
	lo = pred(oldEntries, lo)
	lo = pred(newEntries, lo)
	oldSegs := segmentsInRange(oldEntries, lo, hi)
	newSegs := segmentsInRange(newEntries, lo, hi)
	type segKey = int64
	newByKey := make(map[segKey]segment, len(newSegs))
	for _, s := range newSegs {
		newByKey[s.t0] = s
	}
	oldByKey := make(map[segKey]segment, len(oldSegs))
	for _, s := range oldSegs {
		oldByKey[s.t0] = s
	}
	for _, s := range oldSegs {
		ns, ok := newByKey[s.t0]
		if !ok || ns.t1 != s.t1 || ns.v0.Cmp(s.v0) != 0 || ns.v1.Cmp(s.v1) != 0 {
			removed = append(removed, s)
		}
	}
	for _, s := range newSegs {
		os, ok := oldByKey[s.t0]
		if !ok || os.t1 != s.t1 || os.v0.Cmp(s.v0) != 0 || os.v1.Cmp(s.v1) != 0 {
			added = append(added, s)
		}
	}
	return removed, added
}

// --- encoding helpers ---

func appendRat(buf []byte, r *big.Rat) []byte {
	s := r.RatString()
	buf = binary.AppendUvarint(buf, uint64(len(s)))
	return append(buf, s...)
}

func readRat(buf []byte) (*big.Rat, []byte, error) {
	n, m := binary.Uvarint(buf)
	if m <= 0 || n > uint64(len(buf)-m) {
		return nil, nil, fmt.Errorf("sigdb: corrupt rat encoding")
	}
	r := new(big.Rat)
	end := m + int(n)
	if err := r.UnmarshalText(buf[m:end]); err != nil {
		return nil, nil, err
	}
	return r, buf[end:], nil
}

// encodeEntries serialises the sorted entry slice.
func encodeEntries(entries []entry) []byte {
	buf := binary.AppendUvarint(nil, uint64(len(entries)))
	for _, e := range entries {
		var tb [8]byte
		binary.LittleEndian.PutUint64(tb[:], uint64(e.t))
		buf = append(buf, tb[:]...)
		buf = append(buf, byte(e.kind))
		buf = binary.AppendUvarint(buf, e.version)
		if e.kind == KindPresent {
			buf = appendRat(buf, e.v)
		}
	}
	return buf
}

func decodeEntries(buf []byte) ([]entry, error) {
	n, m := binary.Uvarint(buf)
	if m <= 0 {
		return nil, fmt.Errorf("sigdb: corrupt entries encoding")
	}
	buf = buf[m:]
	entries := make([]entry, 0, n)
	for i := uint64(0); i < n; i++ {
		if len(buf) < 9 {
			return nil, fmt.Errorf("sigdb: corrupt entries encoding")
		}
		e := entry{t: int64(binary.LittleEndian.Uint64(buf))}
		buf = buf[8:]
		e.kind = Kind(buf[0])
		buf = buf[1:]
		v, m := binary.Uvarint(buf)
		if m <= 0 {
			return nil, fmt.Errorf("sigdb: corrupt entries encoding")
		}
		e.version = v
		buf = buf[m:]
		if e.kind == KindPresent {
			r, rest, err := readRat(buf)
			if err != nil {
				return nil, err
			}
			e.v = r
			buf = rest
		}
		entries = append(entries, e)
	}
	return entries, nil
}
