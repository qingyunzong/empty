package chansim

import (
	"fmt"
	"testing"
)

// The exhaustive harness drives the simulation synchronously (via
// startOp) over two channels — A unbuffered, B buffered(1) — and
// enumerates every event sequence up to a fixed depth. After every
// event it checks, per channel:
//
//   - conservation / no ghost sends: every received token was committed
//     by a real send, in FIFO order; revoked branches never deliver;
//   - registration hygiene: channel queues hold exactly the send/recv
//     cases of still-pending ops, all live;
//   - channel invariants: buffer within capacity, senders blocked only
//     when the buffer is full, receivers blocked only when no value is
//     available;
//   - failure semantics: sends fail only on closed channels, receives
//     return the zero value only on closed+drained channels.

type harness struct {
	t       *testing.T
	seq     []int
	ch      [2]*Chan
	ops     []*op
	seen    []bool
	avail   [2][]int // committed send tokens per channel, in commit order
	rcvd    [2]int   // how many of avail were received (prefix property)
	nextTok int
}

func newHarness(t *testing.T, seq []int) *harness {
	return &harness{t: t, seq: append([]int(nil), seq...), ch: [2]*Chan{New(0), New(1)}}
}

func (h *harness) fatalf(format string, args ...any) {
	h.t.Fatalf("seq %v: %s", h.seq, fmt.Sprintf(format, args...))
}

func (h *harness) chIndex(c *Chan) int {
	if c == h.ch[0] {
		return 0
	}
	return 1
}

func (h *harness) token() int {
	h.nextTok++
	return h.nextTok
}

func (h *harness) fire(cases ...Case) {
	h.ops = append(h.ops, startOp(cases))
	h.seen = append(h.seen, false)
	h.scan()
	h.checkChannels()
}

func (h *harness) send(ci int)            { h.fire(Send(h.ch[ci], h.token())) }
func (h *harness) recv(ci int)            { h.fire(Recv(h.ch[ci])) }
func (h *harness) selRecvSend(ri, si int) { h.fire(Recv(h.ch[ri]), Send(h.ch[si], h.token())) }
func (h *harness) selSendRecv(si, ri int) { h.fire(Send(h.ch[si], h.token()), Recv(h.ch[ri])) }
func (h *harness) selRecvRecv(x, y int)   { h.fire(Recv(h.ch[x]), Recv(h.ch[y])) }
func (h *harness) selSendSend(x, y int) {
	h.fire(Send(h.ch[x], h.token()), Send(h.ch[y], h.token()))
}

func (h *harness) close(ci int) {
	h.ch[ci].Close()
	h.scan()
	h.checkChannels()
}

// scan observes newly committed ops. Sends are processed before
// receives so a rendezvous completed by one event is modelled before
// the receive that consumed it.
func (h *harness) scan() {
	for pass := 0; pass < 2; pass++ {
		for i, o := range h.ops {
			if h.seen[i] || o.chosen < 0 {
				continue
			}
			c := o.cases[o.chosen]
			if (pass == 0) != c.send {
				continue
			}
			h.seen[i] = true
			if c.send {
				h.observeSend(o, c)
			} else {
				h.observeRecv(o, c)
			}
		}
	}
}

func (h *harness) observeSend(o *op, c Case) {
	ci := h.chIndex(c.ch)
	if o.res.ok {
		h.avail[ci] = append(h.avail[ci], c.val.(int))
		return
	}
	if !c.ch.closed {
		h.fatalf("send of token %d failed on open channel %d", c.val, ci)
	}
}

func (h *harness) observeRecv(o *op, c Case) {
	ci := h.chIndex(c.ch)
	if !o.res.ok {
		if o.res.val != nil {
			h.fatalf("failed recv on channel %d returned %v", ci, o.res.val)
		}
		if !c.ch.closed {
			h.fatalf("recv on channel %d failed while open", ci)
		}
		if len(c.ch.buf) != 0 || len(c.ch.sendQ) != 0 {
			h.fatalf("recv on channel %d failed while values remain", ci)
		}
		return
	}
	tok, isTok := o.res.val.(int)
	if !isTok {
		h.fatalf("channel %d delivered non-token %v", ci, o.res.val)
	}
	if h.rcvd[ci] >= len(h.avail[ci]) {
		h.fatalf("channel %d delivered ghost token %d (no committed send)", ci, tok)
	}
	if want := h.avail[ci][h.rcvd[ci]]; want != tok {
		h.fatalf("channel %d delivered token %d, FIFO wants %d", ci, tok, want)
	}
	h.rcvd[ci]++
}

func (h *harness) checkChannels() {
	for ci, c := range h.ch {
		// Buffer contents are exactly the committed-but-unreceived tokens.
		var gotBuf []int
		for _, v := range c.buf {
			gotBuf = append(gotBuf, v.(int))
		}
		if want := h.avail[ci][h.rcvd[ci]:]; !equalInts(gotBuf, want) {
			h.fatalf("channel %d: buffer %v != committed-unreceived %v", ci, gotBuf, want)
		}
		// Send queue holds exactly the send cases of pending ops,
		// in registration order, all live.
		var wantPend, gotPend []int
		for _, o := range h.ops {
			if o.chosen >= 0 {
				continue
			}
			for _, cs := range o.cases {
				if cs.send && h.chIndex(cs.ch) == ci {
					wantPend = append(wantPend, cs.val.(int))
				}
			}
		}
		for _, n := range c.sendQ {
			if !n.live {
				h.fatalf("channel %d: revoked send registration leaked", ci)
			}
			gotPend = append(gotPend, n.val.(int))
		}
		if !equalInts(gotPend, wantPend) {
			h.fatalf("channel %d: send queue %v != pending sends %v", ci, gotPend, wantPend)
		}
		// Recv queue holds exactly the recv cases of pending ops.
		wantRecv, gotRecv := 0, len(c.recvQ)
		for _, o := range h.ops {
			if o.chosen >= 0 {
				continue
			}
			for _, cs := range o.cases {
				if !cs.send && h.chIndex(cs.ch) == ci {
					wantRecv++
				}
			}
		}
		for _, n := range c.recvQ {
			if !n.live {
				h.fatalf("channel %d: revoked recv registration leaked", ci)
			}
		}
		if gotRecv != wantRecv {
			h.fatalf("channel %d: %d recv registrations, want %d", ci, gotRecv, wantRecv)
		}
		// Structural invariants.
		if len(c.buf) > c.cap {
			h.fatalf("channel %d: buffer %d over capacity %d", ci, len(c.buf), c.cap)
		}
		if len(c.recvQ) > 0 && (len(c.buf) > 0 || len(c.sendQ) > 0) {
			h.fatalf("channel %d: receivers blocked while a value is available", ci)
		}
		if len(c.sendQ) > 0 && len(c.buf) < c.cap {
			h.fatalf("channel %d: senders blocked while buffer has space", ci)
		}
	}
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

var events = []struct {
	name string
	run  func(h *harness)
}{
	{"sendA", func(h *harness) { h.send(0) }},
	{"sendB", func(h *harness) { h.send(1) }},
	{"recvA", func(h *harness) { h.recv(0) }},
	{"recvB", func(h *harness) { h.recv(1) }},
	{"closeA", func(h *harness) { h.close(0) }},
	{"closeB", func(h *harness) { h.close(1) }},
	{"sel(rA,sB)", func(h *harness) { h.selRecvSend(0, 1) }},
	{"sel(sA,rB)", func(h *harness) { h.selSendRecv(0, 1) }},
	{"sel(rB,sA)", func(h *harness) { h.selRecvSend(1, 0) }},
	{"sel(sB,rA)", func(h *harness) { h.selSendRecv(1, 0) }},
	{"sel(rA,rB)", func(h *harness) { h.selRecvRecv(0, 1) }},
	{"sel(sA,sB)", func(h *harness) { h.selSendSend(0, 1) }},
}

func TestExhaustiveSmallEvents(t *testing.T) {
	const depth = 5
	n := len(events)
	total := 1
	for i := 0; i < depth; i++ {
		total *= n
	}
	seq := make([]int, depth)
	for num := 0; num < total; num++ {
		for x, j := num, depth-1; j >= 0; x, j = x/n, j-1 {
			seq[j] = x % n
		}
		h := newHarness(t, seq)
		for _, e := range seq {
			events[e].run(h)
		}
	}
}
