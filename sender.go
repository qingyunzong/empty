package commlib

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const outboxPrefix = "outbox/"

// Sender persists messages in a transactional outbox before transmitting
// them. A message leaves the outbox only after the receiver's ack has been
// durably recorded, so any failure simply leads to retransmission.
type Sender struct {
	outbox Store
	tx     Transport
}

func NewSender(outbox Store, tx Transport) *Sender {
	return &Sender{outbox: outbox, tx: tx}
}

// Enqueue atomically records the message in the outbox. If the write fails
// nothing is queued and the caller may retry. Re-enqueueing the same ID with
// the same payload is a no-op; a different payload is a conflict.
func (s *Sender) Enqueue(msg Message) error {
	if msg.ID == "" {
		return errors.New("commlib: message ID required")
	}
	key := outboxPrefix + msg.ID
	if raw, ok, err := s.outbox.Get(key); err != nil {
		return err
	} else if ok {
		var existing Message
		if err := json.Unmarshal(raw, &existing); err != nil {
			return err
		}
		if !bytes.Equal(existing.Payload, msg.Payload) {
			return fmt.Errorf("commlib: outbox conflict for ID %q: payload changed", msg.ID)
		}
		return nil
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return s.outbox.ApplyBatch([]Op{{Key: key, Value: raw}})
}

// PumpOnce attempts one delivery round for every pending outbox record.
// Network and persistence failures leave the record in place for the next
// round. It returns the number of records retired. A receiver conflict is
// reported as an error since it can never resolve by retrying.
func (s *Sender) PumpOnce() (int, error) {
	keys, err := s.outbox.Keys()
	if err != nil {
		return 0, err
	}
	retired := 0
	for _, key := range keys {
		if !strings.HasPrefix(key, outboxPrefix) {
			continue
		}
		raw, ok, err := s.outbox.Get(key)
		if err != nil {
			return retired, err
		}
		if !ok {
			continue // retired by a concurrent pump
		}
		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			return retired, err
		}
		ack, err := s.tx.Send(msg)
		if err != nil {
			continue // network failure: keep the record, retry next round
		}
		switch ack.Status {
		case AckOK, AckDuplicate:
			// Retire the record only after the ack. If this delete fails
			// the message is retransmitted and the receiver dedups it.
			if err := s.outbox.ApplyBatch([]Op{{Key: key, Delete: true}}); err != nil {
				continue
			}
			retired++
		case AckConflict:
			return retired, fmt.Errorf("commlib: receiver rejected ID %q: payload conflict", msg.ID)
		}
	}
	return retired, nil
}

// Pending reports how many outbox records are still awaiting an ack.
func (s *Sender) Pending() (int, error) {
	keys, err := s.outbox.Keys()
	if err != nil {
		return 0, err
	}
	n := 0
	for _, key := range keys {
		if strings.HasPrefix(key, outboxPrefix) {
			n++
		}
	}
	return n, nil
}
