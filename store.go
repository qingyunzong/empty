package formal

import (
	"context"
	"sort"
	"sync"
)

// MemStore is an in-memory transactional table. It is both a SnapshotSource
// and a ChangeLog, which makes it useful as a reference implementation and for
// schedule-driven verification.
//
// Uncommitted writes are private to a MemTxn. A commit atomically assigns the
// next sequence, applies all of the transaction's changes to the table, and
// appends the complete commit to the log. Readers never observe a partial
// transaction.
type MemStore struct {
	mu      sync.Mutex
	data    map[Key]Value
	commits []Commit
	hw      Seq
	nextTxn TxnID
}

var (
	_ SnapshotSource           = (*MemStore)(nil)
	_ HistoricalSnapshotSource = (*MemStore)(nil)
	_ ChangeLog                = (*MemStore)(nil)
)

// NewMemStore returns an empty store.
func NewMemStore() *MemStore {
	return &MemStore{data: make(map[Key]Value)}
}

// Begin starts a transaction. Writes become visible only at Commit.
func (s *MemStore) Begin() *MemTxn {
	s.mu.Lock()
	s.nextTxn++
	id := s.nextTxn
	s.mu.Unlock()
	return &MemTxn{store: s, id: id}
}

// HighWatermark implements ChangeLog.
func (s *MemStore) HighWatermark(ctx context.Context) (Seq, error) {
	if err := contextErr(ctx); err != nil {
		return 0, err
	}
	s.mu.Lock()
	hw := s.hw
	s.mu.Unlock()
	if err := contextErr(ctx); err != nil {
		return 0, err
	}
	return hw, nil
}

// Read implements ChangeLog. It returns commits with
// after < Seq <= through in ascending order. A page never contains duplicates;
// duplicate-replay behaviour is exercised by test wrappers.
func (s *MemStore) Read(ctx context.Context, after, through Seq, limit int) (Batch, error) {
	if err := contextErr(ctx); err != nil {
		return Batch{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if through > s.hw {
		return Batch{}, ErrFutureWatermark
	}
	if after >= through {
		return Batch{Commits: []Commit{}, Done: true}, nil
	}

	first := sort.Search(len(s.commits), func(i int) bool { return s.commits[i].Seq > after })
	last := sort.Search(len(s.commits), func(i int) bool { return s.commits[i].Seq > through })

	total := last - first
	if total <= 0 {
		return Batch{Commits: []Commit{}, Done: true}, nil
	}
	if limit > 0 && total > limit {
		last = first + limit
	}

	out := make([]Commit, 0, last-first)
	for _, cm := range s.commits[first:last] {
		out = append(out, cm.Clone())
	}
	if err := contextErr(ctx); err != nil {
		return Batch{}, err
	}
	return Batch{Commits: out, Done: last == first+total}, nil
}

// OpenSnapshot implements SnapshotSource.
func (s *MemStore) OpenSnapshot(ctx context.Context) (Snapshot, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return &memSnapshot{data: cloneValues(s.data), at: s.hw}, nil
}

// OpenSnapshotAt implements HistoricalSnapshotSource. The snapshot contains
// exactly the commits with Seq <= at.
func (s *MemStore) OpenSnapshotAt(ctx context.Context, at Seq) (Snapshot, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if at > s.hw {
		return nil, ErrFutureWatermark
	}

	data := make(map[Key]Value)
	for _, cm := range s.commits {
		if cm.Seq > at {
			break
		}
		applyChanges(data, cm.Changes)
	}
	return &memSnapshot{data: data, at: at}, nil
}

// Values returns a copy of the currently committed table.
func (s *MemStore) Values(ctx context.Context) (map[Key]Value, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	s.mu.Lock()
	out := cloneValues(s.data)
	s.mu.Unlock()
	return out, nil
}

// CommitCount returns the number of committed transactions in the log.
func (s *MemStore) CommitCount() int {
	s.mu.Lock()
	n := len(s.commits)
	s.mu.Unlock()
	return n
}

type memSnapshot struct {
	data map[Key]Value
	at   Seq
}

func (s *memSnapshot) Watermark() Seq { return s.at }

func (s *memSnapshot) Scan(ctx context.Context, visit func(Key, Value) error) error {
	keys := make([]Key, 0, len(s.data))
	for k := range s.data {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	for _, k := range keys {
		if err := contextErr(ctx); err != nil {
			return err
		}
		if err := visit(k, s.data[k]); err != nil {
			return err
		}
	}
	return nil
}

// MemTxn is an in-memory transaction. It is safe for use by one goroutine.
type MemTxn struct {
	store   *MemStore
	id      TxnID
	changes []Change
	done    bool
}

// ID returns the transaction identifier.
func (t *MemTxn) ID() TxnID { return t.id }

// Put records an insert or replacement.
func (t *MemTxn) Put(k Key, v Value) error {
	if t.done {
		return ErrTxnDone
	}
	t.changes = append(t.changes, Change{Op: OpPut, Key: k, Value: v})
	return nil
}

// Delete records a deletion.
func (t *MemTxn) Delete(k Key) error {
	if t.done {
		return ErrTxnDone
	}
	t.changes = append(t.changes, Change{Op: OpDelete, Key: k})
	return nil
}

// Commit atomically publishes the transaction and returns its commit
// sequence. A transaction with no changes does not consume a sequence; it
// returns the current high watermark.
func (t *MemTxn) Commit(ctx context.Context) (Seq, error) {
	if t.done {
		return 0, ErrTxnDone
	}
	if err := contextErr(ctx); err != nil {
		t.done = true
		return 0, err
	}

	s := t.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if t.done {
		return 0, ErrTxnDone
	}
	t.done = true
	if len(t.changes) == 0 {
		return s.hw, nil
	}

	s.hw++
	cm := Commit{
		Seq:     s.hw,
		Txn:     t.id,
		Changes: append([]Change(nil), t.changes...),
	}
	applyChanges(s.data, cm.Changes)
	s.commits = append(s.commits, cm)
	return cm.Seq, nil
}

// Rollback discards the transaction. It never appears in the log or snapshots.
func (t *MemTxn) Rollback() error {
	if t.done {
		return ErrTxnDone
	}
	t.done = true
	t.changes = nil
	return nil
}

func applyChanges(data map[Key]Value, changes []Change) {
	for _, ch := range changes {
		switch ch.Op {
		case OpPut:
			data[ch.Key] = ch.Value
		case OpDelete:
			delete(data, ch.Key)
		}
	}
}

func cloneValues(data map[Key]Value) map[Key]Value {
	out := make(map[Key]Value, len(data))
	for k, v := range data {
		out[k] = v
	}
	return out
}

func contextErr(ctx context.Context) error {
	if ctx == nil {
		return nil
	}
	return ctx.Err()
}
