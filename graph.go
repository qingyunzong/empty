package main

import (
	"sort"
)

// Conflict records two segments claiming the same digest with different content.
type Conflict struct {
	Digest   string
	Kept     Segment
	Rejected Segment
}

// Graph indexes segments by digest. Because the digest is a content address,
// distinct successors of the same parent get distinct digests and coexist as
// branches; only byte-identical segments count as duplicates.
type Graph struct {
	segments   map[string]*Segment
	children   map[string][]string
	Duplicates int
	Conflicts  []Conflict
}

func NewGraph() *Graph {
	return &Graph{
		segments: make(map[string]*Segment),
		children: make(map[string][]string),
	}
}

// Add inserts a segment, computing its digest when absent. Exact duplicates
// are counted and ignored; digest collisions with different content are
// recorded as conflicts and rejected.
func (g *Graph) Add(seg Segment) {
	if seg.Digest == "" {
		seg.Digest = ComputeDigest(seg.Prev, seg.Payload)
	}
	if existing, ok := g.segments[seg.Digest]; ok {
		if existing.Prev == seg.Prev && existing.Payload == seg.Payload {
			g.Duplicates++
		} else {
			g.Conflicts = append(g.Conflicts, Conflict{Digest: seg.Digest, Kept: *existing, Rejected: seg})
		}
		return
	}
	s := seg
	g.segments[s.Digest] = &s
	g.children[s.Prev] = append(g.children[s.Prev], s.Digest)
}

// Children returns the digests of all direct successors of a digest.
func (g *Graph) Children(digest string) []string {
	return g.children[digest]
}

// Get returns the segment stored under a digest.
func (g *Graph) Get(digest string) (*Segment, bool) {
	s, ok := g.segments[digest]
	return s, ok
}

// Len returns the number of distinct segments stored.
func (g *Graph) Len() int { return len(g.segments) }

// Heads returns digests that no other segment points to as a parent.
func (g *Graph) Heads() []string {
	var heads []string
	for digest := range g.segments {
		if len(g.children[digest]) == 0 {
			heads = append(heads, digest)
		}
	}
	sort.Strings(heads)
	return heads
}

// PathStatus classifies the outcome of a path query.
type PathStatus int

const (
	PathOK PathStatus = iota
	PathMissingAncestor
	PathCycle
)

// PathResult is the outcome of walking from a head back toward genesis.
type PathResult struct {
	Status  PathStatus
	Path    []*Segment // head first, deepest ancestor last
	Missing string     // digest of the absent ancestor, when Status is PathMissingAncestor
	CycleAt string     // digest where the walk loops, when Status is PathCycle
}

// Path walks Prev pointers from head to genesis. A reference to a digest that
// is not in the graph is reported as a missing ancestor; revisiting a digest
// is reported as a cycle. The two are never conflated.
func (g *Graph) Path(head string) PathResult {
	seen := make(map[string]bool)
	var path []*Segment
	cur := head
	for cur != "" {
		if seen[cur] {
			return PathResult{Status: PathCycle, Path: path, CycleAt: cur}
		}
		seen[cur] = true
		seg, ok := g.segments[cur]
		if !ok {
			return PathResult{Status: PathMissingAncestor, Path: path, Missing: cur}
		}
		path = append(path, seg)
		cur = seg.Prev
	}
	return PathResult{Status: PathOK, Path: path}
}

// Corruption identifies a segment whose stored digest does not match its content.
type Corruption struct {
	Digest     string // claimed digest (the segment's identity in the graph)
	Recomputed string // digest recomputed from Prev and Payload
	Line       int    // source line, 0 when unknown
	Payload    string
}

// VerifyResult summarizes a full-graph check.
type VerifyResult struct {
	Total       int
	Duplicates  int
	Conflicts   []Conflict
	Corrupted   []Corruption
	MissingRefs []string // Prev references (non-genesis) absent from the graph
}

// OK reports whether the graph is fully consistent.
func (r VerifyResult) OK() bool {
	return len(r.Corrupted) == 0 && len(r.Conflicts) == 0 && len(r.MissingRefs) == 0
}

// Verify recomputes every segment's digest and checks every parent reference,
// locating corrupted payloads to the specific segment.
func (g *Graph) Verify() VerifyResult {
	res := VerifyResult{Total: len(g.segments), Duplicates: g.Duplicates, Conflicts: g.Conflicts}
	seenMissing := make(map[string]bool)
	for digest, seg := range g.segments {
		if recomputed := ComputeDigest(seg.Prev, seg.Payload); recomputed != digest {
			res.Corrupted = append(res.Corrupted, Corruption{
				Digest:     digest,
				Recomputed: recomputed,
				Line:       seg.Line,
				Payload:    seg.Payload,
			})
		}
		if seg.Prev != "" {
			if _, ok := g.segments[seg.Prev]; !ok && !seenMissing[seg.Prev] {
				seenMissing[seg.Prev] = true
				res.MissingRefs = append(res.MissingRefs, seg.Prev)
			}
		}
	}
	sort.Slice(res.Corrupted, func(i, j int) bool { return res.Corrupted[i].Digest < res.Corrupted[j].Digest })
	sort.Strings(res.MissingRefs)
	return res
}
