package chansim

import "testing"

// Exhaustive small-event verification: enumerate every event sequence up
// to a fixed depth over two channels (cap 1 and cap 2) and replay each
// sequence against fresh channels. Every step is checked against an
// independent model, and global invariants are asserted:
//
//   - no ghost sends: a received value must come from a send that
//     actually committed, and must be received at most once;
//   - single commit: a select commits exactly one branch — the resulting
//     channel state must match the model exactly;
//   - smallest index: a select always commits the ready branch with the
//     smallest index (verified by the model's own first-ready scan).

const exhDepth = 5

// event kinds
const (
	evSend0 = iota // TrySend on c0
	evSend1
	evRecv0 // TryRecv on c0
	evRecv1
	evClose0
	evClose1
	evSelS0R1 // SelectNow(Send c0, Recv c1)
	evSelR0S1 // SelectNow(Recv c0, Send c1)
	evSelR0R1 // SelectNow(Recv c0, Recv c1)
	evSelS1S0 // SelectNow(Send c1, Send c0)
	evCount
)

// mchan is the independent model of a Chan.
type mchan struct {
	buf    []int
	cap    int
	closed bool
}

func (m *mchan) sendReady() bool { return !m.closed && len(m.buf) < m.cap }
func (m *mchan) recvReady() bool { return len(m.buf) > 0 || m.closed }

func (m *mchan) trySend(v int) bool {
	if !m.sendReady() {
		return false
	}
	m.buf = append(m.buf, v)
	return true
}

// tryRecv returns (value, ok, committed).
func (m *mchan) tryRecv() (int, bool, bool) {
	if !m.recvReady() {
		return 0, false, false
	}
	if len(m.buf) > 0 {
		v := m.buf[0]
		m.buf = m.buf[1:]
		return v, true, true
	}
	return 0, false, true // closed and drained: zero value
}

type mcase struct {
	ch   *mchan
	send bool
	val  int
}

// selectNow commits the smallest-index ready branch; returns idx or -1.
func selectNow(cases []mcase) (idx int, val int, ok bool) {
	for i, cs := range cases {
		ready := cs.ch.recvReady()
		if cs.send {
			ready = cs.ch.sendReady()
		}
		if ready {
			if cs.send {
				cs.ch.buf = append(cs.ch.buf, cs.val)
				return i, 0, true
			}
			v, ok, _ := cs.ch.tryRecv()
			return i, v, ok
		}
	}
	return -1, 0, false
}

// world pairs the real channels with their models and the invariant sets.
type world struct {
	c0, c1   *Chan
	m0, m1   *mchan
	nextVal  int
	sent     map[int]bool // values whose send committed
	recvd    map[int]bool // values actually received
	t        *testing.T
	sequence []int // for error messages
}

func newWorld(t *testing.T, seq []int) *world {
	return &world{
		c0: New(1), c1: New(2),
		m0: &mchan{cap: 1}, m1: &mchan{cap: 2},
		sent: map[int]bool{}, recvd: map[int]bool{},
		t: t, sequence: seq,
	}
}

func (w *world) fatalf(format string, args ...any) {
	w.t.Fatalf("sequence %v: "+format, append([]any{w.sequence}, args...)...)
}

func (w *world) checkState() {
	if got := w.c0.Len(); got != len(w.m0.buf) {
		w.fatalf("c0.Len() = %d, model %d", got, len(w.m0.buf))
	}
	if got := w.c1.Len(); got != len(w.m1.buf) {
		w.fatalf("c1.Len() = %d, model %d", got, len(w.m1.buf))
	}
	if w.c0.Closed() != w.m0.closed || w.c1.Closed() != w.m1.closed {
		w.fatalf("closed flags diverge: real %v/%v model %v/%v",
			w.c0.Closed(), w.c1.Closed(), w.m0.closed, w.m1.closed)
	}
}

func (w *world) noteSent(v int) {
	if w.sent[v] {
		w.fatalf("value %d committed by two sends", v)
	}
	w.sent[v] = true
}

func (w *world) noteRecvd(v int) {
	if !w.sent[v] {
		w.fatalf("ghost receive: value %d was never sent", v)
	}
	if w.recvd[v] {
		w.fatalf("value %d received twice", v)
	}
	w.recvd[v] = true
}

func (w *world) doSend(real *Chan, m *mchan) {
	w.nextVal++
	v := w.nextVal
	got := real.TrySend(v)
	want := m.trySend(v)
	if got != want {
		w.fatalf("TrySend(%d) = %v, model %v", v, got, want)
	}
	if got {
		w.noteSent(v)
	}
}

func (w *world) doRecv(real *Chan, m *mchan) {
	v, ok := real.TryRecv()
	mv, mok, committed := m.tryRecv()
	if !committed {
		if ok || v != nil {
			w.fatalf("TryRecv committed %v,%v on non-ready channel", v, ok)
		}
		return
	}
	if ok != mok {
		w.fatalf("TryRecv ok = %v, model %v", ok, mok)
	}
	if !ok {
		if v != nil {
			w.fatalf("TryRecv on closed drained channel = %v, want nil", v)
		}
		return
	}
	if v != mv {
		w.fatalf("TryRecv = %v, model %v", v, mv)
	}
	w.noteRecvd(v.(int))
}

func (w *world) doSelect(cases []Case, mcases []mcase) {
	idx, v, ok := SelectNow(cases...)
	midx, mv, mok := selectNow(mcases)
	if idx != midx {
		w.fatalf("SelectNow idx = %d, model %d", idx, midx)
	}
	if idx == -1 {
		return
	}
	cs := cases[idx]
	if cs.send {
		if !ok || v != nil {
			w.fatalf("send branch returned %v,%v, want nil,true", v, ok)
		}
		w.noteSent(cs.val.(int))
		return
	}
	if ok != mok {
		w.fatalf("recv branch ok = %v, model %v", ok, mok)
	}
	if ok {
		if v != mv {
			w.fatalf("recv branch = %v, model %v", v, mv)
		}
		w.noteRecvd(v.(int))
	} else if v != nil {
		w.fatalf("recv branch on closed channel = %v, want nil", v)
	}
}

func (w *world) step(ev int) {
	switch ev {
	case evSend0:
		w.doSend(w.c0, w.m0)
	case evSend1:
		w.doSend(w.c1, w.m1)
	case evRecv0:
		w.doRecv(w.c0, w.m0)
	case evRecv1:
		w.doRecv(w.c1, w.m1)
	case evClose0:
		w.c0.Close()
		w.m0.closed = true
	case evClose1:
		w.c1.Close()
		w.m1.closed = true
	case evSelS0R1:
		w.nextVal++
		w.doSelect(
			[]Case{SendCase(w.c0, w.nextVal), RecvCase(w.c1)},
			[]mcase{{ch: w.m0, send: true, val: w.nextVal}, {ch: w.m1}},
		)
	case evSelR0S1:
		w.nextVal++
		w.doSelect(
			[]Case{RecvCase(w.c0), SendCase(w.c1, w.nextVal)},
			[]mcase{{ch: w.m0}, {ch: w.m1, send: true, val: w.nextVal}},
		)
	case evSelR0R1:
		w.doSelect(
			[]Case{RecvCase(w.c0), RecvCase(w.c1)},
			[]mcase{{ch: w.m0}, {ch: w.m1}},
		)
	case evSelS1S0:
		w.nextVal++
		w.doSelect(
			[]Case{SendCase(w.c1, w.nextVal), SendCase(w.c0, w.nextVal+1000000)},
			[]mcase{{ch: w.m1, send: true, val: w.nextVal}, {ch: w.m0, send: true, val: w.nextVal + 1000000}},
		)
		w.nextVal += 1000000
	}
	w.checkState()
}

func TestExhaustiveSmallEvents(t *testing.T) {
	total := 0
	seq := make([]int, 0, exhDepth)
	var walk func(depth int)
	walk = func(depth int) {
		if depth == exhDepth {
			total++
			w := newWorld(t, append([]int(nil), seq...))
			for _, ev := range seq {
				w.step(ev)
			}
			return
		}
		for ev := 0; ev < evCount; ev++ {
			seq = append(seq, ev)
			walk(depth + 1)
			seq = seq[:len(seq)-1]
		}
	}
	walk(0)
	t.Logf("exhaustively verified %d event sequences of depth %d over %d event kinds", total, exhDepth, evCount)
}
