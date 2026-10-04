package matrixlib

import (
	"fmt"
	"math/bits"
)

// Which identifies one of the maintained matrices.
type Which int

const (
	MatrixA Which = iota
	MatrixB
)

func (w Which) String() string {
	if w == MatrixA {
		return "A"
	}
	return "B"
}

// Engine maintains sparse integer matrices A and B and their product
// C = A*B. C is updated incrementally on every single-element correction.
type Engine struct {
	A, B, C *Matrix

	history   []mutation
	snapshots map[int]*Snapshot
	nextSnap  int
}

// cDelta records the previous value of one C entry touched by a mutation.
type cDelta struct {
	r, c   int
	oldVal int64
}

// mutation records one element correction so it can be undone exactly,
// without redoing any arithmetic.
type mutation struct {
	which    Which
	r, c     int
	oldVal   int64
	cTouched []cDelta
}

// Snapshot is an immutable deep copy of A, B and C at a point in time.
// Later modifications of the engine never affect it.
type Snapshot struct {
	ID      int
	A, B, C *Matrix
}

// NewEngine creates an engine where A is aRows x aCols and B is aCols x bCols.
func NewEngine(aRows, aCols, bCols int) *Engine {
	return &Engine{
		A:         NewMatrix(aRows, aCols),
		B:         NewMatrix(aCols, bCols),
		C:         NewMatrix(aRows, bCols),
		snapshots: make(map[int]*Snapshot),
	}
}

// SetA corrects one element of A and incrementally updates C.
// On arithmetic overflow nothing is modified and ErrOverflow is returned.
func (e *Engine) SetA(r, c int, v int64) error {
	if r < 0 || r >= e.A.rows || c < 0 || c >= e.A.cols {
		return fmt.Errorf("%w: A(%d, %d)", ErrOutOfRange, r, c)
	}
	old := e.A.Get(r, c)
	if old == v {
		return nil
	}
	delta, ov := subChecked(v, old)
	if ov {
		return fmt.Errorf("%w: delta of A(%d, %d)", ErrOverflow, r, c)
	}
	// Row r of C changes by delta * (row c of B). Compute all new values
	// first so an overflow leaves the engine completely untouched.
	m := mutation{which: MatrixA, r: r, c: c, oldVal: old}
	type upd struct {
		k   int
		val int64
	}
	var upds []upd
	for _, be := range e.B.RowEntries(c) {
		prod, ov := mulChecked(delta, be.Val)
		if ov {
			return fmt.Errorf("%w: %d * B(%d, %d)", ErrOverflow, delta, c, be.Col)
		}
		prev := e.C.Get(r, be.Col)
		nv, ov := addChecked(prev, prod)
		if ov {
			return fmt.Errorf("%w: accumulating C(%d, %d)", ErrOverflow, r, be.Col)
		}
		upds = append(upds, upd{be.Col, nv})
		m.cTouched = append(m.cTouched, cDelta{r: r, c: be.Col, oldVal: prev})
	}
	if err := e.A.Set(r, c, v); err != nil {
		return err
	}
	for _, u := range upds {
		if err := e.C.Set(r, u.k, u.val); err != nil {
			return err
		}
	}
	e.history = append(e.history, m)
	return nil
}

// SetB corrects one element of B and incrementally updates C.
// On arithmetic overflow nothing is modified and ErrOverflow is returned.
func (e *Engine) SetB(r, c int, v int64) error {
	if r < 0 || r >= e.B.rows || c < 0 || c >= e.B.cols {
		return fmt.Errorf("%w: B(%d, %d)", ErrOutOfRange, r, c)
	}
	old := e.B.Get(r, c)
	if old == v {
		return nil
	}
	delta, ov := subChecked(v, old)
	if ov {
		return fmt.Errorf("%w: delta of B(%d, %d)", ErrOverflow, r, c)
	}
	// Column c of C changes by (column r of A) * delta.
	m := mutation{which: MatrixB, r: r, c: c, oldVal: old}
	type upd struct {
		i   int
		val int64
	}
	var upds []upd
	for _, ae := range e.A.ColEntries(r) {
		prod, ov := mulChecked(ae.Val, delta)
		if ov {
			return fmt.Errorf("%w: A(%d, %d) * %d", ErrOverflow, ae.Row, r, delta)
		}
		prev := e.C.Get(ae.Row, c)
		nv, ov := addChecked(prev, prod)
		if ov {
			return fmt.Errorf("%w: accumulating C(%d, %d)", ErrOverflow, ae.Row, c)
		}
		upds = append(upds, upd{ae.Row, nv})
		m.cTouched = append(m.cTouched, cDelta{r: ae.Row, c: c, oldVal: prev})
	}
	if err := e.B.Set(r, c, v); err != nil {
		return err
	}
	for _, u := range upds {
		if err := e.C.Set(u.i, c, u.val); err != nil {
			return err
		}
	}
	e.history = append(e.history, m)
	return nil
}

// Undo reverts the most recent element correction, restoring the changed
// element of A (or B) and every C entry it touched. It reports false when
// there is nothing to undo.
func (e *Engine) Undo() bool {
	n := len(e.history)
	if n == 0 {
		return false
	}
	m := e.history[n-1]
	e.history = e.history[:n-1]
	src := e.A
	if m.which == MatrixB {
		src = e.B
	}
	if err := src.Set(m.r, m.c, m.oldVal); err != nil {
		panic(fmt.Sprintf("matrixlib: undo restore failed: %v", err))
	}
	for _, d := range m.cTouched {
		if err := e.C.Set(d.r, d.c, d.oldVal); err != nil {
			panic(fmt.Sprintf("matrixlib: undo restore failed: %v", err))
		}
	}
	return true
}

// PendingUndo reports how many corrections can still be undone.
func (e *Engine) PendingUndo() int { return len(e.history) }

// Snapshot stores an immutable deep copy of A, B and C and returns its ID.
func (e *Engine) Snapshot() int {
	e.nextSnap++
	e.snapshots[e.nextSnap] = &Snapshot{
		ID: e.nextSnap,
		A:  e.A.Clone(),
		B:  e.B.Clone(),
		C:  e.C.Clone(),
	}
	return e.nextSnap
}

// SnapshotByID returns a stored snapshot, or nil if the ID is unknown.
func (e *Engine) SnapshotByID(id int) *Snapshot { return e.snapshots[id] }

// Change describes one differing element between two matrix states.
type Change struct {
	Matrix   string // "A", "B" or "C"
	Row, Col int
	From, To int64
}

// Diff lists every element that differs between matrices a and b.
// Missing elements count as zero.
func Diff(name string, a, b *Matrix) []Change {
	ar, ac := a.Dims()
	br, bc := b.Dims()
	if ar != br || ac != bc {
		return []Change{{Matrix: name, Row: -1, Col: -1}}
	}
	seen := make(map[[2]int]int64)
	for _, en := range a.Entries() {
		seen[[2]int{en.Row, en.Col}] = en.Val
	}
	var out []Change
	for k, v := range seen {
		if nv := b.Get(k[0], k[1]); nv != v {
			out = append(out, Change{Matrix: name, Row: k[0], Col: k[1], From: v, To: nv})
		}
	}
	for _, en := range b.Entries() {
		k := [2]int{en.Row, en.Col}
		if _, ok := seen[k]; !ok {
			out = append(out, Change{Matrix: name, Row: en.Row, Col: en.Col, From: 0, To: en.Val})
		}
	}
	sortChanges(out)
	return out
}

// DiffSnapshots compares two stored snapshots across A, B and C.
func (e *Engine) DiffSnapshots(id1, id2 int) ([]Change, error) {
	s1, s2 := e.snapshots[id1], e.snapshots[id2]
	if s1 == nil || s2 == nil {
		return nil, fmt.Errorf("matrixlib: unknown snapshot id (%d, %d)", id1, id2)
	}
	var out []Change
	out = append(out, Diff("A", s1.A, s2.A)...)
	out = append(out, Diff("B", s1.B, s2.B)...)
	out = append(out, Diff("C", s1.C, s2.C)...)
	return out, nil
}

// DiffCurrent compares a stored snapshot with the current engine state.
func (e *Engine) DiffCurrent(id int) ([]Change, error) {
	s := e.snapshots[id]
	if s == nil {
		return nil, fmt.Errorf("matrixlib: unknown snapshot id %d", id)
	}
	var out []Change
	out = append(out, Diff("A", s.A, e.A)...)
	out = append(out, Diff("B", s.B, e.B)...)
	out = append(out, Diff("C", s.C, e.C)...)
	return out, nil
}

// subChecked returns a-b and whether it overflows int64.
func subChecked(a, b int64) (int64, bool) {
	s, _ := bits.Sub64(uint64(a), uint64(b), 0)
	d := int64(s)
	// Overflow iff signs of a and b differ and the result's sign differs
	// from a's sign.
	if (a >= 0) != (b >= 0) && (d >= 0) != (a >= 0) {
		return 0, true
	}
	return d, false
}
