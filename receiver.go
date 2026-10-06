package comm

import (
	"fmt"
	"strconv"
)

const (
	dedupPrefix  = "dedup/"
	effectPrefix = "effect/"
	logPrefix    = "log/"
	logLenKey    = "loglen"
)

// Receiver deduplicates by message ID and writes the dedup record, the
// business effect, and the effect journal in one atomic batch, so a
// retried delivery can never apply its effect twice.
type Receiver struct {
	store Store
}

func NewReceiver(store Store) *Receiver {
	return &Receiver{store: store}
}

// Receive handles one delivery. A transient store failure is returned as
// an error so the sender retries; a payload conflict for a known ID is a
// permanent rejection reported in the ack.
func (r *Receiver) Receive(msg Message) (Ack, error) {
	if existing, ok := r.store.Get(dedupPrefix + msg.ID); ok {
		if existing == msg.Payload {
			// Ack was lost or the sender retried: do not re-apply.
			return Ack{ID: msg.ID, Status: AckDuplicate}, nil
		}
		return Ack{ID: msg.ID, Status: AckRejected}, nil
	}

	n := r.logLen()
	err := r.store.Apply(Batch{Puts: map[string]string{
		dedupPrefix + msg.ID:        msg.Payload,
		effectPrefix + msg.ID:       msg.Payload,
		logPrefix + strconv.Itoa(n): msg.ID,
		logLenKey:                   strconv.Itoa(n + 1),
	}})
	if err != nil {
		// Nothing was persisted; the sender will retry the delivery.
		return Ack{}, fmt.Errorf("receive %s: %w", msg.ID, err)
	}
	return Ack{ID: msg.ID, Status: AckApplied}, nil
}

// Effect returns the applied effect for an ID, if any.
func (r *Receiver) Effect(id string) (string, bool) {
	return r.store.Get(effectPrefix + id)
}

// EffectLog returns the IDs whose effects were applied, in apply order.
// Exactly-once means every accepted ID appears here exactly once.
func (r *Receiver) EffectLog() []string {
	n := r.logLen()
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id, _ := r.store.Get(logPrefix + strconv.Itoa(i))
		out = append(out, id)
	}
	return out
}

func (r *Receiver) logLen() int {
	v, ok := r.store.Get(logLenKey)
	if !ok {
		return 0
	}
	n, _ := strconv.Atoi(v)
	return n
}
