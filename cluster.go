package broadcastsim

import (
	"errors"
	"fmt"
)

// EnvelopeKind distinguishes broadcast messages from acknowledgment gossip.
type EnvelopeKind int

const (
	// KindMessage is a broadcast payload on its way to a node.
	KindMessage EnvelopeKind = iota
	// KindAck notifies a node that From acknowledged Msg.
	KindAck
)

// Envelope is one in-flight network packet.
type Envelope struct {
	Kind EnvelopeKind
	From string
	To   string
	Msg  Message
}

// Cluster is a fixed 3-node broadcast network with simulated packet loss.
// Packets that are dropped stay in the pending queue and can be retried by
// flushing again.
type Cluster struct {
	ids     []string
	nodes   map[string]*Node
	pending []Envelope

	// Loss reports whether an envelope is dropped this round. Dropped
	// envelopes remain pending. A nil Loss means a perfect network.
	Loss func(env Envelope) bool
}

// NewCluster creates a cluster with the given node ids (exactly NodeCount),
// each persisting its ack log in dir.
func NewCluster(dir string, ids ...string) (*Cluster, error) {
	if len(ids) != NodeCount {
		return nil, fmt.Errorf("cluster requires exactly %d nodes, got %d", NodeCount, len(ids))
	}
	c := &Cluster{ids: append([]string(nil), ids...), nodes: make(map[string]*Node)}
	for _, id := range ids {
		if _, dup := c.nodes[id]; dup {
			return nil, fmt.Errorf("duplicate node id %q", id)
		}
		n, err := NewNode(id, dir)
		if err != nil {
			return nil, err
		}
		c.nodes[id] = n
	}
	return c, nil
}

// NodeIDs returns the cluster node ids in creation order.
func (c *Cluster) NodeIDs() []string { return append([]string(nil), c.ids...) }

// Node returns the node with the given id, or nil.
func (c *Cluster) Node(id string) *Node { return c.nodes[id] }

// Pending returns the number of undelivered packets still queued.
func (c *Cluster) Pending() int { return len(c.pending) }

// Broadcast enqueues msg for delivery to every node, including the sender.
func (c *Cluster) Broadcast(from string, msg Message) error {
	if _, ok := c.nodes[from]; !ok {
		return fmt.Errorf("unknown broadcaster %q", from)
	}
	if msg.Seq <= 0 {
		return fmt.Errorf("invalid sequence number %d", msg.Seq)
	}
	for _, id := range c.ids {
		c.pending = append(c.pending, Envelope{Kind: KindMessage, From: from, To: id, Msg: msg})
	}
	return nil
}

// Flush makes one pass over the pending queue. Packets dropped by Loss stay
// pending; delivered packets are applied and any acks they generate are
// enqueued. The first conflict or validation error is returned.
func (c *Cluster) Flush() error {
	queue := c.pending
	c.pending = nil
	var errs []error
	for _, env := range queue {
		if c.Loss != nil && c.Loss(env) {
			c.pending = append(c.pending, env) // lost: retained for retry
			continue
		}
		if err := c.deliver(env); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// FlushUntilIdle flushes repeatedly until the pending queue is empty or
// maxRounds is exhausted. It returns an error if packets remain pending.
func (c *Cluster) FlushUntilIdle(maxRounds int) error {
	for round := 0; round < maxRounds; round++ {
		if c.Pending() == 0 {
			return nil
		}
		if err := c.Flush(); err != nil {
			return err
		}
	}
	if c.Pending() != 0 {
		return fmt.Errorf("%d packets still pending after %d rounds", c.Pending(), maxRounds)
	}
	return nil
}

// deliver applies one envelope to its destination node.
func (c *Cluster) deliver(env Envelope) error {
	n, ok := c.nodes[env.To]
	if !ok {
		return fmt.Errorf("unknown destination %q", env.To)
	}
	switch env.Kind {
	case KindMessage:
		if err := n.ReceiveMessage(env.Msg); err != nil {
			return err
		}
		// Gossip this node's ack to the other nodes.
		for _, id := range c.ids {
			if id != env.To {
				c.pending = append(c.pending, Envelope{Kind: KindAck, From: env.To, To: id, Msg: env.Msg})
			}
		}
		return nil
	case KindAck:
		return n.ReceiveAck(env.From, env.Msg)
	default:
		return fmt.Errorf("unknown envelope kind %d", env.Kind)
	}
}

// Verify checks cluster-wide safety: no conflicting acks for any sequence
// number, and every node's delivered set is a consistent prefix 1..k whose
// payloads agree with every other node's.
func (c *Cluster) Verify() error {
	payloads := make(map[int]string) // seq -> agreed payload
	for _, id := range c.ids {
		n := c.nodes[id]
		// Prefix check: delivered must be exactly 1..len in order.
		for i, m := range n.delivered {
			if m.Seq != i+1 {
				return fmt.Errorf("node %s: delivered sequence is not a prefix: got seq %d at position %d", id, m.Seq, i+1)
			}
			if prev, ok := payloads[m.Seq]; ok && prev != m.Payload {
				return fmt.Errorf("node %s: delivered payload conflict for seq %d", id, m.Seq)
			}
			payloads[m.Seq] = m.Payload
		}
		// Ack consistency check across senders.
		for seq, bySender := range n.acks {
			for from, payload := range bySender {
				if agreed, ok := payloads[seq]; ok && agreed != payload {
					return fmt.Errorf("node %s: ack from %s conflicts with delivered payload for seq %d", id, from, seq)
				}
				payloads[seq] = payload
			}
		}
	}
	return nil
}
