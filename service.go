// Package q147 implements a cross-shard transaction intake layer for a
// database capture service. It ingests Begin markers, per-shard sequenced
// changes, per-shard seals and global commit records, and hands complete
// transactions to a subscriber atomically and in commit order. Delivery is
// acknowledged only after the subscriber has persisted the transaction, and
// a WAL-style log store allows unacknowledged transactions to be
// re-delivered (with unchanged transaction IDs) after a restart.
package q147

import (
	"fmt"
	"sort"
	"sync"
)

// TxnID identifies a global transaction. It stays stable across restarts
// and re-deliveries.
type TxnID string

// ShardID identifies a shard within the captured database.
type ShardID string

// Change is a single mutation belonging to a transaction, identified by its
// per-shard sequence number. Sequence numbers are assigned per shard across
// all transactions (interleaved transactions share the shard's sequence
// space), start at 1, and must be gap-free up to a transaction's committed
// last sequence number for the transaction to become deliverable.
type Change struct {
	Shard ShardID
	Seq   uint64
	Data  []byte
}

// Transaction is the atomic unit handed to subscribers. Changes are ordered
// by shard, then by per-shard sequence number.
type Transaction struct {
	ID      TxnID
	Changes []Change
}

// Subscriber receives complete transactions in commit order. Apply must
// persist the transaction and return nil only once the data is durable; any
// non-nil error (or a crash before the acknowledgement is logged) causes
// the transaction to be re-delivered later with the same ID.
type Subscriber interface {
	Apply(txn Transaction) error
}

// RecordKind enumerates the entries stored in the WAL.
type RecordKind int

const (
	RecordBegin RecordKind = iota + 1
	RecordChange
	RecordSeal
	RecordCommit
	RecordAck
)

// Record is a single WAL entry. Only the fields relevant to Kind are set.
type Record struct {
	Kind RecordKind
	Txn  TxnID
	// Change records.
	Shard ShardID
	Seq   uint64
	Data  []byte
	// Commit records: participating shards and their last sequence numbers.
	Shards map[ShardID]uint64
}

// LogStore is the injectable write-ahead log. Every ingested event is
// appended before it is applied in memory, and every subscriber
// acknowledgement is appended before the checkpoint advances.
type LogStore interface {
	Append(rec Record) error
	Replay(fn func(rec Record) error) error
}

type txnState struct {
	begun   bool
	changes map[ShardID]map[uint64][]byte
	commit  map[ShardID]uint64
}

func (t *txnState) transaction() Transaction {
	var txn Transaction
	shards := make([]ShardID, 0, len(t.commit))
	for shard := range t.commit {
		shards = append(shards, shard)
	}
	sort.Slice(shards, func(i, j int) bool { return shards[i] < shards[j] })
	for _, shard := range shards {
		seqs := t.changes[shard]
		for seq := uint64(1); seq <= t.commit[shard]; seq++ {
			data, ok := seqs[seq]
			if !ok {
				continue
			}
			txn.Changes = append(txn.Changes, Change{
				Shard: shard,
				Seq:   seq,
				Data:  data,
			})
		}
	}
	return txn
}

// Service is the cross-shard transaction intake layer. It is safe for
// concurrent use; the subscriber is invoked synchronously, in commit order,
// from whichever goroutine completes a transaction.
type Service struct {
	mu     sync.Mutex
	log    LogStore
	sub    Subscriber
	txns   map[TxnID]*txnState
	seals  map[ShardID]uint64
	seen   map[ShardID]map[uint64]bool // received change sequences per shard
	contig map[ShardID]uint64          // gap-free received prefix per shard
	order  []TxnID                     // commit order
	next   int                         // index into order of the first unacknowledged transaction
}

// Open creates a Service over the given log store and subscriber, replays
// the log to rebuild in-memory state, and re-delivers any transactions that
// were complete but not yet acknowledged. Acknowledged transactions are
// never re-delivered.
func Open(log LogStore, sub Subscriber) (*Service, error) {
	if sub == nil {
		return nil, fmt.Errorf("q147: subscriber must not be nil")
	}
	s := &Service{
		log:    log,
		sub:    sub,
		txns:   make(map[TxnID]*txnState),
		seals:  make(map[ShardID]uint64),
		seen:   make(map[ShardID]map[uint64]bool),
		contig: make(map[ShardID]uint64),
	}
	if log != nil {
		err := log.Replay(func(rec Record) error {
			s.apply(rec)
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("q147: replay log: %w", err)
		}
	}
	s.mu.Lock()
	s.deliver()
	s.mu.Unlock()
	return s, nil
}

// Begin records the start of a transaction. It is idempotent.
func (s *Service) Begin(id TxnID) error {
	return s.ingest(Record{Kind: RecordBegin, Txn: id})
}

// AddChange records one sequenced change of a transaction. Re-sending the
// same (transaction, shard, sequence) triple is a no-op.
func (s *Service) AddChange(id TxnID, shard ShardID, seq uint64, data []byte) error {
	if seq == 0 {
		return fmt.Errorf("q147: sequence numbers start at 1")
	}
	return s.ingest(Record{Kind: RecordChange, Txn: id, Shard: shard, Seq: seq, Data: data})
}

// SealShard records that the shard will not produce further changes with
// sequence numbers at or below seq. Seals are monotonic; a lower or equal
// seal is ignored.
func (s *Service) SealShard(shard ShardID, seq uint64) error {
	return s.ingest(Record{Kind: RecordSeal, Shard: shard, Seq: seq})
}

// Commit records the global commit of a transaction, listing the
// participating shards and each shard's last sequence number. Re-sending an
// identical commit is a no-op; a conflicting commit for the same
// transaction ID is rejected.
func (s *Service) Commit(id TxnID, shards map[ShardID]uint64) error {
	s.mu.Lock()
	if st, ok := s.txns[id]; ok && st.commit != nil && !equalShards(st.commit, shards) {
		s.mu.Unlock()
		return fmt.Errorf("q147: conflicting commit for transaction %q", id)
	}
	s.mu.Unlock()
	return s.ingest(Record{Kind: RecordCommit, Txn: id, Shards: cloneShards(shards)})
}

// Checkpoint returns the number of transactions acknowledged by the
// subscriber, i.e. the prefix of the commit order that is durable
// downstream and will never be re-delivered.
func (s *Service) Checkpoint() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.next
}

// Flush retries delivery of complete but unacknowledged transactions, e.g.
// after the subscriber recovered from a transient error.
func (s *Service) Flush() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deliver()
}

func (s *Service) ingest(rec Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.log != nil {
		if err := s.log.Append(rec); err != nil {
			return fmt.Errorf("q147: append log: %w", err)
		}
	}
	s.apply(rec)
	s.deliver()
	return nil
}

// apply mutates in-memory state from a record. Callers must hold s.mu (or
// be in single-threaded replay).
func (s *Service) apply(rec Record) {
	switch rec.Kind {
	case RecordBegin:
		s.state(rec.Txn).begun = true
	case RecordChange:
		st := s.state(rec.Txn)
		seqs := st.changes[rec.Shard]
		if seqs == nil {
			seqs = make(map[uint64][]byte)
			st.changes[rec.Shard] = seqs
		}
		if _, dup := seqs[rec.Seq]; !dup {
			seqs[rec.Seq] = rec.Data
		}
		seen := s.seen[rec.Shard]
		if seen == nil {
			seen = make(map[uint64]bool)
			s.seen[rec.Shard] = seen
		}
		if !seen[rec.Seq] {
			seen[rec.Seq] = true
			for w := s.contig[rec.Shard] + 1; seen[w]; w++ {
				s.contig[rec.Shard] = w
			}
		}
	case RecordSeal:
		if rec.Seq > s.seals[rec.Shard] {
			s.seals[rec.Shard] = rec.Seq
		}
	case RecordCommit:
		st := s.state(rec.Txn)
		if st.commit == nil {
			st.commit = rec.Shards
			s.order = append(s.order, rec.Txn)
		}
	case RecordAck:
		if s.next < len(s.order) && s.order[s.next] == rec.Txn {
			s.next++
		}
	}
}

// deliver hands every complete, unacknowledged transaction to the
// subscriber in commit order. It stops at the first incomplete transaction
// or delivery failure; the checkpoint only advances past transactions whose
// acknowledgement has been logged. Callers must hold s.mu.
func (s *Service) deliver() {
	for s.next < len(s.order) {
		id := s.order[s.next]
		st := s.txns[id]
		if !s.ready(st) {
			return
		}
		txn := st.transaction()
		txn.ID = id
		if err := s.sub.Apply(txn); err != nil {
			return
		}
		if s.log != nil {
			if err := s.log.Append(Record{Kind: RecordAck, Txn: id}); err != nil {
				// The subscriber persisted the transaction but the
				// acknowledgement is not durable: leave the checkpoint
				// in place so the transaction is re-delivered (with the
				// same ID) after recovery.
				return
			}
		}
		s.next++
	}
}

// ready reports whether the transaction is complete: it has a commit
// record, and every listed shard is sealed at or beyond its committed last
// sequence number with the shard's change stream gap-free up to that point.
// Callers must hold s.mu.
func (s *Service) ready(st *txnState) bool {
	if st.commit == nil {
		return false
	}
	for shard, last := range st.commit {
		if s.seals[shard] < last || s.contig[shard] < last {
			return false
		}
	}
	return true
}

func (s *Service) state(id TxnID) *txnState {
	st, ok := s.txns[id]
	if !ok {
		st = &txnState{changes: make(map[ShardID]map[uint64][]byte)}
		s.txns[id] = st
	}
	return st
}

func equalShards(a, b map[ShardID]uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for shard, last := range a {
		if b[shard] != last {
			return false
		}
	}
	return true
}

func cloneShards(in map[ShardID]uint64) map[ShardID]uint64 {
	out := make(map[ShardID]uint64, len(in))
	for shard, last := range in {
		out[shard] = last
	}
	return out
}
