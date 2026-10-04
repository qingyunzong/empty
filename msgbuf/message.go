// Package msgbuf implements a causally-ordered message buffer with a
// byte-exact memory budget.
//
// Memory is accounted in payload bytes: every message that cannot be
// delivered yet (because causal dependencies are missing) occupies
// len(Payload) bytes of the budget while it sits in the buffer. A message
// that would push usage over the budget is rejected and the receive vector
// is left untouched. Once a message is delivered its bytes are released.
package msgbuf

import "fmt"

// Key uniquely identifies a message: the sender's ID plus a per-sender
// contiguous sequence number (1-based).
type Key struct {
	From string
	Seq  uint64
}

func (k Key) String() string { return fmt.Sprintf("%s#%d", k.From, k.Seq) }

// Message is a single causally-ordered broadcast message.
//
// Deps is the sender's vector clock at send time (excluding the message
// itself): the message may only be delivered after every (from, seq) entry
// has been delivered. Per-sender FIFO is implied by the sequence numbers,
// so Deps does not need to list the sender's own earlier messages.
type Message struct {
	From    string
	Seq     uint64
	Deps    map[string]uint64
	Payload []byte
}

// ID returns the message's unique key.
func (m Message) ID() Key { return Key{From: m.From, Seq: m.Seq} }

// Size is the number of budget bytes the message occupies while buffered:
// exactly its payload length.
func (m Message) Size() int64 { return int64(len(m.Payload)) }

// clone returns a copy that does not alias the caller's maps/slices.
func (m Message) clone() Message {
	out := Message{From: m.From, Seq: m.Seq}
	if m.Deps != nil {
		out.Deps = make(map[string]uint64, len(m.Deps))
		for from, seq := range m.Deps {
			out.Deps[from] = seq
		}
	}
	if m.Payload != nil {
		out.Payload = append([]byte(nil), m.Payload...)
	}
	return out
}
