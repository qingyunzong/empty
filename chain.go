// Package chainrepl simulates chain replication over a reordering network.
//
// Writes enter at the head and propagate hop by hop to the tail. The tail
// commits and acknowledgements travel back along the reverse path. A node
// may only publish the contiguous committed prefix of its log. Nodes that
// restart keep their durable log and fill holes via state sync from their
// neighbours. Every topology switch is bound to a new epoch; writes and
// acknowledgements carry the epoch of their entry so stale acks from an old
// configuration are never misapplied to a different write.
package chainrepl

import (
	"fmt"
	"math/rand"
	"sort"
)

type MsgKind int

const (
	KindWrite MsgKind = iota
	KindAck
	KindSync
)

func (k MsgKind) String() string {
	switch k {
	case KindWrite:
		return "Write"
	case KindAck:
		return "Ack"
	case KindSync:
		return "Sync"
	}
	return "?"
}

// Entry is a single replicated write. Seq is globally unique across epochs,
// so (Epoch, Seq) identifies exactly one client write.
type Entry struct {
	Epoch int
	Seq   int
	Value string
}

type Message struct {
	Kind  MsgKind
	From  int
	To    int
	Epoch int // epoch of the entry at Seq (writes and acks)
	Seq   int // write seq, or cumulative commit point for acks
	Value string

	Entries []Entry // sync payload: sender's log snapshot
	Commit  int     // sync payload: sender's commit watermark
}

// Node keeps a durable log (survives crashes), a commit watermark (the
// highest seq such that [1, commit] is committed) and acks that arrived
// before their entries and are still awaiting justification.
type Node struct {
	ID          int
	crashed     bool
	log         map[int]Entry
	commit      int
	pendingAcks map[int]int // seq -> epoch of acks waiting on log holes
}

func (n *Node) Commit() int                 { return n.commit }
func (n *Node) LogLen() int                 { return len(n.log) }
func (n *Node) Crashed() bool               { return n.crashed }
func (n *Node) Entry(seq int) (Entry, bool) { e, ok := n.log[seq]; return e, ok }

type Cluster struct {
	nodes         map[int]*Node
	chain         []int
	epoch         int
	nextSeq       int
	queue         []Message
	published     []string
	publishedUpTo int
	violations    []string
	rng           *rand.Rand
}

func NewCluster(ids []int, chain []int, rng *rand.Rand) *Cluster {
	c := &Cluster{nodes: make(map[int]*Node), epoch: 1, rng: rng}
	for _, id := range ids {
		c.nodes[id] = &Node{ID: id, log: make(map[int]Entry), pendingAcks: make(map[int]int)}
	}
	c.chain = append([]int(nil), chain...)
	return c
}

func (c *Cluster) Epoch() int           { return c.epoch }
func (c *Cluster) Pending() int         { return len(c.queue) }
func (c *Cluster) Node(id int) *Node    { return c.nodes[id] }
func (c *Cluster) Violations() []string { return c.violations }
func (c *Cluster) Published() []string  { return append([]string(nil), c.published...) }

// Submit hands a client write to the current head, stamped with the epoch.
func (c *Cluster) Submit(value string) int {
	c.nextSeq++
	c.send(Message{Kind: KindWrite, From: -1, To: c.chain[0], Epoch: c.epoch, Seq: c.nextSeq, Value: value})
	return c.nextSeq
}

// Crash fails a node; in-flight messages addressed to it are lost on delivery.
func (c *Cluster) Crash(id int) { c.nodes[id].crashed = true }

// Restart brings a node back with its durable log intact and triggers state
// sync with its neighbours so log holes are filled.
func (c *Cluster) Restart(id int) {
	c.nodes[id].crashed = false
	idx := indexOf(c.chain, id)
	if idx < 0 {
		return
	}
	if idx > 0 {
		c.send(c.syncMsg(c.chain[idx-1], id))
	}
	if idx < len(c.chain)-1 {
		c.send(c.syncMsg(id, c.chain[idx+1]))
	}
}

// Reconfigure installs a new chain and binds it to a fresh epoch. The new
// head receives a state transfer from every old-chain node, and adjacent
// pairs sync so holes left by the old topology are repaired.
func (c *Cluster) Reconfigure(chain []int) {
	old := c.chain
	c.epoch++
	c.chain = append([]int(nil), chain...)
	for _, from := range old {
		c.send(c.syncMsg(from, chain[0]))
	}
	for i := 1; i < len(chain); i++ {
		c.send(c.syncMsg(chain[i-1], chain[i]))
	}
	// The new head may already hold a committed prefix it never headed;
	// publish whatever the previous configuration did not.
	c.publishFromHead(c.nodes[chain[0]])
}

// Inject enqueues a crafted message (used by tests to forge stale acks).
func (c *Cluster) Inject(m Message) { c.send(m) }

// Step delivers one random pending event. Returns false when quiescent.
func (c *Cluster) Step() bool {
	if len(c.queue) == 0 {
		return false
	}
	i := c.rng.Intn(len(c.queue))
	m := c.queue[i]
	c.queue = append(c.queue[:i], c.queue[i+1:]...)
	c.deliver(m)
	return true
}

// DeliverNext delivers the first queued message matching pred.
func (c *Cluster) DeliverNext(pred func(Message) bool) bool {
	for i, m := range c.queue {
		if pred(m) {
			c.queue = append(c.queue[:i], c.queue[i+1:]...)
			c.deliver(m)
			return true
		}
	}
	return false
}

func (c *Cluster) Drain() {
	for c.Step() {
	}
}

func (c *Cluster) send(m Message) { c.queue = append(c.queue, m) }

func (c *Cluster) deliver(m Message) {
	n := c.nodes[m.To]
	if n == nil || n.crashed {
		return // lost in flight
	}
	switch m.Kind {
	case KindWrite:
		c.onWrite(n, m)
	case KindAck:
		c.onAck(n, m)
	case KindSync:
		c.onSync(n, m)
	}
}

func (c *Cluster) onWrite(n *Node, m Message) {
	if e, ok := n.log[m.Seq]; ok {
		if e.Epoch != m.Epoch || e.Value != m.Value {
			c.violations = append(c.violations, fmt.Sprintf("node %d: conflicting write seq=%d", n.ID, m.Seq))
		}
		return
	}
	if m.Epoch > c.epoch {
		c.violations = append(c.violations, fmt.Sprintf("node %d: write from future epoch %d", n.ID, m.Epoch))
		return
	}
	n.log[m.Seq] = Entry{Epoch: m.Epoch, Seq: m.Seq, Value: m.Value}
	if m.Epoch < c.epoch {
		// Stale-epoch write arriving after a topology switch: keep it as a
		// hole fill and repair the neighbourhood via state sync.
		c.gossip(n, -1)
	} else if succ := c.successor(n.ID); succ >= 0 {
		// Forward hop by hop along the chain of the write's own epoch.
		c.send(Message{Kind: KindWrite, From: n.ID, To: succ, Epoch: m.Epoch, Seq: m.Seq, Value: m.Value})
	}
	c.tryCommit(n)
}

func (c *Cluster) onAck(n *Node, m Message) {
	if m.Seq <= n.commit {
		return // already committed
	}
	// Record the ack; it becomes usable once the contiguous prefix and the
	// entry it refers to are present. An ack whose epoch does not match the
	// entry at Seq is never justified, so stale acks are never misused.
	n.pendingAcks[m.Seq] = m.Epoch
	c.tryCommit(n)
}

func (c *Cluster) onSync(n *Node, m Message) {
	learned := false
	for _, e := range m.Entries {
		if cur, ok := n.log[e.Seq]; ok {
			if cur != e {
				c.violations = append(c.violations, fmt.Sprintf("node %d: sync conflict seq=%d", n.ID, e.Seq))
			}
			continue
		}
		n.log[e.Seq] = e
		learned = true
	}
	adopted := false
	// The peer's commit watermark is proof of a tail ack; adopt it as far
	// as our contiguous prefix reaches (entries are immutable, so this is
	// safe regardless of which direction the sync travelled).
	if m.Commit > n.commit && c.hasPrefix(n, m.Commit) {
		c.advanceCommit(n, m.Commit)
		adopted = true
	}
	c.tryCommit(n)
	if learned || adopted {
		c.gossip(n, m.From)
	}
}

// tryCommit advances the commit watermark as far as currently justified:
// the tail commits its own contiguous prefix; other nodes commit up to the
// highest pending ack whose entry is present, epoch-matched and contiguous.
func (c *Cluster) tryCommit(n *Node) {
	target := n.commit
	if c.isTail(n.ID) {
		target = c.contiguous(n)
	}
	for seq, epoch := range n.pendingAcks {
		if seq > target && n.log[seq].Epoch == epoch && c.hasPrefix(n, seq) {
			target = seq
		}
	}
	if target > n.commit {
		c.advanceCommit(n, target)
	}
}

// advanceCommit moves the watermark, publishes at the head, and propagates
// a cumulative ack towards the head.
func (c *Cluster) advanceCommit(n *Node, to int) {
	n.commit = to
	for seq := range n.pendingAcks {
		if seq <= to {
			delete(n.pendingAcks, seq)
		}
	}
	if c.isHead(n.ID) {
		c.publishFromHead(n)
		return
	}
	if pred := c.predecessor(n.ID); pred >= 0 {
		e := n.log[to]
		c.send(Message{Kind: KindAck, From: n.ID, To: pred, Epoch: e.Epoch, Seq: to})
	}
}

// publishFromHead releases the committed prefix the head has not published yet.
func (c *Cluster) publishFromHead(n *Node) {
	for c.publishedUpTo < n.commit {
		c.publishedUpTo++
		c.published = append(c.published, n.log[c.publishedUpTo].Value)
	}
}

// gossip shares the node's state with both chain neighbours (anti-entropy
// used for hole repair after restarts and epoch switches).
func (c *Cluster) gossip(n *Node, except int) {
	for _, nb := range []int{c.predecessor(n.ID), c.successor(n.ID)} {
		if nb >= 0 && nb != except {
			c.send(c.syncMsg(n.ID, nb))
		}
	}
}

func (c *Cluster) syncMsg(from, to int) Message {
	n := c.nodes[from]
	entries := make([]Entry, 0, len(n.log))
	for _, e := range n.log {
		entries = append(entries, e)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Seq < entries[j].Seq })
	return Message{Kind: KindSync, From: from, To: to, Entries: entries, Commit: n.commit}
}

// contiguous returns the length of the node's contiguous log prefix.
func (c *Cluster) contiguous(n *Node) int {
	k := n.commit
	for {
		if _, ok := n.log[k+1]; !ok {
			return k
		}
		k++
	}
}

// hasPrefix reports whether every entry in (commit, upto] is present.
func (c *Cluster) hasPrefix(n *Node, upto int) bool {
	for s := n.commit + 1; s <= upto; s++ {
		if _, ok := n.log[s]; !ok {
			return false
		}
	}
	return true
}

func (c *Cluster) isHead(id int) bool { return len(c.chain) > 0 && c.chain[0] == id }
func (c *Cluster) isTail(id int) bool { return len(c.chain) > 0 && c.chain[len(c.chain)-1] == id }

func (c *Cluster) predecessor(id int) int {
	i := indexOf(c.chain, id)
	if i <= 0 {
		return -1
	}
	return c.chain[i-1]
}

func (c *Cluster) successor(id int) int {
	i := indexOf(c.chain, id)
	if i < 0 || i >= len(c.chain)-1 {
		return -1
	}
	return c.chain[i+1]
}

func indexOf(chain []int, id int) int {
	for i, v := range chain {
		if v == id {
			return i
		}
	}
	return -1
}
