package triejoin

import "context"

// frame holds the leapfrog intersection state for one global variable.
type frame struct {
	varIdx    int
	cursors   []TrieIterator
	exhausted bool // no further common value exists at this trie level
	resume    bool // true after a child subtree finished; must advance, not re-search
	pivot     int  // cursor whose current value is the current maximum
}

type engine struct {
	ctx         context.Context
	vars        []string
	snaps       []RelationSnapshot
	factory     CursorFactory
	iterByRI    map[int]TrieIterator
	allIters    []TrieIterator
	stack       []*frame
	bounds      []int64
	closed      bool
	done        bool
	err         error
	emptyResult bool
}

func (e *engine) buildIndexes() error {
	for ri, snap := range e.snaps {
		if len(snap.Columns) == 0 {
			continue
		}
		it, err := e.factory.NewIterator(cloneSnapshot(snap))
		if err != nil {
			return &JoinError{RelationID: snap.ID, Err: err}
		}
		e.iterByRI[ri] = it
		e.allIters = append(e.allIters, it)
	}
	return nil
}

func cloneSnapshot(s RelationSnapshot) RelationSnapshot {
	out := RelationSnapshot{ID: s.ID, Columns: append([]string(nil), s.Columns...)}
	out.Tuples = make([][]int64, len(s.Tuples))
	for i, row := range s.Tuples {
		out.Tuples[i] = append([]int64(nil), row...)
	}
	return out
}

// JoinError wraps a failure raised by an injected cursor adapter.
type JoinError struct {
	RelationID string
	Err        error
}

func (j *JoinError) Error() string {
	return "triejoin: cursor adapter failed for relation " + j.RelationID + ": " + j.Err.Error()
}

func (j *JoinError) Unwrap() error { return j.Err }

// pushFrame opens, for every relation that contains vars[varIdx], the trie
// level of that variable under the already bound prefix.
func (e *engine) pushFrame(varIdx int) (*frame, error) {
	fr := &frame{varIdx: varIdx}
	for ri, snap := range e.snaps {
		if !containsCol(snap.Columns, e.vars[varIdx]) {
			continue
		}
		it, ok := e.iterByRI[ri]
		if !ok {
			return nil, &JoinError{RelationID: snap.ID, Err: errMissingCursor}
		}
		if err := it.Open(); err != nil {
			return nil, &JoinError{RelationID: snap.ID, Err: err}
		}
		fr.cursors = append(fr.cursors, it)
	}
	if len(fr.cursors) == 0 {
		fr.exhausted = true
	}
	return fr, nil
}

func (e *engine) Next() ([]int64, bool, error) {
	if e.err != nil {
		return nil, false, e.err
	}
	if e.done {
		return nil, false, nil
	}
	if e.closed {
		return nil, false, ErrIteratorClosed
	}
	if err := e.ctx.Err(); err != nil {
		e.halt(err)
		return nil, false, err
	}
	if e.emptyResult {
		e.done = true
		e.closed = true
		return nil, false, e.closeAll()
	}

	for {
		if err := e.ctx.Err(); err != nil {
			e.halt(err)
			return nil, false, err
		}
		if len(e.stack) == 0 {
			fr, err := e.pushFrame(0)
			if err != nil {
				e.halt(err)
				return nil, false, err
			}
			e.stack = append(e.stack, fr)
		}
		top := e.stack[len(e.stack)-1]

		if len(top.cursors) == 0 {
			// No relation binds this variable: nothing finite to enumerate.
			if err := e.popFrame(); err != nil {
				e.halt(err)
				return nil, false, err
			}
			if len(e.stack) == 0 {
				e.done = true
				e.closed = true
				return nil, false, e.closeAll()
			}
			continue
		}

		// First entry into this level: converge from the freshly opened level.
		// Re-entry after a child frame popped: leave the current value first.
		var found bool
		var err error
		if top.resume {
			found, err = e.advance(top)
		} else {
			found, err = e.search(top)
		}
		if err != nil {
			e.halt(err)
			return nil, false, err
		}
		if !found {
			if err := e.popFrame(); err != nil {
				e.halt(err)
				return nil, false, err
			}
			if len(e.stack) == 0 {
				e.done = true
				e.closed = true
				return nil, false, e.closeAll()
			}
			continue
		}

		if len(e.bounds) == top.varIdx {
			e.bounds = append(e.bounds, top.cursors[top.pivot].At())
		} else {
			e.bounds[top.varIdx] = top.cursors[top.pivot].At()
		}

		if top.varIdx == len(e.vars)-1 {
			// Leaf level: emit, then the next call must advance this level.
			top.resume = true
			return append([]int64(nil), e.bounds...), true, nil
		}

		child, err := e.pushFrame(top.varIdx + 1)
		if err != nil {
			e.halt(err)
			return nil, false, err
		}
		e.stack = append(e.stack, child)
	}
}

// search performs leapfrog convergence from a freshly opened level.
func (e *engine) search(fr *frame) (bool, error) {
	if fr.exhausted {
		return false, nil
	}
	for _, it := range fr.cursors {
		if !it.Valid() {
			fr.exhausted = true
			return false, nil
		}
	}
	return e.converge(fr)
}

// converge repeatedly seeks the cursor on the smallest value to the current
// maximum until every cursor sits on one common value. Every jump is a seek;
// no cursor is walked value by value.
func (e *engine) converge(fr *frame) (bool, error) {
	n := len(fr.cursors)
	for {
		minIdx, maxIdx := 0, 0
		minVal, maxVal := fr.cursors[0].At(), fr.cursors[0].At()
		for i := 1; i < n; i++ {
			v := fr.cursors[i].At()
			if v < minVal {
				minVal, minIdx = v, i
			}
			if v > maxVal {
				maxVal, maxIdx = v, i
			}
		}
		if minVal == maxVal {
			fr.pivot = maxIdx
			return true, nil
		}
		ok, err := fr.cursors[minIdx].SeekTo(maxVal)
		if err != nil {
			return false, err
		}
		if !ok {
			fr.exhausted = true
			return false, nil
		}
	}
}

// advance leaves the current common value: one Next on the pivot cursor, then
// leapfrog seek convergence from the new maximum.
func (e *engine) advance(fr *frame) (bool, error) {
	pivot := fr.cursors[fr.pivot]
	more, err := pivot.Next()
	if err != nil {
		return false, err
	}
	if !more {
		fr.exhausted = true
		return false, nil
	}
	return e.converge(fr)
}

// popFrame closes the variable level: each cursor opened for it goes Up, the
// bound prefix entry is dropped, and the parent must search again.
func (e *engine) popFrame() error {
	top := e.stack[len(e.stack)-1]
	for _, it := range top.cursors {
		if err := it.Up(); err != nil {
			return err
		}
	}
	e.stack = e.stack[:len(e.stack)-1]
	if len(e.bounds) > 0 {
		e.bounds = e.bounds[:len(e.bounds)-1]
	}
	if len(e.stack) > 0 {
		// The parent cursor still sits on its common value; its subtree is
		// finished, so next time it must advance to the following value.
		e.stack[len(e.stack)-1].resume = true
	}
	return nil
}

func (e *engine) halt(err error) {
	e.err = err
	_ = e.closeAll()
}

func (e *engine) closeAll() error {
	var first error
	for _, it := range e.allIters {
		if err := it.Close(); err != nil && first == nil {
			first = err
		}
	}
	e.closed = true
	return first
}

// Close cancels the join and closes every cursor.
func (e *engine) Close() error {
	if e.closed {
		return nil
	}
	return e.closeAll()
}

// Counts aggregates cursor operation counters across all relations.
func (e *engine) Counts() Counts {
	var total Counts
	for _, it := range e.allIters {
		c := it.Counts()
		total.Opens += c.Opens
		total.Seeks += c.Seeks
		total.Nexts += c.Nexts
		total.Ups += c.Ups
	}
	return total
}
