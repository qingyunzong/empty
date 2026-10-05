package permset

import (
	"fmt"
	"math"
	"slices"
	"strings"
)

// Segment is one disjoint result interval together with the sorted set of
// source expressions (interval literals or definition names) that
// contributed to it: its provenance witness.
type Segment struct {
	Lo, Hi  int64
	Sources []string
}

func (s Segment) String() string {
	return fmt.Sprintf("%s <- {%s}", Interval{s.Lo, s.Hi}, strings.Join(s.Sources, ", "))
}

// WSet is a witnessed set: disjoint, sorted segments, each annotated with
// the sources that produced it. Adjacent segments are merged when (and
// only when) their witness sets are identical.
type WSet struct {
	segs []Segment
}

// Segments returns a copy of the witnessed segments.
func (w WSet) Segments() []Segment { return slices.Clone(w.segs) }

// Set drops the witnesses and returns the canonical plain set, merging
// adjacent segments regardless of provenance.
func (w WSet) Set() Set {
	ivs := make([]Interval, len(w.segs))
	for i, s := range w.segs {
		ivs[i] = Interval{s.Lo, s.Hi}
	}
	return Norm(ivs)
}

func (w WSet) String() string {
	if len(w.segs) == 0 {
		return "{}"
	}
	parts := make([]string, len(w.segs))
	for i, s := range w.segs {
		parts[i] = s.String()
	}
	return "{" + strings.Join(parts, ", ") + "}"
}

// canonSegs canonicalizes raw (possibly overlapping) witnessed segments
// into disjoint sorted segments via a boundary sweep. Split points are
// segment lows and hi+1 values; hi+1 is only taken when hi < MaxInt64,
// and pts[i+1]-1 is safe because points are strictly increasing from a
// minimum of math.MinInt64.
func canonSegs(raw []Segment) []Segment {
	if len(raw) == 0 {
		return nil
	}
	pts := make([]int64, 0, 2*len(raw))
	for _, s := range raw {
		pts = append(pts, s.Lo)
		if s.Hi < math.MaxInt64 {
			pts = append(pts, s.Hi+1)
		}
	}
	slices.Sort(pts)
	pts = slices.Compact(pts)
	var out []Segment
	for i, p := range pts {
		hi := int64(math.MaxInt64)
		if i+1 < len(pts) {
			hi = pts[i+1] - 1
		}
		var labels []string
		for _, s := range raw {
			if s.Lo <= p && p <= s.Hi {
				labels = mergeLabels(labels, s.Sources)
			}
		}
		if len(labels) == 0 {
			continue
		}
		if n := len(out); n > 0 && out[n-1].Hi == p-1 && slices.Equal(out[n-1].Sources, labels) {
			out[n-1].Hi = hi
			continue
		}
		out = append(out, Segment{Lo: p, Hi: hi, Sources: labels})
	}
	return out
}

// mergeLabels returns the sorted union of two sorted label slices.
func mergeLabels(a, b []string) []string {
	out := a
	for _, s := range b {
		i, ok := slices.BinarySearch(out, s)
		if !ok {
			out = slices.Insert(out, i, s)
		}
	}
	return out
}

// Union combines two witnessed sets; witnesses of overlapping regions are
// merged.
func (w WSet) Union(o WSet) WSet {
	raw := make([]Segment, 0, len(w.segs)+len(o.segs))
	raw = append(raw, w.segs...)
	raw = append(raw, o.segs...)
	return WSet{segs: canonSegs(raw)}
}

// Intersect keeps only regions covered by both sides; the witness of an
// overlapping region is the union of both sides' witnesses.
func (w WSet) Intersect(o WSet) WSet {
	var raw []Segment
	for _, a := range w.segs {
		for _, b := range o.segs {
			lo := max(a.Lo, b.Lo)
			hi := min(a.Hi, b.Hi)
			if lo <= hi {
				raw = append(raw, Segment{Lo: lo, Hi: hi, Sources: mergeLabels(a.Sources, b.Sources)})
			}
		}
	}
	return WSet{segs: canonSegs(raw)}
}

// Diff removes o from w; surviving pieces keep w's witnesses. Endpoint
// handling at math.MaxInt64 / math.MinInt64 is delegated to Set.Diff,
// which guards the hi+1 / lo-1 arithmetic.
func (w WSet) Diff(o WSet) WSet {
	ob := o.Set()
	var raw []Segment
	for _, a := range w.segs {
		pieces := Set{ivs: []Interval{{a.Lo, a.Hi}}}.Diff(ob)
		for _, p := range pieces.ivs {
			raw = append(raw, Segment{Lo: p.Lo, Hi: p.Hi, Sources: a.Sources})
		}
	}
	return WSet{segs: canonSegs(raw)}
}

// evalNode evaluates an AST, resolving names through resolve.
func evalNode(n node, resolve func(string) (WSet, error)) (WSet, error) {
	switch n := n.(type) {
	case litNode:
		return WSet{segs: []Segment{{Lo: n.lo, Hi: n.hi, Sources: []string{n.text}}}}, nil
	case nameNode:
		return resolve(n.name)
	case binNode:
		l, err := evalNode(n.l, resolve)
		if err != nil {
			return WSet{}, err
		}
		r, err := evalNode(n.r, resolve)
		if err != nil {
			return WSet{}, err
		}
		switch n.op {
		case '|':
			return l.Union(r), nil
		case '&':
			return l.Intersect(r), nil
		case '-':
			return l.Diff(r), nil
		}
	}
	return WSet{}, fmt.Errorf("permset: unknown AST node %T", n)
}

// UndefinedError reports a reference to a name with no definition.
type UndefinedError struct{ Name string }

func (e *UndefinedError) Error() string {
	return fmt.Sprintf("undefined set %q", e.Name)
}

// Eval parses and evaluates a standalone expression without named
// references and returns the canonical result set.
func Eval(src string) (Set, error) {
	n, refs, err := parse(src)
	if err != nil {
		return Set{}, err
	}
	if len(refs) > 0 {
		return Set{}, &UndefinedError{Name: refs[0]}
	}
	w, err := evalNode(n, func(name string) (WSet, error) {
		return WSet{}, &UndefinedError{Name: name}
	})
	if err != nil {
		return Set{}, err
	}
	return w.Set(), nil
}
