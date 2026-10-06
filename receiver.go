package commlib

import (
	"bytes"
	"errors"
	"strconv"
	"strings"
	"sync"
)

const (
	seenPrefix      = "seen/"
	effectPrefix    = "effect/"
	appliedCountKey = "meta/applied-count"
)

// Receiver dedups deliveries by message ID and applies each message's effect
// in the same atomic batch as the dedup record, so a crash can never leave a
// dedup mark without its effect (or vice versa).
type Receiver struct {
	store Store
	mu    sync.Mutex // serializes check-and-apply for one inbox
}

func NewReceiver(store Store) *Receiver {
	return &Receiver{store: store}
}

// Receive processes one delivery. It is idempotent: redeliveries of an
// applied ID return AckDuplicate without re-applying the effect. The same ID
// carrying a different payload is rejected with AckConflict.
func (r *Receiver) Receive(msg Message) (Ack, error) {
	if msg.ID == "" {
		return Ack{}, errors.New("commlib: message ID required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	seenKey := seenPrefix + msg.ID
	if prev, ok, err := r.store.Get(seenKey); err != nil {
		return Ack{}, err
	} else if ok {
		if !bytes.Equal(prev, msg.Payload) {
			return Ack{Status: AckConflict}, nil
		}
		return Ack{Status: AckDuplicate}, nil
	}

	count := 0
	if raw, ok, err := r.store.Get(appliedCountKey); err != nil {
		return Ack{}, err
	} else if ok {
		if n, err := strconv.Atoi(string(raw)); err == nil {
			count = n
		}
	}
	count++

	// One atomic batch: dedup record + effect + applied counter. If this
	// commit fails, nothing is visible and the sender will retry.
	err := r.store.ApplyBatch([]Op{
		{Key: seenKey, Value: msg.Payload},
		{Key: effectPrefix + msg.ID, Value: msg.Payload},
		{Key: appliedCountKey, Value: []byte(strconv.Itoa(count))},
	})
	if err != nil {
		return Ack{}, err
	}
	return Ack{Status: AckOK}, nil
}

// Effects returns the applied effects keyed by message ID.
func (r *Receiver) Effects() (map[string][]byte, error) {
	keys, err := r.store.Keys()
	if err != nil {
		return nil, err
	}
	effects := make(map[string][]byte)
	for _, key := range keys {
		if !strings.HasPrefix(key, effectPrefix) {
			continue
		}
		raw, ok, err := r.store.Get(key)
		if err != nil {
			return nil, err
		}
		if ok {
			effects[strings.TrimPrefix(key, effectPrefix)] = raw
		}
	}
	return effects, nil
}

// AppliedCount reports how many effects have been committed. Under
// exactly-once semantics this equals the number of distinct message IDs.
func (r *Receiver) AppliedCount() (int, error) {
	raw, ok, err := r.store.Get(appliedCountKey)
	if err != nil || !ok {
		return 0, err
	}
	return strconv.Atoi(string(raw))
}
