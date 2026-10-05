package txcache

import (
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

// errKind classifies outcomes so model and library can be compared.
type errKind int

const (
	kindOK errKind = iota
	kindClosed
	kindInvalid
)

func classify(err error) errKind {
	switch {
	case err == nil:
		return kindOK
	case errors.Is(err, ErrTxClosed):
		return kindClosed
	case errors.Is(err, ErrHandleInvalid):
		return kindInvalid
	default:
		return kindInvalid // unexpected; model never produces this
	}
}

type mEntry struct {
	value string
	del   bool
}

type mSavepoint struct {
	logLen     int
	handleMark int
}

type mUndo struct {
	key  string
	prev mEntry
	had  bool
}

type mTx struct {
	open    bool
	overlay map[string]mEntry
	log     []mUndo
	sp      []mSavepoint
	live    map[int]bool
	nextH   int
}

// model is an independent re-implementation of the intended semantics.
type model struct {
	committed map[string]string
	txs       []*mTx
	// handle validity: (txIdx, handleID) pairs; live set lives on mTx.
	handles []mHandle
}

type mHandle struct {
	txIdx int
	id    int
	key   string
}

func newModel() *model { return &model{committed: map[string]string{}} }

func (m *model) begin() int {
	m.txs = append(m.txs, &mTx{open: true, overlay: map[string]mEntry{}, live: map[int]bool{}})
	return len(m.txs) - 1
}

func (m *model) openTxs() []int {
	var out []int
	for i, tx := range m.txs {
		if tx.open {
			out = append(out, i)
		}
	}
	return out
}

func (m *model) commit(i int) {
	tx := m.txs[i]
	for k, e := range tx.overlay {
		if e.del {
			delete(m.committed, k)
		} else {
			m.committed[k] = e.value
		}
	}
	tx.open = false
	tx.live = nil
}

func (m *model) rollback(i int) {
	tx := m.txs[i]
	tx.open = false
	tx.live = nil
}

func (m *model) savepoint(i int) {
	tx := m.txs[i]
	tx.sp = append(tx.sp, mSavepoint{logLen: len(tx.log), handleMark: tx.nextH})
}

func (m *model) rollbackTo(i, sp int) {
	tx := m.txs[i]
	mark := tx.sp[sp]
	for j := len(tx.log) - 1; j >= mark.logLen; j-- {
		u := tx.log[j]
		if u.had {
			tx.overlay[u.key] = u.prev
		} else {
			delete(tx.overlay, u.key)
		}
	}
	tx.log = tx.log[:mark.logLen]
	for id := mark.handleMark; id < tx.nextH; id++ {
		delete(tx.live, id)
	}
	tx.sp = tx.sp[:sp]
}

func (m *model) newHandle(i int, key string) int {
	tx := m.txs[i]
	id := tx.nextH
	tx.live[id] = true
	tx.nextH++
	m.handles = append(m.handles, mHandle{txIdx: i, id: id, key: key})
	return len(m.handles) - 1
}

// handleErr mirrors Handle.check.
func (m *model) handleErr(h mHandle) errKind {
	tx := m.txs[h.txIdx]
	if !tx.open {
		return kindClosed
	}
	if !tx.live[h.id] {
		return kindInvalid
	}
	return kindOK
}

func (m *model) get(h mHandle) (string, bool, errKind) {
	if k := m.handleErr(h); k != kindOK {
		return "", false, k
	}
	tx := m.txs[h.txIdx]
	if e, ok := tx.overlay[h.key]; ok {
		if e.del {
			return "", false, kindOK
		}
		return e.value, true, kindOK
	}
	v, ok := m.committed[h.key]
	return v, ok, kindOK
}

func (m *model) set(h mHandle, v string) errKind {
	if k := m.handleErr(h); k != kindOK {
		return k
	}
	tx := m.txs[h.txIdx]
	prev, had := tx.overlay[h.key]
	tx.log = append(tx.log, mUndo{key: h.key, prev: prev, had: had})
	tx.overlay[h.key] = mEntry{value: v}
	return kindOK
}

func (m *model) del(h mHandle) errKind {
	if k := m.handleErr(h); k != kindOK {
		return k
	}
	tx := m.txs[h.txIdx]
	prev, had := tx.overlay[h.key]
	tx.log = append(tx.log, mUndo{key: h.key, prev: prev, had: had})
	tx.overlay[h.key] = mEntry{del: true}
	return kindOK
}

// TestRandomizedAgainstModel drives the real cache and the model with
// identical random operation streams and compares every observable
// result: values, existence flags, and error kinds.
func TestRandomizedAgainstModel(t *testing.T) {
	seeds := []int64{1, 7, 42, 1337, 20261005}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomComparison(t, rand.New(rand.NewSource(seed)), 3000)
		})
	}
}

func runRandomComparison(t *testing.T, r *rand.Rand, steps int) {
	t.Helper()
	c := New()
	m := newModel()

	var txs []*Tx         // parallel to m.txs
	var handles []*Handle // parallel to m.handles
	var sps [][]int       // savepoint IDs per tx, parallel to mTx.sp

	keys := []string{"a", "b", "c", "d", "e"}
	randKey := func() string { return keys[r.Intn(len(keys))] }
	randVal := func() string { return fmt.Sprintf("v%d", r.Intn(20)) }

	openPairs := func() []int {
		var out []int
		for i, tx := range txs {
			if m.txs[i].open && tx != nil {
				out = append(out, i)
			}
		}
		return out
	}

	for step := 0; step < steps; step++ {
		open := openPairs()
		op := r.Intn(10)
		switch {
		case op == 0 || len(open) == 0: // begin
			tx := c.Begin()
			idx := m.begin()
			txs = append(txs, tx)
			sps = append(sps, nil)
			if len(txs) != len(m.txs) || idx != len(txs)-1 {
				t.Fatalf("step %d: tx index divergence", step)
			}
		case op == 1: // commit
			i := open[r.Intn(len(open))]
			if err := txs[i].Commit(); err != nil {
				t.Fatalf("step %d: commit: %v", step, err)
			}
			m.commit(i)
		case op == 2: // rollback
			i := open[r.Intn(len(open))]
			if err := txs[i].Rollback(); err != nil {
				t.Fatalf("step %d: rollback: %v", step, err)
			}
			m.rollback(i)
		case op == 3: // savepoint
			i := open[r.Intn(len(open))]
			sp, err := txs[i].Savepoint()
			if err != nil {
				t.Fatalf("step %d: savepoint: %v", step, err)
			}
			m.savepoint(i)
			sps[i] = append(sps[i], sp)
		case op == 4: // rollback to savepoint
			i := open[r.Intn(len(open))]
			if len(sps[i]) == 0 {
				continue
			}
			s := r.Intn(len(sps[i]))
			if err := txs[i].RollbackTo(sps[i][s]); err != nil {
				t.Fatalf("step %d: rollbackTo: %v", step, err)
			}
			m.rollbackTo(i, s)
			sps[i] = sps[i][:s]
		case op == 5 || op == 6: // new handle
			i := open[r.Intn(len(open))]
			h := txs[i].Handle(randKey())
			m.newHandle(i, h.key)
			handles = append(handles, h)
		default: // handle op, possibly on a dead handle
			if len(handles) == 0 {
				continue
			}
			hi := r.Intn(len(handles))
			h, mh := handles[hi], m.handles[hi]
			switch r.Intn(3) {
			case 0:
				v, ok, err := h.Get()
				mv, mok, mk := m.get(mh)
				if classify(err) != mk || (mk == kindOK && (v != mv || ok != mok)) {
					t.Fatalf("step %d: Get divergence: lib=(%q,%v,%v) model=(%q,%v,%v)",
						step, v, ok, err, mv, mok, mk)
				}
			case 1:
				val := randVal()
				err := h.Set(val)
				mk := m.set(mh, val)
				if classify(err) != mk {
					t.Fatalf("step %d: Set divergence: lib=%v model=%v", step, err, mk)
				}
			case 2:
				err := h.Delete()
				mk := m.del(mh)
				if classify(err) != mk {
					t.Fatalf("step %d: Delete divergence: lib=%v model=%v", step, err, mk)
				}
			}
		}
	}

	// Final committed state must match exactly.
	for i := range txs {
		if m.txs[i].open {
			if err := txs[i].Commit(); err != nil {
				t.Fatalf("final commit tx %d: %v", i, err)
			}
			m.commit(i)
		}
	}
	for k, mv := range m.committed {
		v, ok := c.Get(k)
		if !ok || v != mv {
			t.Fatalf("committed[%q]: lib=(%q,%v) model=%q", k, v, ok, mv)
		}
	}
	for _, k := range keys {
		if _, mok := m.committed[k]; !mok {
			if _, ok := c.Get(k); ok {
				t.Fatalf("committed[%q]: lib has key, model does not", k)
			}
		}
	}
}
