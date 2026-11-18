package formal

import (
	"context"
	"fmt"
	"sync"
)

// Sink receives committed transactions. Implementations must make Apply
// idempotent for a transaction: after a crash between the external effect and
// the durable acknowledgement, recovery calls Apply again with the same
// TxnID, CommitSeq, and payload.
//
// Apply must also be atomic with respect to the supplied Records. If Apply
// returns an error, the coordinator treats the delivery as not acknowledged
// and retries it in commit order.
type Sink interface {
	Apply(context.Context, Delivery) error
}

// SinkFunc adapts a function to Sink.
type SinkFunc func(context.Context, Delivery) error

// Apply implements Sink.
func (f SinkFunc) Apply(ctx context.Context, delivery Delivery) error {
	return f(ctx, delivery)
}

// MemorySink is an idempotent in-memory sink useful for tests and as a
// reference implementation of the deduplication contract.
type MemorySink struct {
	mu      sync.Mutex
	byTxn   map[TxnID]Delivery
	order   []TxnID
	records []OutputRecord
	owners  map[string]TxnID
}

// NewMemorySink returns an empty idempotent sink.
func NewMemorySink() *MemorySink {
	return &MemorySink{
		byTxn:  make(map[TxnID]Delivery),
		owners: make(map[string]TxnID),
	}
}

// Apply accepts a delivery once. A byte-for-byte retry is a no-op; a different
// payload for the same transaction is rejected with ErrConflict.
func (s *MemorySink) Apply(ctx context.Context, delivery Delivery) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if delivery.TxnID == "" {
		return ErrInvalidTxnID
	}
	delivery = Delivery{
		TxnID:     delivery.TxnID,
		CommitSeq: delivery.CommitSeq,
		Digest:    delivery.Digest,
		Records:   cloneRecords(delivery.Records),
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.byTxn == nil {
		s.byTxn = make(map[TxnID]Delivery)
	}
	if s.owners == nil {
		s.owners = make(map[string]TxnID)
	}
	if previous, ok := s.byTxn[delivery.TxnID]; ok {
		if previous.CommitSeq != delivery.CommitSeq ||
			previous.Digest != delivery.Digest ||
			!equalRecords(previous.Records, delivery.Records) {
			return fmt.Errorf("%w: transaction %q", ErrConflict, delivery.TxnID)
		}
		return nil
	}
	if err := validateRecords(delivery.Records); err != nil {
		return err
	}
	for _, record := range delivery.Records {
		if record.ID == "" {
			continue
		}
		if owner, exists := s.owners[record.ID]; exists && owner != delivery.TxnID {
			return fmt.Errorf("%w: %q is owned by %q", ErrRecordConflict, record.ID, owner)
		}
	}

	s.byTxn[delivery.TxnID] = delivery
	s.order = append(s.order, delivery.TxnID)
	for _, record := range delivery.Records {
		if record.ID != "" {
			s.owners[record.ID] = delivery.TxnID
		}
		s.records = append(s.records, OutputRecord{
			TxnID:     delivery.TxnID,
			CommitSeq: delivery.CommitSeq,
			Record:    record.Clone(),
		})
	}
	return nil
}

// Deliveries returns accepted transactions in delivery order.
func (s *MemorySink) Deliveries() []Delivery {
	s.mu.Lock()
	defer s.mu.Unlock()
	deliveries := make([]Delivery, 0, len(s.order))
	for _, id := range s.order {
		delivery := s.byTxn[id]
		delivery.Records = cloneRecords(delivery.Records)
		deliveries = append(deliveries, delivery)
	}
	return deliveries
}

// Records returns accepted output records in delivery order.
func (s *MemorySink) Records() []OutputRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	records := make([]OutputRecord, len(s.records))
	for i, record := range s.records {
		records[i] = OutputRecord{
			TxnID:     record.TxnID,
			CommitSeq: record.CommitSeq,
			Record:    record.Record.Clone(),
		}
	}
	return records
}

// Len returns the number of distinct delivered transactions.
func (s *MemorySink) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.order)
}

// Delivered reports whether the transaction was accepted and returns its
// stored delivery.
func (s *MemorySink) Delivered(id TxnID) (Delivery, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delivery, ok := s.byTxn[id]
	if !ok {
		return Delivery{}, false
	}
	delivery.Records = cloneRecords(delivery.Records)
	return delivery, true
}
