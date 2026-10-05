// Package chansim simulates Go channels with a deterministic select.
//
// Unlike Go's built-in select, which picks a ready case uniformly at
// random, Select in this package always commits the ready case with the
// smallest index. A single Select commits exactly one case; the
// registrations for every other case are revoked atomically, so a send
// that lost the selection can never be delivered later (no ghost sends).
//
// Closing a channel never panics. Receivers drain the buffer first and
// then observe the zero value with ok == false. Sends on a closed channel
// simply fail (ok == false) instead of panicking.
package chansim

import "sync"

// mu guards the whole simulation. A single lock keeps every Select
// atomic: readiness checks, commits and revocations all happen under it.
var mu sync.Mutex

// Chan is a simulated channel with a fixed buffer capacity.
type Chan struct {
	cap    int
	buf    []any
	closed bool
	sendQ  []*node // blocked senders, FIFO, values attached
	recvQ  []*node // blocked receivers, FIFO
}

// New returns a channel with the given buffer capacity. A capacity of
// zero yields an unbuffered (rendezvous) channel.
func New(capacity int) *Chan {
	if capacity < 0 {
		panic("chansim: negative capacity")
	}
	return &Chan{cap: capacity}
}

// Case is one branch of a Select, built by Send or Recv.
type Case struct {
	ch   *Chan
	val  any
	send bool
}

// Send returns a select case that sends v on ch.
func Send(ch *Chan, v any) Case { return Case{ch: ch, val: v, send: true} }

// Recv returns a select case that receives from ch.
func Recv(ch *Chan) Case { return Case{ch: ch} }

// node is one registered (blocked) case sitting in a channel queue.
type node struct {
	op   *op
	idx  int // case index inside op
	ch   *Chan
	val  any // payload for send cases
	send bool
	live bool
}

// result is the outcome of a committed operation.
type result struct {
	idx int  // committed case index
	val any  // received value (recv cases only)
	ok  bool // false: send hit a closed channel, or recv saw closed+drained
}

// op is a pending or committed send/recv/select operation.
type op struct {
	cases  []Case
	nodes  []*node
	done   chan result // buffered(1); exactly one result is ever sent
	chosen int         // -1 while pending
	res    result
}

// Select blocks until one case can proceed, commits the ready case with
// the smallest index, and revokes the registrations of all other cases.
// It returns the committed index; for a receive case it also returns the
// value and ok=false if the channel was closed and drained. For a send
// case ok reports whether the send succeeded (false on a closed channel).
// Select with no cases blocks forever, like select{}.
func Select(cases ...Case) (idx int, val any, ok bool) {
	o := startOp(cases)
	res := <-o.done
	return res.idx, res.val, res.ok
}

// Send blocks until v is delivered (buffered or handed to a receiver).
// It returns false if the channel is or becomes closed.
func (c *Chan) Send(v any) bool {
	_, _, ok := Select(Send(c, v))
	return ok
}

// Recv blocks until a value is available. It returns the zero value and
// false once the channel is closed and its buffer is drained.
func (c *Chan) Recv() (any, bool) {
	_, v, ok := Select(Recv(c))
	return v, ok
}

// Close closes the channel. Blocked senders fail; blocked receivers get
// the zero value. Buffered values remain receivable. Close is idempotent.
func (c *Chan) Close() {
	mu.Lock()
	defer mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	sendQ := c.sendQ
	recvQ := c.recvQ
	c.sendQ = nil
	c.recvQ = nil
	for _, n := range sendQ {
		commit(n.op, result{idx: n.idx})
	}
	for _, n := range recvQ {
		commit(n.op, result{idx: n.idx})
	}
}

// startOp either commits the operation immediately (smallest ready case)
// or registers one node per case in the channel queues. Caller must then
// wait on o.done. Invariant: a case is registered only if no case was
// ready, so a pending op never has a synchronously satisfiable branch.
func startOp(cases []Case) *op {
	o := &op{cases: cases, done: make(chan result, 1), chosen: -1}
	if len(cases) == 0 {
		return o
	}
	mu.Lock()
	defer mu.Unlock()
	for i, c := range cases {
		if caseReady(c) {
			res := execCase(c)
			res.idx = i
			commit(o, res)
			return o
		}
	}
	for i, c := range cases {
		n := &node{op: o, idx: i, ch: c.ch, val: c.val, send: c.send, live: true}
		o.nodes = append(o.nodes, n)
		if c.send {
			c.ch.sendQ = append(c.ch.sendQ, n)
		} else {
			c.ch.recvQ = append(c.ch.recvQ, n)
		}
	}
	return o
}

// commit finalizes o with res and revokes every registered node, so no
// other branch of o can ever fire. Must be called with mu held.
func commit(o *op, res result) {
	if o.chosen >= 0 {
		return // already committed; defensive, queues hold only live nodes
	}
	o.chosen = res.idx
	o.res = res
	for _, n := range o.nodes {
		n.live = false
		n.ch.removeNode(n)
	}
	o.nodes = nil
	o.done <- res // never blocks: buffer 1, sent exactly once
}

// removeNode deletes n from its channel queue. Must be called with mu held.
func (c *Chan) removeNode(x *node) {
	if x.send {
		c.sendQ = removeNode(c.sendQ, x)
	} else {
		c.recvQ = removeNode(c.recvQ, x)
	}
}

func removeNode(q []*node, x *node) []*node {
	for i, n := range q {
		if n == x {
			return append(q[:i], q[i+1:]...)
		}
	}
	return q
}

// caseReady reports whether c could commit right now. mu must be held.
func caseReady(c Case) bool {
	if c.send {
		return c.ch.closed || len(c.ch.buf) < c.ch.cap || len(c.ch.recvQ) > 0
	}
	return c.ch.closed || len(c.ch.buf) > 0 || len(c.ch.sendQ) > 0
}

// execCase performs the transfer for a ready case. mu must be held.
func execCase(c Case) result {
	if c.send {
		return result{ok: execSend(c.ch, c.val)}
	}
	v, ok := execRecv(c.ch)
	return result{val: v, ok: ok}
}

// execSend delivers v on c, returning false if c is closed. mu held.
func execSend(c *Chan, v any) bool {
	if c.closed {
		return false
	}
	if len(c.recvQ) > 0 {
		n := c.recvQ[0]
		c.recvQ = c.recvQ[1:]
		commit(n.op, result{idx: n.idx, val: v, ok: true})
		return true
	}
	c.buf = append(c.buf, v)
	return true
}

// execRecv takes a value from c. ok=false means closed and drained. mu held.
func execRecv(c *Chan) (any, bool) {
	if len(c.buf) > 0 {
		v := c.buf[0]
		c.buf = c.buf[1:]
		if len(c.sendQ) > 0 {
			// Buffer had been full; move the oldest blocked
			// sender's value into the freed slot.
			n := c.sendQ[0]
			c.sendQ = c.sendQ[1:]
			c.buf = append(c.buf, n.val)
			commit(n.op, result{idx: n.idx, ok: true})
		}
		return v, true
	}
	if len(c.sendQ) > 0 {
		n := c.sendQ[0]
		c.sendQ = c.sendQ[1:]
		commit(n.op, result{idx: n.idx, ok: true})
		return n.val, true
	}
	return nil, false
}
