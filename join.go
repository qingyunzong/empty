package dataeng

import (
	"context"
	"io"
)

// Mode selects the equality semantics of the join.
type Mode int

const (
	// ModeInner uses regular equality: keys containing NULL never match.
	ModeInner Mode = iota
	// ModeNullSafe uses null-safe equality: NULL matches NULL.
	ModeNullSafe
)

// Options configures a Joiner.
type Options struct {
	Mode Mode
	// MaxGroupRows bounds how many rows of one duplicate-key group side
	// are held in memory before the group spills to disk. Default 4096.
	MaxGroupRows int
	// Manager supplies the spill area. If nil, one is created in SpillDir
	// (or a temporary directory) and owned by the Joiner.
	Manager *SpillManager
	// SpillDir is used only when Manager is nil.
	SpillDir string
}

// Pair is one joined output row combination.
type Pair struct {
	Key   Key
	Left  Row
	Right Row
}

// Joiner performs a sort-merge join over two key-sorted, possibly chunked
// sources. Duplicate-key groups larger than memory spill to disk; the
// cartesian product of each group is emitted one Pair at a time via Next,
// in left-major order, preserving each side's input order.
type Joiner struct {
	left  *cursor
	right *cursor
	opts  Options
	mgr   *SpillManager
	own   bool

	txn  *SpillTxn
	emit *emitter
	done bool
}

// NewJoiner creates a joiner over left and right.
func NewJoiner(left, right Source, opts Options) (*Joiner, error) {
	if opts.MaxGroupRows <= 0 {
		opts.MaxGroupRows = 4096
	}
	mgr := opts.Manager
	own := false
	if mgr == nil {
		m, err := NewSpillManager(opts.SpillDir)
		if err != nil {
			return nil, err
		}
		mgr, own = m, true
	}
	return &Joiner{
		left:  newCursor(left),
		right: newCursor(right),
		opts:  opts,
		mgr:   mgr,
		own:   own,
	}, nil
}

// SpillManager returns the manager backing this joiner.
func (j *Joiner) SpillManager() *SpillManager { return j.mgr }

// Next returns the next joined pair in key order, or io.EOF when the join
// is exhausted. Each call performs O(1) work amortized, so a consumer can
// stop and resume freely between calls.
func (j *Joiner) Next(ctx context.Context) (Pair, error) {
	for {
		if j.emit != nil {
			p, ok, err := j.emit.next()
			if err != nil {
				return Pair{}, err
			}
			if ok {
				return p, nil
			}
			j.finishGroup()
		}
		if j.done {
			return Pair{}, io.EOF
		}
		if err := j.advance(ctx); err != nil {
			return Pair{}, err
		}
	}
}

// Collect drains the join and returns all pairs. Intended for tests and
// small inputs.
func (j *Joiner) Collect(ctx context.Context) ([]Pair, error) {
	var out []Pair
	for {
		p, err := j.Next(ctx)
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return out, err
		}
		out = append(out, p)
	}
}

// Close finishes the join normally: any in-flight spill transaction is
// aborted and, if the joiner owns the spill manager, all spill files
// (including committed batches) are removed.
func (j *Joiner) Close() error {
	j.discardEmitter()
	if j.txn != nil {
		j.txn.Abort()
		j.txn = nil
	}
	if j.own {
		return j.mgr.Close()
	}
	return nil
}

// Abort cancels the join: only the current (uncommitted) spill transaction
// is deleted; committed batches are kept on disk for recovery.
func (j *Joiner) Abort() error {
	j.discardEmitter()
	if j.txn != nil {
		j.txn.Abort()
		j.txn = nil
	}
	j.mgr.AbortActive()
	if j.own {
		j.own = false // keep the directory and committed batches
	}
	return nil
}

func (j *Joiner) discardEmitter() {
	if j.emit != nil {
		j.emit.close()
		j.emit = nil
	}
}

// finishGroup commits the current group's spill transaction.
func (j *Joiner) finishGroup() {
	j.discardEmitter()
	if j.txn != nil {
		j.txn.Commit()
		j.txn = nil
	}
}

// advance moves the cursors to the next matching key group and prepares
// its emitter.
func (j *Joiner) advance(ctx context.Context) error {
	for {
		l, err := j.left.peek(ctx)
		if err != nil {
			if err == io.EOF {
				j.done = true
			}
			return err
		}
		r, err := j.right.peek(ctx)
		if err != nil {
			if err == io.EOF {
				j.done = true
			}
			return err
		}
		c := CompareKeys(l.Key, r.Key)
		switch {
		case c < 0:
			if err := j.left.advance(ctx); err != nil {
				return err
			}
		case c > 0:
			if err := j.right.advance(ctx); err != nil {
				return err
			}
		default:
			if j.opts.Mode == ModeInner && l.Key.HasNull() {
				// NULL keys never match under regular equality;
				// skip both groups with this key.
				if err := j.skipGroup(ctx, j.left, l.Key); err != nil {
					return err
				}
				if err := j.skipGroup(ctx, j.right, r.Key); err != nil {
					return err
				}
				continue
			}
			return j.buildGroup(ctx, l.Key)
		}
	}
}

func (j *Joiner) skipGroup(ctx context.Context, cur *cursor, key Key) error {
	for {
		row, err := cur.peek(ctx)
		if err == io.EOF || CompareKeys(row.Key, key) != 0 {
			return nil
		}
		if err != nil {
			return err
		}
		if err := cur.advance(ctx); err != nil {
			return err
		}
	}
}

// group holds one side of a duplicate-key group, in memory or spilled.
type group struct {
	mem     []Row
	spilled bool
	file    string
	count   int
}

// buildGroup collects both sides of the matching key group, spilling to
// the current transaction when a side exceeds MaxGroupRows.
func (j *Joiner) buildGroup(ctx context.Context, key Key) error {
	txn, err := j.mgr.Begin()
	if err != nil {
		return err
	}
	j.txn = txn
	lg, err := j.collect(ctx, j.left, key)
	if err != nil {
		return err
	}
	rg, err := j.collect(ctx, j.right, key)
	if err != nil {
		return err
	}
	e := &emitter{key: key, lg: lg, rg: rg}
	if lg.spilled {
		if e.lr, err = OpenSpillReader(lg.file); err != nil {
			return err
		}
	}
	if rg.spilled {
		if e.rr, err = OpenSpillReader(rg.file); err != nil {
			e.close()
			return err
		}
	}
	j.emit = e
	return nil
}

// collect drains all rows equal to key from cur into a group.
func (j *Joiner) collect(ctx context.Context, cur *cursor, key Key) (*group, error) {
	g := &group{}
	var w *SpillWriter
	flush := func() error {
		if w == nil {
			var err error
			if w, err = j.txn.Writer(); err != nil {
				return err
			}
			g.file = w.Path()
		}
		for _, row := range g.mem {
			if err := w.Write(row); err != nil {
				return err
			}
		}
		g.mem = g.mem[:0]
		g.spilled = true
		return nil
	}
	for {
		row, err := cur.peek(ctx)
		if err == io.EOF || CompareKeys(row.Key, key) != 0 {
			break
		}
		if err != nil {
			return nil, err
		}
		if err := cur.advance(ctx); err != nil {
			return nil, err
		}
		if g.spilled {
			if err := w.Write(row); err != nil {
				return nil, err
			}
		} else {
			g.mem = append(g.mem, row)
			if len(g.mem) > j.opts.MaxGroupRows {
				if err := flush(); err != nil {
					return nil, err
				}
			}
		}
		g.count++
	}
	if w != nil {
		if err := w.Close(); err != nil {
			return nil, err
		}
	}
	return g, nil
}

// emitter streams the cartesian product of one matched key group,
// left-major, preserving input order within each side.
type emitter struct {
	key Key
	lg  *group
	rg  *group

	lr  *SpillReader // left spill reader, if lg spilled
	rr  *SpillReader // right spill reader, if rg spilled
	lix int          // next left index into lg.mem
	rix int          // next right index into rg.mem
	cur Row
	has bool
}

func (e *emitter) nextLeft() bool {
	if e.lg.spilled {
		row, err := e.lr.Next()
		if err != nil {
			return false
		}
		e.cur = row
		return true
	}
	if e.lix >= len(e.lg.mem) {
		return false
	}
	e.cur = e.lg.mem[e.lix]
	e.lix++
	return true
}

// nextRight returns the next right row for the current left row, resetting
// the right side when it is exhausted.
func (e *emitter) nextRight() (Row, bool, error) {
	if e.rg.spilled {
		row, err := e.rr.Next()
		if err == io.EOF {
			if err := e.rr.Reset(); err != nil {
				return Row{}, false, err
			}
			return Row{}, false, nil
		}
		if err != nil {
			return Row{}, false, err
		}
		return row, true, nil
	}
	if e.rix >= len(e.rg.mem) {
		e.rix = 0
		return Row{}, false, nil
	}
	row := e.rg.mem[e.rix]
	e.rix++
	return row, true, nil
}

func (e *emitter) next() (Pair, bool, error) {
	for {
		if !e.has {
			if !e.nextLeft() {
				return Pair{}, false, nil
			}
			e.has = true
		}
		r, ok, err := e.nextRight()
		if err != nil {
			return Pair{}, false, err
		}
		if ok {
			return Pair{Key: e.key, Left: e.cur, Right: r}, true, nil
		}
		e.has = false
	}
}

func (e *emitter) close() {
	if e.lr != nil {
		e.lr.Close()
	}
	if e.rr != nil {
		e.rr.Close()
	}
}
