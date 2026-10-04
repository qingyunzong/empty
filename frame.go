// Package frameidx implements a frame index for coded video streams.
//
// Every frame explicitly records its reference frame IDs, its decode time
// (DTS) and its display time (PTS). Seek computes the minimal dependency
// closure required to decode a target display interval, reports missing
// references and dependency cycles, and emits a topological certificate
// for the decode order. Display time is never used as decode order.
package frameidx

import "sort"

// Frame is one coded picture in the index.
type Frame struct {
	ID   int64   // unique frame identifier
	Refs []int64 // IDs of frames that must be decoded before this one
	DTS  int64   // decode timestamp
	PTS  int64   // display timestamp
}

// MissingRef records a reference from Frame to a Ref ID absent from the index.
type MissingRef struct {
	Frame int64
	Ref   int64
}

// ValidationReport summarizes structural problems found in an Index.
type ValidationReport struct {
	Duplicates  []int64      // IDs defined more than once (first definition kept)
	MissingRefs []MissingRef // references to frames absent from the index
	Cycles      [][]int64    // each entry is a cycle path, last element repeats the first
}

// OK reports whether the index is structurally sound.
func (r *ValidationReport) OK() bool {
	return len(r.Duplicates) == 0 && len(r.MissingRefs) == 0 && len(r.Cycles) == 0
}

// Index is an immutable frame index keyed by frame ID.
type Index struct {
	frames map[int64]Frame
	order  []int64 // sorted IDs, for deterministic iteration
}

// NewIndex builds an Index from frames and validates the whole graph:
// duplicate IDs, dangling references and dependency cycles are all reported.
func NewIndex(frames []Frame) (*Index, *ValidationReport) {
	ix := &Index{frames: make(map[int64]Frame, len(frames))}
	rep := &ValidationReport{}
	for _, f := range frames {
		if _, dup := ix.frames[f.ID]; dup {
			rep.Duplicates = append(rep.Duplicates, f.ID)
			continue
		}
		ix.frames[f.ID] = f
	}
	ix.order = make([]int64, 0, len(ix.frames))
	for id := range ix.frames {
		ix.order = append(ix.order, id)
	}
	sort.Slice(ix.order, func(i, j int) bool { return ix.order[i] < ix.order[j] })
	for _, id := range ix.order {
		for _, r := range ix.frames[id].Refs {
			if _, ok := ix.frames[r]; !ok {
				rep.MissingRefs = append(rep.MissingRefs, MissingRef{Frame: id, Ref: r})
			}
		}
	}
	rep.Cycles = findCycles(ix, ix.order)
	return ix, rep
}

// Frame returns the frame with the given ID.
func (ix *Index) Frame(id int64) (Frame, bool) {
	f, ok := ix.frames[id]
	return f, ok
}

// Len returns the number of frames in the index.
func (ix *Index) Len() int { return len(ix.frames) }

// findCycles runs an iterative three-color depth-first search from the given
// seeds and returns every dependency cycle it finds. Edges point from a frame
// to its references; dangling references are not edges.
func findCycles(ix *Index, seeds []int64) [][]int64 {
	const (
		white = iota // unvisited
		gray         // on the current DFS path
		black        // fully explored
	)
	color := make(map[int64]int, len(ix.frames))
	type iter struct {
		id   int64
		next int // index into Refs
	}
	var cycles [][]int64
	for _, s := range seeds {
		if _, ok := ix.frames[s]; !ok || color[s] != white {
			continue
		}
		color[s] = gray
		stack := []iter{{id: s}}
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			f := ix.frames[top.id]
			if top.next >= len(f.Refs) {
				color[top.id] = black
				stack = stack[:len(stack)-1]
				continue
			}
			r := f.Refs[top.next]
			top.next++
			if _, ok := ix.frames[r]; !ok {
				continue
			}
			switch color[r] {
			case white:
				color[r] = gray
				stack = append(stack, iter{id: r})
			case gray:
				for i := len(stack) - 1; i >= 0; i-- {
					if stack[i].id == r {
						cyc := make([]int64, 0, len(stack)-i+1)
						for _, fr := range stack[i:] {
							cyc = append(cyc, fr.id)
						}
						cycles = append(cycles, append(cyc, r))
						break
					}
				}
			}
		}
	}
	return cycles
}
