// Package dataeng ingests batched collector logs on top of an importable
// append-only log.
//
// A batch is accepted as a whole or rejected as a whole. Every epoch owns a
// contiguous sequence starting at 0; a conflicting digest at the current
// sequence seals that epoch, while a later epoch seals every smaller one.
package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"

	"example.org/dataeng13/q0417/appendlog"
)

// Sentinel errors returned by Ingester.Submit.
var (
	// ErrEmptyBatch is returned when a batch carries no records.
	ErrEmptyBatch = errors.New("dataeng: empty batch")
	// ErrMixedEpoch is returned when one batch contains several epochs.
	ErrMixedEpoch = errors.New("dataeng: mixed epochs in batch")
	// ErrSealedEpoch is returned for any submission targeting a sealed epoch.
	ErrSealedEpoch = errors.New("dataeng: epoch is sealed")
	// ErrStaleEpoch is returned when the epoch is smaller than the greatest
	// epoch already recorded.
	ErrStaleEpoch = errors.New("dataeng: epoch is older than the current epoch")
	// ErrOutOfOrder is returned when a sequence is not the expected next value
	// for the epoch.
	ErrOutOfOrder = errors.New("dataeng: sequence gap or out-of-order sequence")
	// ErrInvalidRecord is returned when a record is malformed.
	ErrInvalidRecord = errors.New("dataeng: invalid record")
	// ErrDigestConflict is returned when an existing sequence is resubmitted
	// with a different digest. The epoch is sealed as a side effect.
	ErrDigestConflict = errors.New("dataeng: digest conflict seals the epoch")
)

// Record is one submitted log record.
type Record struct {
	Epoch  int
	Seq    int
	Digest string
}

// Ingester applies ingestion rules and persists outcomes to an append log.
type Ingester struct {
	mu sync.Mutex

	log appendlog.Log

	// digests maps epoch -> sequence -> accepted digest.
	digests map[int]map[int]string
	// maxSeq maps an epoch that already holds records to its top sequence.
	maxSeq map[int]int
	// sealed tracks sealed epochs.
	sealed map[int]bool
	// greatest is the largest epoch ever recorded.
	greatest int
}

// NewIngester builds an Ingester over log and replays its contents so the
// in-memory state matches durable history.
func NewIngester(log appendlog.Log) (*Ingester, error) {
	ing := &Ingester{
		log:      log,
		digests:  make(map[int]map[int]string),
		maxSeq:   make(map[int]int),
		sealed:   make(map[int]bool),
		greatest: -1,
	}
	frames, err := log.Read()
	if err != nil {
		return nil, fmt.Errorf("dataeng: replay log: %w", err)
	}
	for _, frame := range frames {
		var entry logEntry
		if err := json.Unmarshal(frame, &entry); err != nil {
			return nil, fmt.Errorf("dataeng: corrupt log entry: %w", err)
		}
		ing.applyEntry(entry)
	}
	return ing, nil
}

// logEntry is the durable representation of one state change.
type logEntry struct {
	Kind   string `json:"kind"`
	Epoch  int    `json:"epoch"`
	Seq    int    `json:"seq,omitempty"`
	Digest string `json:"digest,omitempty"`
}

// applyEntry folds one replayed log entry into in-memory state.
func (ing *Ingester) applyEntry(entry logEntry) {
	switch entry.Kind {
	case "seal":
		ing.sealed[entry.Epoch] = true
		if entry.Epoch > ing.greatest {
			ing.greatest = entry.Epoch
		}
	case "record":
		if ing.digests[entry.Epoch] == nil {
			ing.digests[entry.Epoch] = make(map[int]string)
		}
		ing.digests[entry.Epoch][entry.Seq] = entry.Digest
		if top, ok := ing.maxSeq[entry.Epoch]; !ok || entry.Seq > top {
			ing.maxSeq[entry.Epoch] = entry.Seq
		}
		if entry.Epoch > ing.greatest {
			ing.greatest = entry.Epoch
		}
	}
}

// Submit validates and persists one batch.
//
// On success every non-duplicate record is appended and the number of newly
// appended records is returned. On failure no record is appended; a digest
// conflict additionally seals the batch's epoch.
func (ing *Ingester) Submit(batch []Record) (appended int, err error) {
	ing.mu.Lock()
	defer ing.mu.Unlock()

	if len(batch) == 0 {
		return 0, ErrEmptyBatch
	}

	epoch := batch[0].Epoch
	for _, rec := range batch {
		if rec.Epoch != epoch {
			return 0, ErrMixedEpoch
		}
		if rec.Epoch < 0 || rec.Seq < 0 || rec.Digest == "" {
			return 0, ErrInvalidRecord
		}
	}

	if epoch < ing.greatest {
		return 0, ErrStaleEpoch
	}
	if ing.sealed[epoch] {
		return 0, ErrSealedEpoch
	}

	// Simulate the batch against a copy of the epoch's accepted sequences so a
	// rejection never mutates state outside the explicit conflict sealing.
	view := map[int]string{}
	for seq, digest := range ing.digests[epoch] {
		view[seq] = digest
	}
	top, started := ing.maxSeq[epoch]

	var accepted []Record
	for _, rec := range batch {
		if existing, ok := view[rec.Seq]; ok {
			if existing == rec.Digest {
				// Idempotent duplicate: nothing to append.
				continue
			}
			if err := ing.persistSeal(epoch); err != nil {
				return 0, err
			}
			return 0, ErrDigestConflict
		}
		expected := 0
		if started {
			expected = top + 1
		}
		if rec.Seq != expected {
			return 0, ErrOutOfOrder
		}
		view[rec.Seq] = rec.Digest
		top = rec.Seq
		started = true
		accepted = append(accepted, rec)
	}

	if len(accepted) == 0 {
		return 0, nil
	}

	var entries []appendlog.Entry
	if epoch > ing.greatest {
		// Promoting a new epoch seals every known smaller epoch first.
		var smaller []int
		for older := range ing.digests {
			if older < epoch && !ing.sealed[older] {
				smaller = append(smaller, older)
			}
		}
		sort.Ints(smaller)
		for _, older := range smaller {
			entries = append(entries, mustSealEntry(older))
		}
	}
	for _, rec := range accepted {
		entries = append(entries, mustRecordEntry(rec))
	}

	// One atomic call: the whole batch lands or nothing does.
	if err := ing.log.Append(entries); err != nil {
		return 0, fmt.Errorf("dataeng: append batch: %w", err)
	}

	if epoch > ing.greatest {
		for older := range ing.digests {
			if older < epoch {
				ing.sealed[older] = true
			}
		}
		ing.greatest = epoch
	}
	if ing.digests[epoch] == nil {
		ing.digests[epoch] = make(map[int]string)
	}
	for _, rec := range accepted {
		ing.digests[epoch][rec.Seq] = rec.Digest
		if current, ok := ing.maxSeq[epoch]; !ok || rec.Seq > current {
			ing.maxSeq[epoch] = rec.Seq
		}
	}
	return len(accepted), nil
}

// persistSeal appends only the seal marker. Previously accepted records stay
// in the log; the failed batch itself appends nothing.
func (ing *Ingester) persistSeal(epoch int) error {
	if err := ing.log.Append([]appendlog.Entry{mustSealEntry(epoch)}); err != nil {
		return fmt.Errorf("dataeng: persist seal: %w", err)
	}
	ing.sealed[epoch] = true
	return nil
}

func mustRecordEntry(rec Record) appendlog.Entry {
	frame, err := json.Marshal(logEntry{
		Kind:   "record",
		Epoch:  rec.Epoch,
		Seq:    rec.Seq,
		Digest: rec.Digest,
	})
	if err != nil {
		panic(err)
	}
	return appendlog.Entry{Data: frame}
}

func mustSealEntry(epoch int) appendlog.Entry {
	frame, err := json.Marshal(logEntry{Kind: "seal", Epoch: epoch})
	if err != nil {
		panic(err)
	}
	return appendlog.Entry{Data: frame}
}

// IsSealed reports whether epoch is sealed.
func (ing *Ingester) IsSealed(epoch int) bool {
	ing.mu.Lock()
	defer ing.mu.Unlock()
	return ing.sealed[epoch]
}

// GreatestEpoch returns the largest epoch ever recorded, or -1 if none.
func (ing *Ingester) GreatestEpoch() int {
	ing.mu.Lock()
	defer ing.mu.Unlock()
	return ing.greatest
}

// StoredDigest returns the accepted digest for a sequence and whether it exists.
func (ing *Ingester) StoredDigest(epoch, seq int) (string, bool) {
	ing.mu.Lock()
	defer ing.mu.Unlock()
	digest, ok := ing.digests[epoch][seq]
	return digest, ok
}

// MaxSeq returns the top accepted sequence for an epoch and whether it exists.
func (ing *Ingester) MaxSeq(epoch int) (int, bool) {
	ing.mu.Lock()
	defer ing.mu.Unlock()
	seq, ok := ing.maxSeq[epoch]
	return seq, ok
}
