// Package dedup implements an exactly-once message consumer. Messages
// are deduplicated by (producer ID, sequence number) with a sliding
// bitmap window that tolerates sequence gaps; messages older than the
// window are explicitly rejected as TooOld. Each accepted message's
// effect and the updated dedup state are persisted in the same atomic
// batch, so a power loss can never produce duplicate durable effects.
package dedup

// Message is one delivered message.
type Message struct {
	Producer string
	Seq      uint64
	Payload  []byte
}

// Consumer deduplicates messages and commits their effects exactly
// once. It is safe to crash at any point: after reopening from the
// same Volume, redelivered messages are deduplicated and never produce
// a second durable effect.
type Consumer struct {
	store   *Store
	effectF func(Message) []byte
}

// OpenConsumer recovers a Consumer from v. effectF computes the effect
// of an accepted message; the returned bytes are persisted in the same
// batch as the dedup state and exposed via Journal.
func OpenConsumer(v Volume, windowSize int, effectF func(Message) []byte) (*Consumer, error) {
	s, err := OpenStore(v, windowSize)
	if err != nil {
		return nil, err
	}
	return &Consumer{store: s, effectF: effectF}, nil
}

// Handle deduplicates m. For a new message it computes the effect and
// commits it together with the updated dedup window in one atomic
// batch, then returns Accepted. Duplicates and messages older than the
// dedup window are rejected without any write. If an error is
// returned, nothing was committed and the message must be redelivered.
func (c *Consumer) Handle(m Message) (Decision, error) {
	w, ok := c.store.Windows[m.Producer]
	if !ok {
		w = NewWindow(c.store.WindowSize())
	}
	w = w.Clone()
	d := w.Observe(m.Seq)
	if d != Accepted {
		return d, nil
	}
	var effect []byte
	if c.effectF != nil {
		effect = c.effectF(m)
	}
	if err := c.store.Commit(m.Producer, w, effect); err != nil {
		return Accepted, err
	}
	return Accepted, nil
}

// Seen reports whether (producer, seq) is recorded as committed.
// Sequence numbers that fell below the dedup window report false.
func (c *Consumer) Seen(producer string, seq uint64) bool {
	w, ok := c.store.Windows[producer]
	return ok && w.Seen(seq)
}

// Journal returns the committed effects in commit order.
func (c *Consumer) Journal() [][]byte {
	out := make([][]byte, len(c.store.Journal))
	for i, e := range c.store.Journal {
		out[i] = append([]byte(nil), e...)
	}
	return out
}

// Compact rewrites the log as a single snapshot record.
func (c *Consumer) Compact() error { return c.store.Compact() }
