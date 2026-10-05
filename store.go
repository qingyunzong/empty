// Package ptxn implements a partitioned transactional key-value store.
//
// Transactions are driven entirely by ID: Prepare binds the full read/write
// set to the ID, and Commit/Abort refer to that ID. A cross-partition
// decision (commit or abort) is appended to the WAL and fsynced BEFORE it
// becomes visible on any partition, so after a crash the decision is
// replayed and applied uniformly: a transaction is either fully committed
// everywhere or fully invisible everywhere.
//
// Keys covered by a prepared-but-undecided transaction reject reads with
// ErrPending, both before and after recovery, until an explicit decision
// arrives. The library deliberately has no timeout-based abort: a pending
// transaction stays pending until Commit or Abort is called for its ID.
package ptxn

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sync"
)

// Status is the lifecycle state of a transaction.
type Status int

const (
	StatusPrepared Status = iota
	StatusCommitted
	StatusAborted
)

func (s Status) String() string {
	switch s {
	case StatusPrepared:
		return "prepared"
	case StatusCommitted:
		return "committed"
	case StatusAborted:
		return "aborted"
	}
	return "unknown"
}

var (
	ErrTxnExists      = errors.New("ptxn: transaction ID already exists")
	ErrTxnNotFound    = errors.New("ptxn: transaction ID not found")
	ErrTxnNotPrepared = errors.New("ptxn: transaction is not in prepared state")
	ErrKeyLocked      = errors.New("ptxn: key is locked by another pending transaction")
	ErrPending        = errors.New("ptxn: key has a pending transaction; read rejected until decision")
	ErrCrashed        = errors.New("ptxn: store has crashed; reopen the directory to recover")
)

// FaultEvent identifies a point where a crash can be injected. It exists
// for fault-injection tests that exhaustively verify atomic visibility.
type FaultEvent string

const (
	FaultBeforePreparePersist FaultEvent = "beforePreparePersist"
	FaultAfterPreparePersist  FaultEvent = "afterPreparePersist"
	FaultBeforeCommitPersist  FaultEvent = "beforeCommitPersist"
	FaultAfterCommitPersist   FaultEvent = "afterCommitPersist"
	FaultCommitApplyPartition FaultEvent = "commitApplyPartition"
	FaultBeforeAbortPersist   FaultEvent = "beforeAbortPersist"
	FaultAfterAbortPersist    FaultEvent = "afterAbortPersist"
)

// crashPoint arms a one-shot crash at (event, partition). Partition is only
// meaningful for FaultCommitApplyPartition; use -1 otherwise.
type crashPoint struct {
	event     FaultEvent
	partition int
}

type txn struct {
	id     string
	reads  []string
	writes map[string]string
	status Status
}

type partition struct {
	data  map[string]string
	locks map[string]string // key -> owning transaction ID
}

// Store is a partitioned transactional key-value store backed by a WAL in dir.
type Store struct {
	mu         sync.Mutex
	wal        *wal
	partitions []partition
	txns       map[string]*txn
	crashed    bool
	crashAt    *crashPoint
}

// Open creates or recovers a store rooted at dir. On recovery the WAL is
// replayed: committed transactions are re-applied, aborted ones discarded,
// and prepared-but-undecided ones are restored as pending so their keys
// keep rejecting reads until an explicit Commit or Abort arrives.
func Open(dir string, numPartitions int) (*Store, error) {
	if numPartitions <= 0 {
		return nil, fmt.Errorf("ptxn: numPartitions must be positive, got %d", numPartitions)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	metaPath := filepath.Join(dir, "meta.json")
	type meta struct {
		Partitions int `json:"partitions"`
	}
	if b, err := os.ReadFile(metaPath); err == nil {
		var m meta
		if err := json.Unmarshal(b, &m); err != nil {
			return nil, fmt.Errorf("ptxn: read meta: %w", err)
		}
		numPartitions = m.Partitions
	} else {
		b, _ := json.Marshal(meta{Partitions: numPartitions})
		if err := os.WriteFile(metaPath, b, 0o644); err != nil {
			return nil, err
		}
	}
	w, err := openWAL(filepath.Join(dir, "wal.log"))
	if err != nil {
		return nil, err
	}
	s := &Store{
		wal:        w,
		partitions: make([]partition, numPartitions),
		txns:       make(map[string]*txn),
	}
	for i := range s.partitions {
		s.partitions[i] = partition{data: map[string]string{}, locks: map[string]string{}}
	}
	if err := s.recover(); err != nil {
		return nil, err
	}
	return s, nil
}

// Prepare binds the full read/write set to id and locks the write keys.
// The prepare record is persisted before any lock becomes observable.
func (s *Store) Prepare(id string, reads []string, writes map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLive(); err != nil {
		return err
	}
	if _, ok := s.txns[id]; ok {
		return ErrTxnExists
	}
	for k := range writes {
		if _, locked := s.partitionFor(k).locks[k]; locked {
			return ErrKeyLocked
		}
	}
	if err := s.maybeCrash(FaultBeforePreparePersist, -1); err != nil {
		return err
	}
	rec := walRecord{Type: recordPrepare, TxnID: id, Reads: reads, Writes: writes}
	if err := s.wal.append(rec); err != nil {
		return err
	}
	if err := s.maybeCrash(FaultAfterPreparePersist, -1); err != nil {
		return err
	}
	t := &txn{id: id, reads: reads, writes: writes, status: StatusPrepared}
	s.txns[id] = t
	for k := range writes {
		s.partitionFor(k).locks[k] = id
	}
	return nil
}

// Commit durably records the decision first, then applies the writes to
// every partition. Visibility therefore always follows durability.
func (s *Store) Commit(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLive(); err != nil {
		return err
	}
	t, err := s.preparedTxn(id)
	if err != nil {
		return err
	}
	if err := s.maybeCrash(FaultBeforeCommitPersist, -1); err != nil {
		return err
	}
	if err := s.wal.append(walRecord{Type: recordCommit, TxnID: id}); err != nil {
		return err
	}
	if err := s.maybeCrash(FaultAfterCommitPersist, -1); err != nil {
		return err
	}
	for i := range s.partitions {
		if err := s.maybeCrash(FaultCommitApplyPartition, i); err != nil {
			return err
		}
		s.applyToPartition(t, i)
	}
	s.finish(t, StatusCommitted)
	return nil
}

// Abort durably records the decision and releases the locks without ever
// making the writes visible.
func (s *Store) Abort(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLive(); err != nil {
		return err
	}
	t, err := s.preparedTxn(id)
	if err != nil {
		return err
	}
	if err := s.maybeCrash(FaultBeforeAbortPersist, -1); err != nil {
		return err
	}
	if err := s.wal.append(walRecord{Type: recordAbort, TxnID: id}); err != nil {
		return err
	}
	if err := s.maybeCrash(FaultAfterAbortPersist, -1); err != nil {
		return err
	}
	s.finish(t, StatusAborted)
	return nil
}

// Get returns the committed value for key. If the key is covered by a
// pending (prepared, undecided) transaction the read is rejected with
// ErrPending, before and after recovery, until a decision is recorded.
func (s *Store) Get(key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLive(); err != nil {
		return "", false, err
	}
	p := s.partitionFor(key)
	if _, locked := p.locks[key]; locked {
		return "", false, ErrPending
	}
	v, ok := p.data[key]
	return v, ok, nil
}

// Status reports the current state of transaction id.
func (s *Store) Status(id string) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkLive(); err != nil {
		return 0, err
	}
	t, ok := s.txns[id]
	if !ok {
		return 0, ErrTxnNotFound
	}
	return t.status, nil
}

// SetCrashPoint arms a one-shot crash injection at the given event.
// It exists solely for fault-injection tests; production code never calls it.
func (s *Store) SetCrashPoint(event FaultEvent, partition int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.crashAt = &crashPoint{event: event, partition: partition}
}

// Close flushes and closes the WAL.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.wal.close()
}

func (s *Store) recover() error {
	return s.wal.replay(func(rec walRecord) error {
		switch rec.Type {
		case recordPrepare:
			t := &txn{id: rec.TxnID, reads: rec.Reads, writes: rec.Writes, status: StatusPrepared}
			s.txns[t.id] = t
			for k := range rec.Writes {
				s.partitionFor(k).locks[k] = t.id
			}
		case recordCommit:
			if t, ok := s.txns[rec.TxnID]; ok && t.status == StatusPrepared {
				for i := range s.partitions {
					s.applyToPartition(t, i)
				}
				s.finish(t, StatusCommitted)
			}
		case recordAbort:
			if t, ok := s.txns[rec.TxnID]; ok && t.status == StatusPrepared {
				s.finish(t, StatusAborted)
			}
		}
		return nil
	})
}

func (s *Store) preparedTxn(id string) (*txn, error) {
	t, ok := s.txns[id]
	if !ok {
		return nil, ErrTxnNotFound
	}
	if t.status != StatusPrepared {
		return nil, ErrTxnNotPrepared
	}
	return t, nil
}

func (s *Store) applyToPartition(t *txn, i int) {
	p := &s.partitions[i]
	for k, v := range t.writes {
		if s.partitionFor(k) == p {
			p.data[k] = v
		}
	}
}

func (s *Store) finish(t *txn, st Status) {
	for k := range t.writes {
		delete(s.partitionFor(k).locks, k)
	}
	t.status = st
}

func (s *Store) partitionFor(key string) *partition {
	h := fnv.New32a()
	h.Write([]byte(key))
	return &s.partitions[int(h.Sum32())%len(s.partitions)]
}

func (s *Store) checkLive() error {
	if s.crashed {
		return ErrCrashed
	}
	return nil
}

func (s *Store) maybeCrash(event FaultEvent, partition int) error {
	if s.crashAt != nil && s.crashAt.event == event && s.crashAt.partition == partition {
		s.crashed = true
		return ErrCrashed
	}
	return nil
}
