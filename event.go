package dataeng

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// ErrInvalidEvent is returned when an event is malformed, for example when its
// ID is empty or its value is missing.
var ErrInvalidEvent = errors.New("dataeng: invalid event")

// ErrOutOfBounds is returned when an event references a row or column outside
// the matrix dimensions configured on the collector. One such event fails the
// entire batch and no partial state is retained from it.
var ErrOutOfBounds = errors.New("dataeng: event coordinates out of bounds")

// ErrDuplicateEvent is returned when a batch contains two different events
// that share the same event ID. Identically repeated events are accepted.
var ErrDuplicateEvent = errors.New("dataeng: conflicting events with identical ID")

// Event is a single sparse observation targeting one matrix cell.
//
// ID is the globally unique event identifier. Row and Col are zero-based
// coordinates. Value carries an arbitrary-precision integer and must be
// non-nil for value events. When Delete is true the event removes the cell
// instead of storing a value and Value is ignored.
type Event struct {
	ID     []byte
	Row    int
	Col    int
	Value  *big.Int
	Delete bool
}

// Batch is a versioned collection of events. Versions are positive integers
// starting at 1 and must form a continuous sequence at commit time.
type Batch struct {
	Version int
	Events  []Event
}

// eventOverhead approximates the fixed in-memory footprint of one event:
// the slice header plus the three integer fields, rounded conservatively.
const eventOverhead = 32

// ByteSize reports an upper-bound estimate of the bytes retained while the
// batch is buffered. It accounts for the event IDs, big-integer magnitudes and
// a fixed per-event/per-batch overhead.
func (b Batch) ByteSize() int {
	size := 16
	for _, event := range b.Events {
		size += eventOverhead + len(event.ID)
		if event.Value != nil {
			size += len(event.Value.Bytes())
		}
	}
	return size
}

// op is the reduced per-cell operation surviving after a batch is folded.
type op struct {
	id     []byte
	delete bool
	value  *big.Int
}

// reduce validates every event and folds the batch into one effective
// operation per cell. The effective event for a cell is the one with the
// lexicographically greatest event ID; values are never summed.
func (b Batch) reduce(rows, cols int) (map[[2]int]op, [32]byte, error) {
	reduced := make(map[[2]int]op, len(b.Events))
	if err := checkDuplicateIDs(b.Events); err != nil {
		return nil, [32]byte{}, err
	}

	for _, event := range b.Events {
		if len(event.ID) == 0 {
			return nil, [32]byte{}, fmt.Errorf("%w: empty event ID", ErrInvalidEvent)
		}
		if !event.Delete && event.Value == nil {
			return nil, [32]byte{}, fmt.Errorf("%w: missing value for event %q", ErrInvalidEvent, event.ID)
		}
		if event.Row < 0 || event.Row >= rows || event.Col < 0 || event.Col >= cols {
			return nil, [32]byte{}, fmt.Errorf("%w: row=%d col=%d (rows=%d cols=%d)",
				ErrOutOfBounds, event.Row, event.Col, rows, cols)
		}

		cell := [2]int{event.Row, event.Col}
		current, exists := reduced[cell]
		if !exists || bytes.Compare(event.ID, current.id) > 0 {
			candidate := op{id: append([]byte(nil), event.ID...), delete: event.Delete}
			if !event.Delete {
				candidate.value = new(big.Int).Set(event.Value)
			}
			reduced[cell] = candidate
		}
	}

	return reduced, b.digest(), nil
}

// checkDuplicateIDs rejects batches reusing an event ID for a different event.
func checkDuplicateIDs(events []Event) error {
	byID := make(map[string]Event, len(events))
	for _, event := range events {
		key := string(event.ID)
		if prior, ok := byID[key]; ok {
			if !eventsEqual(prior, event) {
				return fmt.Errorf("%w: event ID %q", ErrDuplicateEvent, event.ID)
			}
			continue
		}
		byID[key] = event
	}
	return nil
}

func eventsEqual(a, b Event) bool {
	if a.Delete != b.Delete || !bytes.Equal(a.ID, b.ID) || a.Row != b.Row || a.Col != b.Col {
		return false
	}
	if a.Delete {
		return true
	}
	return a.Value.Cmp(b.Value) == 0
}

// digest computes a canonical content hash for the batch. The events are
// serialized in a deterministic order so re-deliveries can be compared
// independently of their original slice ordering.
func (b Batch) digest() [32]byte {
	ordered := append([]Event(nil), b.Events...)
	sortEvents(ordered)

	hasher := sha256.New()
	var scratch [8]byte
	binary.BigEndian.PutUint64(scratch[:], uint64(b.Version))
	hasher.Write(scratch[:])
	for _, event := range ordered {
		binary.BigEndian.PutUint64(scratch[:], uint64(len(event.ID)))
		hasher.Write(scratch[:])
		hasher.Write(event.ID)
		binary.BigEndian.PutUint64(scratch[:], uint64(event.Row))
		hasher.Write(scratch[:])
		binary.BigEndian.PutUint64(scratch[:], uint64(event.Col))
		hasher.Write(scratch[:])
		if event.Delete {
			hasher.Write([]byte{1})
			continue
		}
		hasher.Write([]byte{0})
		magnitude := event.Value.Bytes()
		if event.Value.Sign() < 0 {
			hasher.Write([]byte{1})
		} else {
			hasher.Write([]byte{0})
		}
		binary.BigEndian.PutUint64(scratch[:], uint64(len(magnitude)))
		hasher.Write(scratch[:])
		hasher.Write(magnitude)
	}

	var digest [32]byte
	copy(digest[:], hasher.Sum(nil))
	return digest
}

// sortEvents orders events deterministically by ID first, then coordinates, so
// batches differing only in slice order still hash identically.
func sortEvents(events []Event) {
	sort.Slice(events, func(i, j int) bool {
		if cmp := bytes.Compare(events[i].ID, events[j].ID); cmp != 0 {
			return cmp < 0
		}
		if events[i].Row != events[j].Row {
			return events[i].Row < events[j].Row
		}
		return events[i].Col < events[j].Col
	})
}
