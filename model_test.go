package txcache

// Model-based randomized test: every operation is applied to both the real
// implementation and an independent state model; results must agree.

import (
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

// ---- state model ----

type mSavepoint struct {
	overlay map[string]*string
	nextID  uint64
}

type mTxn struct {
	overlay map[string]*string
	sps     []mSavepoint
	live    map[uint64]uint64 // handle ID -> nonce
	nextID  uint64
	nonce   uint64
	closed  bool
}

func (m *mTxn) cloneOverlay() map[string]*string {
	out := make(map[string]*string, len(m.overlay))
	for k, v := range m.overlay {
		if v == nil {
			out[k] = nil
		} else {
			s := *v
			out[k] = &s
		}
	}
	return out
}

func (m *mTxn) savepoint() int {
	m.sps = append(m.sps, mSavepoint{overlay: m.cloneOverlay(), nextID: m.nextID})
	return len(m.sps) - 1
}

func (m *mTxn) rollbackTo(sp int) {
	snap := m.sps[sp]
	m.overlay = make(map[string]*string, len(snap.overlay))
	for k, v := range snap.overlay {
		if v == nil {
			m.overlay[k] = nil
		} else {
			s := *v
			m.overlay[k] = &s
		}
	}
	for id := range m.live {
		if id >= snap.nextID {
			delete(m.live, id)
		}
	}
	m.nextID = snap.nextID
	m.sps = m.sps[:sp+1]
}

// ---- paired handle: real + model ----

type pairHandle struct {
	real  *Handle
	id    uint64
	nonce uint64
	key   string
	txn   *pairTxn
}

type pairTxn struct {
	real  *Txn
	model *mTxn
}

func (pt *pairTxn) valid(h *pairHandle) bool {
	if pt.model.closed {
		return false
	}
	nonce, ok := pt.model.live[h.id]
	return ok && nonce == h.nonce
}

func (pt *pairTxn) lookup(committed map[string]string, key string) (string, bool) {
	if v, ok := pt.model.overlay[key]; ok {
		if v == nil {
			return "", false
		}
		return *v, true
	}
	v, ok := committed[key]
	return v, ok
}

// ---- the randomized comparison test ----

func TestRandomOpsMatchModel(t *testing.T) {
	seeds := []int64{1, 7, 42, 1337, 20261006}
	for _, seed := range seeds {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			runRandomOps(t, rand.New(rand.NewSource(seed)), 4000)
		})
	}
}

func runRandomOps(t *testing.T, rng *rand.Rand, steps int) {
	t.Helper()
	c := New()
	committed := map[string]string{}
	var txns []*pairTxn
	var handles []*pairHandle

	key := func() string { return fmt.Sprintf("k%d", rng.Intn(8)) }
	val := func() string { return fmt.Sprintf("v%d", rng.Intn(1000)) }

	pickTxn := func() *pairTxn {
		var open []*pairTxn
		for _, tx := range txns {
			if !tx.model.closed {
				open = append(open, tx)
			}
		}
		if len(open) == 0 {
			return nil
		}
		return open[rng.Intn(len(open))]
	}

	for step := 0; step < steps; step++ {
		op := rng.Intn(100)
		switch {
		case op < 12: // begin
			tx := c.Begin()
			txns = append(txns, &pairTxn{
				real:  tx,
				model: &mTxn{overlay: map[string]*string{}, live: map[uint64]uint64{}},
			})

		case op < 30: // new handle
			pt := pickTxn()
			if pt == nil {
				continue
			}
			k := key()
			h, err := pt.real.Handle(k)
			if err != nil {
				t.Fatalf("step %d: Handle on open txn: %v", step, err)
			}
			id := pt.model.nextID
			pt.model.nextID++
			pt.model.nonce++
			pt.model.live[id] = pt.model.nonce
			handles = append(handles, &pairHandle{real: h, id: id, nonce: pt.model.nonce, key: k, txn: pt})

		case op < 55: // handle Get
			if len(handles) == 0 {
				continue
			}
			ph := handles[rng.Intn(len(handles))]
			v, ok, err := ph.real.Get()
			if !ph.txn.valid(ph) {
				if !errors.Is(err, ErrInvalidHandle) {
					t.Fatalf("step %d: stale handle Get: got err=%v, want ErrInvalidHandle", step, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("step %d: live handle Get: %v", step, err)
			}
			mv, mok := ph.txn.lookup(committed, ph.key)
			if v != mv || ok != mok {
				t.Fatalf("step %d: Get(%s) = %q,%v; model wants %q,%v", step, ph.key, v, ok, mv, mok)
			}

		case op < 72: // handle Set
			if len(handles) == 0 {
				continue
			}
			ph := handles[rng.Intn(len(handles))]
			nv := val()
			err := ph.real.Set(nv)
			if !ph.txn.valid(ph) {
				if !errors.Is(err, ErrInvalidHandle) {
					t.Fatalf("step %d: stale handle Set: got err=%v, want ErrInvalidHandle", step, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("step %d: live handle Set: %v", step, err)
			}
			s := nv
			ph.txn.model.overlay[ph.key] = &s

		case op < 78: // handle Delete
			if len(handles) == 0 {
				continue
			}
			ph := handles[rng.Intn(len(handles))]
			err := ph.real.Delete()
			if !ph.txn.valid(ph) {
				if !errors.Is(err, ErrInvalidHandle) {
					t.Fatalf("step %d: stale handle Delete: got err=%v, want ErrInvalidHandle", step, err)
				}
				continue
			}
			if err != nil {
				t.Fatalf("step %d: live handle Delete: %v", step, err)
			}
			ph.txn.model.overlay[ph.key] = nil

		case op < 86: // savepoint
			pt := pickTxn()
			if pt == nil {
				continue
			}
			got, err := pt.real.Savepoint()
			if err != nil {
				t.Fatalf("step %d: Savepoint: %v", step, err)
			}
			want := pt.model.savepoint()
			if got != want {
				t.Fatalf("step %d: savepoint token = %d; model wants %d", step, got, want)
			}

		case op < 93: // rollback to savepoint
			pt := pickTxn()
			if pt == nil || len(pt.model.sps) == 0 {
				continue
			}
			sp := rng.Intn(len(pt.model.sps))
			if err := pt.real.RollbackTo(sp); err != nil {
				t.Fatalf("step %d: RollbackTo(%d): %v", step, sp, err)
			}
			pt.model.rollbackTo(sp)

		case op < 97: // commit
			pt := pickTxn()
			if pt == nil {
				continue
			}
			if err := pt.real.Commit(); err != nil {
				t.Fatalf("step %d: Commit: %v", step, err)
			}
			for k, v := range pt.model.overlay {
				if v == nil {
					delete(committed, k)
				} else {
					committed[k] = *v
				}
			}
			pt.model.closed = true

		default: // rollback
			pt := pickTxn()
			if pt == nil {
				continue
			}
			if err := pt.real.Rollback(); err != nil {
				t.Fatalf("step %d: Rollback: %v", step, err)
			}
			pt.model.closed = true
		}
	}

	// Final reconciliation: committed store matches the model exactly.
	for k, want := range committed {
		if got, ok := c.Get(k); !ok || got != want {
			t.Fatalf("final: cache[%s] = %q,%v; model wants %q,true", k, got, ok, want)
		}
	}
	for i := 0; i < 8; i++ {
		k := fmt.Sprintf("k%d", i)
		if _, want := committed[k]; !want {
			if _, ok := c.Get(k); ok {
				t.Fatalf("final: cache[%s] present; model wants absent", k)
			}
		}
	}
	t.Logf("completed %d random ops: %d txns, %d handles, %d committed keys",
		steps, len(txns), len(handles), len(committed))
}
