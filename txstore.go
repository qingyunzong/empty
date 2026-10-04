// Package txstore is a partitioned transactional key-value store using
// two-phase commit over durable per-partition logs plus a coordinator
// decision log.
//
// Semantics:
//   - A transaction ID is bound to its complete read/write set at Prepare.
//   - Commit/Abort reference the transaction by ID only.
//   - The cross-partition decision becomes visible uniformly: the decision
//     record is fsynced to the decision log first (the commit point), and
//     only then is it applied to the partitions. After a crash, recovery
//     replays the durable decision so readers observe either all of the
//     transaction's writes or none of them.
//   - Keys locked by a prepared-but-undecided transaction reject reads
//     (ErrPending) until a durable decision resolves them.
//   - A timeout is never treated as an abort: there is no code path that
//     resolves a transaction without an explicit Commit/Abort or a durable
//     decision replayed by recovery.
package txstore

import (
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

var (
	ErrPending    = errors.New("txstore: key locked by an undecided transaction")
	ErrNotFound   = errors.New("txstore: key not found")
	ErrLocked     = errors.New("txstore: key already locked by another transaction")
	ErrUnknownTxn = errors.New("txstore: unknown transaction ID")
	ErrTxnExists  = errors.New("txstore: transaction ID already prepared")
	ErrEmptyTxn   = errors.New("txstore: transaction ID is empty")
	ErrCrashed    = errors.New("txstore: store has crashed")
)

// Txn binds a transaction ID to its complete read/write set.
type Txn struct {
	ID     string
	Reads  []string
	Writes map[string]string
}

// crashSentinel is panicked by the test hook to simulate a power-loss crash.
type crashSentinel struct{}

type partition struct {
	data    map[string]string
	pending map[string]string // key -> txnID holding the lock
	log     *wal
}

type txnState struct {
	tx Txn
}

// Store is a partitioned transactional store. The zero value is unusable;
// construct with Open.
type Store struct {
	mu     sync.Mutex
	dir    string
	nparts int
	parts  []*partition
	decLog *wal
	txns   map[string]*txnState // prepared, not yet decided
	dead   bool                 // set after a simulated crash

	// hook, when non-nil, fires at each durability boundary (test-only).
	hook func(event string)
}

func partOfKey(key string, nparts int) int {
	h := fnv.New32a()
	h.Write([]byte(key))
	return int(h.Sum32() % uint32(nparts))
}

// Open opens (or creates) the store in dir and runs recovery: every
// transaction left prepared-but-unresolved by a crash is finished according
// to the durable decision log. A transaction with no durable decision is
// aborted — safe, because the commit point (a fsynced decision record) was
// never reached. Open returns only after recovery is complete, so no reader
// can observe a partially applied transaction.
func Open(dir string, nparts int) (*Store, error) {
	if nparts < 1 {
		return nil, fmt.Errorf("txstore: nparts must be >= 1")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, nparts: nparts, txns: make(map[string]*txnState)}

	decisions := make(map[string]string)
	decRecs, err := readWAL(filepath.Join(dir, "decisions.log"))
	if err != nil {
		return nil, err
	}
	for _, r := range decRecs {
		if r.Type == recDecision {
			decisions[r.TxnID] = r.Decision
		}
	}
	if s.decLog, err = openWAL(filepath.Join(dir, "decisions.log")); err != nil {
		return nil, err
	}

	preps := make([]map[string]record, nparts)  // per partition: txnID -> prepare record
	resolved := make([]map[string]bool, nparts) // per partition: txnID -> commit/abort applied
	for i := 0; i < nparts; i++ {
		path := filepath.Join(dir, fmt.Sprintf("part-%d.log", i))
		recs, err := readWAL(path)
		if err != nil {
			return nil, err
		}
		p := &partition{data: make(map[string]string), pending: make(map[string]string)}
		preps[i] = make(map[string]record)
		resolved[i] = make(map[string]bool)
		for _, r := range recs {
			switch r.Type {
			case recPrepare:
				preps[i][r.TxnID] = r
			case recCommit:
				if pr, ok := preps[i][r.TxnID]; ok {
					for k, v := range pr.Writes {
						p.data[k] = v
					}
				}
				resolved[i][r.TxnID] = true
			case recAbort:
				resolved[i][r.TxnID] = true
			}
		}
		if p.log, err = openWAL(path); err != nil {
			return nil, err
		}
		s.parts = append(s.parts, p)
	}

	// Recovery pass: finish every transaction that is prepared but not
	// resolved on some partition.
	pending := make(map[string][]int) // txnID -> partitions still unresolved
	for i := 0; i < nparts; i++ {
		for id := range preps[i] {
			if !resolved[i][id] {
				pending[id] = append(pending[id], i)
			}
		}
	}
	for _, id := range sortedKeysOfString(pending) {
		dec, ok := decisions[id]
		if !ok {
			// No durable decision exists, so the commit point was never
			// reached: aborting cannot contradict anything a client saw.
			// The abort itself is persisted before it takes effect.
			dec = decideAbort
			if err := s.decLog.append(record{Type: recDecision, TxnID: id, Decision: dec}); err != nil {
				return nil, err
			}
		}
		for _, pi := range pending[id] {
			if err := s.applyDecision(pi, id, dec, preps[pi][id]); err != nil {
				return nil, err
			}
		}
	}
	return s, nil
}

// applyDecision persists the outcome to one partition's log and applies it
// to that partition's in-memory state.
func (s *Store) applyDecision(pi int, id, dec string, prep record) error {
	p := s.parts[pi]
	switch dec {
	case decideCommit:
		if err := p.log.append(record{Type: recCommit, TxnID: id}); err != nil {
			return err
		}
		for k, v := range prep.Writes {
			p.data[k] = v
			delete(p.pending, k)
		}
	default:
		if err := p.log.append(record{Type: recAbort, TxnID: id}); err != nil {
			return err
		}
		for k := range prep.Writes {
			delete(p.pending, k)
		}
	}
	return nil
}

// Prepare binds the transaction ID to its complete read/write set and
// durably prepares every involved partition. Prepared keys reject reads
// (ErrPending) until a durable decision resolves them.
func (s *Store) Prepare(tx Txn) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.protect()
	if err := s.alive(); err != nil {
		return err
	}
	if tx.ID == "" {
		return ErrEmptyTxn
	}
	if _, ok := s.txns[tx.ID]; ok {
		return ErrTxnExists
	}
	groups := make(map[int]map[string]string)
	for k, v := range tx.Writes {
		pi := partOfKey(k, s.nparts)
		if _, locked := s.parts[pi].pending[k]; locked {
			return ErrLocked
		}
		if groups[pi] == nil {
			groups[pi] = make(map[string]string)
		}
		groups[pi][k] = v
	}
	s.fire("begin")
	for _, pi := range sortedKeys(groups) {
		rec := record{Type: recPrepare, TxnID: tx.ID, Reads: tx.Reads, Writes: groups[pi]}
		if err := s.parts[pi].log.append(rec); err != nil {
			return err
		}
		s.fire(fmt.Sprintf("prepare-%d", pi))
	}
	for pi, ws := range groups {
		for k := range ws {
			s.parts[pi].pending[k] = tx.ID
		}
	}
	s.txns[tx.ID] = &txnState{tx: tx}
	return nil
}

// Commit durably records the commit decision and then applies it to every
// involved partition. The writes become visible only after the decision
// record is durable, and then uniformly across partitions.
func (s *Store) Commit(id string) error {
	return s.decide(id, decideCommit)
}

// Abort durably records the abort decision and rolls the transaction back on
// every involved partition.
func (s *Store) Abort(id string) error {
	return s.decide(id, decideAbort)
}

func (s *Store) decide(id, dec string) (err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	defer s.protect()
	if err := s.alive(); err != nil {
		return err
	}
	st, ok := s.txns[id]
	if !ok {
		return ErrUnknownTxn
	}
	// Commit point: the decision is durable before anything becomes visible.
	if err := s.decLog.append(record{Type: recDecision, TxnID: id, Decision: dec}); err != nil {
		return err
	}
	s.fire("decision")
	groups := make(map[int]map[string]string)
	for k, v := range st.tx.Writes {
		pi := partOfKey(k, s.nparts)
		if groups[pi] == nil {
			groups[pi] = make(map[string]string)
		}
		groups[pi][k] = v
	}
	for _, pi := range sortedKeys(groups) {
		p := s.parts[pi]
		recType := recAbort
		if dec == decideCommit {
			recType = recCommit
		}
		if err := p.log.append(record{Type: recType, TxnID: id}); err != nil {
			return err
		}
		s.fire(fmt.Sprintf("apply-%d", pi))
		if dec == decideCommit {
			for k, v := range groups[pi] {
				p.data[k] = v
			}
		}
		for k := range groups[pi] {
			delete(p.pending, k)
		}
	}
	delete(s.txns, id)
	return nil
}

// Get returns the committed value for key. A key locked by an undecided
// transaction rejects the read with ErrPending — before recovery resolves
// the transaction, its writes are neither visible nor readable.
func (s *Store) Get(key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.alive(); err != nil {
		return "", err
	}
	p := s.parts[partOfKey(key, s.nparts)]
	if _, ok := p.pending[key]; ok {
		return "", ErrPending
	}
	v, ok := p.data[key]
	if !ok {
		return "", ErrNotFound
	}
	return v, nil
}

// Close flushes and closes the logs. The store must not be used afterwards.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var first error
	for _, p := range s.parts {
		if err := p.log.close(); err != nil && first == nil {
			first = err
		}
	}
	if s.decLog != nil {
		if err := s.decLog.close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Store) alive() error {
	if s.dead {
		return ErrCrashed
	}
	return nil
}

func (s *Store) fire(event string) {
	if s.hook != nil {
		s.hook(event)
	}
}

// protect converts a simulated crash into a permanently dead store, then
// re-panics so the caller's goroutine dies like a real process would.
func (s *Store) protect() {
	if r := recover(); r != nil {
		if _, ok := r.(crashSentinel); ok {
			s.dead = true
		}
		panic(r)
	}
}

func sortedKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

func sortedKeysOfString(m map[string][]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
