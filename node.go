// Package broadcastsim implements a fixed 3-node broadcast simulator with
// ordered, numbered delivery. Messages may be duplicated or arrive out of
// order; a message is delivered only after a majority of nodes have
// acknowledged it and every preceding sequence number has been delivered.
package broadcastsim

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const (
	// NodeCount is the fixed number of nodes in the cluster.
	NodeCount = 3
	// Majority is the number of acknowledgments required for delivery.
	Majority = 2
)

// Message is a broadcast payload identified by a monotonically increasing
// sequence number, starting at 1.
type Message struct {
	Seq     int    `json:"seq"`
	Payload string `json:"payload"`
}

// ackRecord is the persistent unit of acknowledgment state.
type ackRecord struct {
	From    string `json:"from"`
	Seq     int    `json:"seq"`
	Payload string `json:"payload"`
}

// ErrConflict is returned when two different payloads are seen for the same
// sequence number.
var ErrConflict = errors.New("conflicting payload for sequence number")

// Node is a single simulator node. Its acknowledgment records are appended
// to a JSON-lines log on disk so a restarted node recovers its state.
type Node struct {
	id      string
	logPath string

	acks      map[int]map[string]string // seq -> sender -> payload
	delivered []Message                 // always the prefix 1..len(delivered)
}

// NewNode creates or reloads the node with the given id, persisting its
// acknowledgment log inside dir.
func NewNode(id, dir string) (*Node, error) {
	n := &Node{
		id:      id,
		logPath: filepath.Join(dir, id+".acklog"),
		acks:    make(map[int]map[string]string),
	}
	if err := n.recover(); err != nil {
		return nil, err
	}
	return n, nil
}

// ID returns the node identifier.
func (n *Node) ID() string { return n.id }

// Delivered returns a copy of the delivered prefix, in order.
func (n *Node) Delivered() []Message {
	out := make([]Message, len(n.delivered))
	copy(out, n.delivered)
	return out
}

// recover replays the on-disk acknowledgment log, rebuilding acks and the
// delivered prefix.
func (n *Node) recover() error {
	f, err := os.Open(n.logPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()

	dec := json.NewDecoder(f)
	for {
		var rec ackRecord
		if err := dec.Decode(&rec); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("node %s: replay ack log: %w", n.id, err)
		}
		if err := n.applyAck(rec, false); err != nil {
			return fmt.Errorf("node %s: replay ack log: %w", n.id, err)
		}
	}
	return nil
}

// ReceiveMessage records this node's own acknowledgment for a broadcast
// message. Duplicates are ignored; conflicting payloads are rejected.
func (n *Node) ReceiveMessage(msg Message) error {
	return n.ReceiveAck(n.id, msg)
}

// ReceiveAck records that sender `from` acknowledged msg.
func (n *Node) ReceiveAck(from string, msg Message) error {
	return n.applyAck(ackRecord{From: from, Seq: msg.Seq, Payload: msg.Payload}, true)
}

// applyAck validates, stores and (when persist is true) logs an ack, then
// attempts delivery of the next sequence numbers.
func (n *Node) applyAck(rec ackRecord, persist bool) error {
	if rec.Seq <= 0 {
		return fmt.Errorf("node %s: invalid sequence number %d", n.id, rec.Seq)
	}
	if bySender, ok := n.acks[rec.Seq]; ok {
		for _, payload := range bySender {
			if payload != rec.Payload {
				return fmt.Errorf("node %s: seq %d: %w", n.id, rec.Seq, ErrConflict)
			}
		}
		if _, dup := bySender[rec.From]; dup {
			return nil // duplicate ack: idempotent
		}
	} else {
		n.acks[rec.Seq] = make(map[string]string)
	}

	n.acks[rec.Seq][rec.From] = rec.Payload
	if persist {
		if err := n.appendLog(rec); err != nil {
			return err
		}
	}
	n.tryDeliver()
	return nil
}

// appendLog appends one ack record to the persistent log.
func (n *Node) appendLog(rec ackRecord) error {
	f, err := os.OpenFile(n.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	return json.NewEncoder(f).Encode(rec)
}

// tryDeliver delivers every sequence number that has majority acks and whose
// predecessors are already delivered.
func (n *Node) tryDeliver() {
	for {
		next := len(n.delivered) + 1
		bySender, ok := n.acks[next]
		if !ok || len(bySender) < Majority {
			return
		}
		// All payloads for next are consistent (enforced by applyAck).
		var payload string
		for _, p := range bySender {
			payload = p
			break
		}
		n.delivered = append(n.delivered, Message{Seq: next, Payload: payload})
	}
}

// ackSenders returns the sorted set of senders that acked seq (for tests and
// verification).
func (n *Node) ackSenders(seq int) []string {
	out := make([]string, 0, len(n.acks[seq]))
	for from := range n.acks[seq] {
		out = append(out, from)
	}
	sort.Strings(out)
	return out
}
