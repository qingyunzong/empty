package matrix

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// op records one single-element correction so it can be undone.
type op struct {
	Matrix string `json:"matrix"`
	R      int    `json:"r"`
	C      int    `json:"c"`
	Old    int64  `json:"old"`
	New    int64  `json:"new"`
}

// Snapshot is a frozen deep copy of A, B and C. Later mutations of the
// engine never affect it.
type Snapshot struct {
	A, B, C *Matrix
}

// Engine maintains sparse matrices A and B together with the product
// C = A*B, updated incrementally on every single-element correction.
type Engine struct {
	A, B, C *Matrix

	snaps   map[string]*Snapshot
	history []op
}

// NewEngine creates matrices of the given dimensions: A is aRows x aCols,
// B is aCols x bCols, C is aRows x bCols.
func NewEngine(aRows, aCols, bCols int) *Engine {
	return &Engine{
		A:     New(aRows, aCols),
		B:     New(aCols, bCols),
		C:     New(aRows, bCols),
		snaps: make(map[string]*Snapshot),
	}
}

// SetA applies a single-element correction to A and incrementally updates
// the affected row of C. The change is recorded for undo. On overflow the
// engine is left untouched and an error is returned.
func (e *Engine) SetA(r, c int, v int64) error {
	return e.set("A", r, c, v)
}

// SetB applies a single-element correction to B and incrementally updates
// the affected column of C.
func (e *Engine) SetB(r, c int, v int64) error {
	return e.set("B", r, c, v)
}

func (e *Engine) set(which string, r, c int, v int64) error {
	src := e.A
	if which == "B" {
		src = e.B
	}
	old := src.Get(r, c)
	if old == v {
		return nil
	}
	if err := e.apply(which, r, c, v); err != nil {
		return err
	}
	e.history = append(e.history, op{Matrix: which, R: r, C: c, Old: old, New: v})
	return nil
}

// apply performs the correction and the incremental C update without
// recording history. It is atomic: on error nothing is mutated.
func (e *Engine) apply(which string, r, c int, v int64) error {
	var src *Matrix
	if which == "A" {
		src = e.A
	} else {
		src = e.B
	}
	old := src.Get(r, c)
	if old == v {
		return nil
	}
	delta, err := checkedSub(v, old)
	if err != nil {
		return fmt.Errorf("matrix: %s[%d][%d]: %w", which, r, c, err)
	}
	// Plan all C updates first so an overflow aborts before any mutation.
	type upd struct {
		r, c int
		v    int64
	}
	var plan []upd
	if which == "A" {
		// C[r][j] += delta * B[c][j] for every non-zero B[c][j].
		for j, bv := range e.B.Row(c) {
			prod, err := checkedMul(delta, bv)
			if err != nil {
				return fmt.Errorf("matrix: C[%d][%d]: %w", r, j, err)
			}
			sum, err := checkedAdd(e.C.Get(r, j), prod)
			if err != nil {
				return fmt.Errorf("matrix: C[%d][%d]: %w", r, j, err)
			}
			plan = append(plan, upd{r, j, sum})
		}
	} else {
		// C[i][c] += A[i][r] * delta for every non-zero A[i][r].
		for i, av := range e.A.Col(r) {
			prod, err := checkedMul(av, delta)
			if err != nil {
				return fmt.Errorf("matrix: C[%d][%d]: %w", i, c, err)
			}
			sum, err := checkedAdd(e.C.Get(i, c), prod)
			if err != nil {
				return fmt.Errorf("matrix: C[%d][%d]: %w", i, c, err)
			}
			plan = append(plan, upd{i, c, sum})
		}
	}
	for _, u := range plan {
		if err := e.C.Set(u.r, u.c, u.v); err != nil { // zero deletes the entry
			return err
		}
	}
	return src.Set(r, c, v)
}

// Undo reverts the most recent correction, restoring A/B and C. It returns
// false when there is nothing to undo.
func (e *Engine) Undo() (bool, error) {
	if len(e.history) == 0 {
		return false, nil
	}
	last := e.history[len(e.history)-1]
	e.history = e.history[:len(e.history)-1]
	if err := e.apply(last.Matrix, last.R, last.C, last.Old); err != nil {
		return true, err
	}
	return true, nil
}

// UndoDepth reports how many corrections can still be undone.
func (e *Engine) UndoDepth() int { return len(e.history) }

// Snapshot stores a deep copy of A, B and C under name, replacing any
// previous snapshot with the same name.
func (e *Engine) Snapshot(name string) {
	e.snaps[name] = &Snapshot{A: e.A.Clone(), B: e.B.Clone(), C: e.C.Clone()}
}

// Snapshots lists snapshot names in sorted order.
func (e *Engine) Snapshots() []string {
	names := make([]string, 0, len(e.snaps))
	for n := range e.snaps {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Diff returns the cell-level differences of A, B and C between two
// snapshots, in snapshot order (from -> to).
func (e *Engine) Diff(from, to string) ([]Change, error) {
	sf, ok := e.snaps[from]
	if !ok {
		return nil, fmt.Errorf("matrix: unknown snapshot %q", from)
	}
	st, ok := e.snaps[to]
	if !ok {
		return nil, fmt.Errorf("matrix: unknown snapshot %q", to)
	}
	var out []Change
	out = append(out, DiffMatrices("A", sf.A, st.A)...)
	out = append(out, DiffMatrices("B", sf.B, st.B)...)
	out = append(out, DiffMatrices("C", sf.C, st.C)...)
	return out, nil
}

// Verify recomputes A*B with the naive dense triple loop and compares it
// with the incrementally maintained C. It refuses to run when the dense
// cost exceeds maxOps (guard for "small matrices only").
func (e *Engine) Verify(maxOps int64) error {
	cost := int64(e.A.Rows) * int64(e.A.Cols) * int64(e.B.Cols)
	if cost > maxOps {
		return fmt.Errorf("matrix: naive check skipped, dense cost %d exceeds limit %d", cost, maxOps)
	}
	ref, err := NaiveMultiply(e.A, e.B)
	if err != nil {
		return err
	}
	if !ref.Equal(e.C) {
		return fmt.Errorf("matrix: incremental C disagrees with naive A*B")
	}
	return nil
}

// --- persistence (JSON, standard library only) ---

type diskEntry struct {
	R int   `json:"r"`
	C int   `json:"c"`
	V int64 `json:"v"`
}

type diskMatrix struct {
	Rows    int         `json:"rows"`
	Cols    int         `json:"cols"`
	Entries []diskEntry `json:"entries,omitempty"`
}

type diskSnapshot struct {
	Name string     `json:"name"`
	A    diskMatrix `json:"a"`
	B    diskMatrix `json:"b"`
	C    diskMatrix `json:"c"`
}

type diskState struct {
	A         diskMatrix     `json:"a"`
	B         diskMatrix     `json:"b"`
	C         diskMatrix     `json:"c"`
	Snapshots []diskSnapshot `json:"snapshots,omitempty"`
	History   []op           `json:"history,omitempty"`
}

func toDisk(m *Matrix) diskMatrix {
	dm := diskMatrix{Rows: m.Rows, Cols: m.Cols}
	for k, v := range m.Data {
		dm.Entries = append(dm.Entries, diskEntry{R: k.R, C: k.C, V: v})
	}
	sort.Slice(dm.Entries, func(i, j int) bool {
		if dm.Entries[i].R != dm.Entries[j].R {
			return dm.Entries[i].R < dm.Entries[j].R
		}
		return dm.Entries[i].C < dm.Entries[j].C
	})
	return dm
}

func fromDisk(dm diskMatrix) *Matrix {
	m := New(dm.Rows, dm.Cols)
	for _, e := range dm.Entries {
		m.Data[Key{e.R, e.C}] = e.V
	}
	return m
}

// Save writes the full engine state (matrices, snapshots, undo history)
// as JSON to path.
func (e *Engine) Save(path string) error {
	st := diskState{A: toDisk(e.A), B: toDisk(e.B), C: toDisk(e.C), History: e.history}
	for _, name := range e.Snapshots() {
		s := e.snaps[name]
		st.Snapshots = append(st.Snapshots, diskSnapshot{
			Name: name, A: toDisk(s.A), B: toDisk(s.B), C: toDisk(s.C),
		})
	}
	buf, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, buf, 0o644)
}

// Load reads engine state previously written by Save.
func Load(path string) (*Engine, error) {
	buf, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var st diskState
	if err := json.Unmarshal(buf, &st); err != nil {
		return nil, err
	}
	e := &Engine{
		A:       fromDisk(st.A),
		B:       fromDisk(st.B),
		C:       fromDisk(st.C),
		snaps:   make(map[string]*Snapshot),
		history: st.History,
	}
	for _, ds := range st.Snapshots {
		e.snaps[ds.Name] = &Snapshot{A: fromDisk(ds.A), B: fromDisk(ds.B), C: fromDisk(ds.C)}
	}
	return e, nil
}
