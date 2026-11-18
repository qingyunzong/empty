package formal

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// op is one competing operation in an interleaving.
type op struct {
	name  string
	prod  []step
	naive []nstep
	op    *opState
	nctx  *stealCtx
}

// result records how one operation ended in a particular interleaving.
type result struct {
	name   string
	l      Lease
	err    error
	writes int
}

type scenario struct {
	t      *testing.T
	m      *Manager
	sink   *FencingStore
	object string
	now    *time.Time
}

func newScenario(t *testing.T) *scenario {
	t.Helper()
	clock, now := freshClock()
	sink := NewFencingStore()
	m := NewManager(sink, WithClock(clock), WithTTL(time.Minute))
	return &scenario{t: t, m: m, sink: sink, object: "obj", now: now}
}

func (s *scenario) holder() string {
	st := s.m.entry(s.object)
	if !st.exists {
		return ""
	}
	return st.lease.Holder
}

func (s *scenario) epoch() uint64 {
	st := s.m.entry(s.object)
	if !st.exists {
		return 0
	}
	return st.lease.Epoch
}

func (s *scenario) dirty() bool {
	return s.m.entry(s.object).dirty
}

// setupHeld puts the object into the requested starting state and returns the
// holder's lease token.
func (s *scenario) setupHeld(holder string, dirty bool, data []byte, expired bool) Lease {
	s.t.Helper()
	l, err := s.m.Acquire(s.object, holder)
	if err != nil {
		s.t.Fatalf("setup acquire: %v", err)
	}
	if expired {
		st := s.m.entry(s.object)
		st.lease.Deadline = s.m.now().Add(-time.Second)
		l = st.lease
	}
	if dirty {
		if err := s.m.MarkDirty(l, data); err != nil {
			s.t.Fatalf("setup markdirty: %v", err)
		}
	}
	return s.m.entry(s.object).lease
}

func (s *scenario) setupFree() {
	s.t.Helper()
	s.m.entry(s.object)
}

func (s *scenario) newOp(name string, prod []step, naive []nstep) op {
	return op{
		name:  name,
		prod:  prod,
		naive: naive,
		op:    &opState{},
		nctx:  &stealCtx{},
	}
}

func (s *scenario) acquireOp(name, holder string) op {
	return s.newOp(name, s.m.acquireScript(s.object, holder), s.m.naiveAcquire(s.object, holder, nil))
}

func (s *scenario) renewOp(name string, token Lease) op {
	o := s.newOp(name, s.m.renewScript(token), s.m.naiveRenew(token, nil))
	return o
}

func (s *scenario) dirtyOp(name string, token Lease, data []byte) op {
	return s.newOp(name, s.m.markDirtyScript(token, data), s.m.naiveMarkDirty(token, data, nil))
}

func (s *scenario) flushOp(name string, token Lease) op {
	return s.newOp(name, s.m.flushScript(token), s.m.naiveFlush(token, nil))
}

func (s *scenario) breakOp(name string, token Lease) op {
	return s.newOp(name, s.m.breakScript(token), s.m.naiveBreak(token, nil))
}

func (s *scenario) stealOp(name, thief string) op {
	o := s.newOp(name, s.m.stealScript(s.object, thief), nil)
	o.naive = s.m.naiveSteal(s.object, thief, o.nctx)
	return o
}

func sameErr(a, b error) bool {
	return errors.Is(a, b) || (a == nil && b == nil)
}

// checkInvariantsAt verifies global safety properties against one instant's
// state and sink snapshot.
func (s *scenario) checkInvariantsAt(schedule string, st state, snap storeSnapshot) {
	s.t.Helper()
	// At most one holder: the record stores exactly one lease, and dirty
	// data may exist only while a lease exists.
	if st.dirty && !st.exists {
		s.t.Fatalf("%s: dirty data survives without a holder", schedule)
	}
	// Every accepted sink write used a strictly increasing epoch: the
	// fencing store guarantees this itself; assert count <= max epoch.
	if epoch, ok := snap.high[s.object]; ok {
		if got := snap.counts[s.object]; got > int(epoch) {
			s.t.Fatalf("%s: %d accepted writes but max epoch %d", schedule, got, epoch)
		}
	}
}

func snapshotsEqual(a, b storeSnapshot) bool {
	if a.accept != b.accept || len(a.high) != len(b.high) || len(a.counts) != len(b.counts) {
		return false
	}
	for k, v := range a.high {
		if b.high[k] != v {
			return false
		}
	}
	for k, v := range a.counts {
		if b.counts[k] != v {
			return false
		}
	}
	return reflect.DeepEqual(a.data, b.data)
}

// runInterleavings enumerates every step schedule of ops, replaying each
// through both the production steps and the naive table, and returns the
// terminal results of each enumerated schedule.
func (s *scenario) runInterleavings(ops ...op) [][]result {
	s.t.Helper()
	var all [][]result

	// Save and restore the starting state between schedules.
	base := *s.m.entry(s.object)
	baseData := append([]byte(nil), base.data...)
	sinkBase := s.sink.dump()

	var enumerate func(idx []int, done []bool, res []result, n *nstate, schedule string)
	enumerate = func(idx []int, done []bool, res []result, n *nstate, schedule string) {
		progress := false
		for i := range ops {
			if done[i] {
				continue
			}
			progress = true
			sinkBefore := s.sink.dump()
			stateBefore := *s.m.entry(s.object)
			stateBefore.data = append([]byte(nil), s.m.entry(s.object).data...)
			nBefore := *n
			if n.data != nil {
				nBefore.data = append([]byte(nil), n.data...)
			}
			opBefore := *ops[i].op
			nctxBefore := *ops[i].nctx
			// Production step against the live shared state.
			st := s.m.entry(s.object)
			l, err, terminal := ops[i].prod[idx[i]](st, ops[i].op)
			prodAfterState := *st
			prodAfterState.data = append([]byte(nil), st.data...)
			prodAfterSink := s.sink.dump()

			// Roll back, then run the naive step from the same snapshot so
			// both implementations observe identical starting conditions.
			*st = stateBefore
			st.data = append([]byte(nil), stateBefore.data...)
			s.sink.restore(sinkBefore)
			nl, nerr, nterminal := ops[i].naive[idx[i]](n, ops[i].nctx)
			naiveAfterN := *n
			if n.data != nil {
				naiveAfterN.data = append([]byte(nil), n.data...)
			}
			naiveAfterSink := s.sink.dump()
			if !sameErr(err, nerr) {
				s.t.Fatalf("%s|%s step %d: error mismatch prod=%v naive=%v",
					schedule, ops[i].name, idx[i], err, nerr)
			}
			if terminal != nterminal {
				s.t.Fatalf("%s|%s step %d: terminal mismatch prod=%v naive=%v",
					schedule, ops[i].name, idx[i], terminal, nterminal)
			}
			if terminal && err == nil && l != nl {
				s.t.Fatalf("%s|%s step %d: lease mismatch prod=%+v naive=%+v",
					schedule, ops[i].name, idx[i], l, nl)
			}
			if prodAfterState.exists != naiveAfterN.exists ||
				(prodAfterState.exists && prodAfterState.lease != naiveAfterN.lease) ||
				prodAfterState.dirty != naiveAfterN.dirty ||
				!reflect.DeepEqual(prodAfterState.data, naiveAfterN.data) {
				s.t.Fatalf("%s|%s step %d: state mismatch prod=%+v naive=%+v",
					schedule, ops[i].name, idx[i], prodAfterState, naiveAfterN)
			}
			if !snapshotsEqual(prodAfterSink, naiveAfterSink) {
				s.t.Fatalf("%s|%s step %d: sink mismatch prod=%+v naive=%+v",
					schedule, ops[i].name, idx[i], prodAfterSink, naiveAfterSink)
			}
			s.checkInvariantsAt(schedule+"|"+ops[i].name, prodAfterState, prodAfterSink)

			nextIdx := append([]int(nil), idx...)
			nextDone := append([]bool(nil), done...)
			nextRes := res
			if terminal {
				nextDone[i] = true
				nextRes = append(nextRes, result{name: ops[i].name, l: l, err: err})
			} else {
				nextIdx[i]++
			}
			// Recurse using the production post-step state as the child view.
			*st = prodAfterState
			st.data = append([]byte(nil), prodAfterState.data...)
			s.sink.restore(prodAfterSink)
			*n = naiveAfterN
			enumerate(nextIdx, nextDone, nextRes, n, schedule+fmt.Sprintf("%d", i))
			// Restore every surface so sibling branches start clean.
			*st = stateBefore
			st.data = append([]byte(nil), stateBefore.data...)
			s.sink.restore(sinkBefore)
			*n = nBefore
			*ops[i].op = opBefore
			*ops[i].nctx = nctxBefore
		}
		if !progress {
			for i := range res {
				res[i].writes = s.sink.AcceptedFor(s.object)
			}
			all = append(all, append([]result(nil), res...))
		}
	}

	idx := make([]int, len(ops))
	done := make([]bool, len(ops))
	n := s.naiveFrom(&base, baseData)
	enumerate(idx, done, nil, n, "")

	// Restore starting state for the caller's follow-up assertions / reuse.
	st := s.m.entry(s.object)
	*st = base
	st.data = append([]byte(nil), baseData...)
	s.sink.restore(sinkBase)
	return all
}

func (s *scenario) naiveFrom(base *state, data []byte) *nstate {
	n := &nstate{
		exists: base.exists,
		lease:  base.lease,
		dirty:  base.dirty,
		data:   append([]byte(nil), data...),
	}
	return n
}
