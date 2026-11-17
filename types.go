package formal

import "fmt"

// Key is a table key. The empty key is legal; it is not used as a sentinel.
type Key string

// Value is the value stored under a key. The empty value is legal.
type Value string

// Seq is a monotonic commit sequence. A transaction receives exactly one Seq
// when it commits, and every change made by that transaction carries that Seq.
//
// Seq values are ordered, not necessarily contiguous: commits for other tables
// or other index builds may consume values in the shared commit log.
type Seq uint64

// TxnID identifies a transaction.
type TxnID uint64

// Op is the kind of mutation carried by a change-log record.
type Op uint8

const (
	// OpPut inserts or replaces an index entry.
	OpPut Op = iota + 1
	// OpDelete removes an index entry. Deleting an absent key is a no-op.
	OpDelete
)

func (o Op) String() string {
	switch o {
	case OpPut:
		return "put"
	case OpDelete:
		return "delete"
	default:
		return fmt.Sprintf("op(%d)", uint8(o))
	}
}

// Change is one key mutation. Changes belonging to the same transaction are
// replayed in slice order, so a transaction that writes a key more than once
// has a deterministic final value.
type Change struct {
	Op    Op
	Key   Key
	Value Value // meaningful only when Op == OpPut
}

// Commit is an atomic, complete transaction commit as observed in the change
// log. Changes must contain every mutation of the transaction; a log reader
// must never expose a partial transaction.
type Commit struct {
	Seq     Seq
	Txn     TxnID
	Changes []Change
}

// Clone returns a deep copy of the commit. Callers may safely retain it after
// the source reuses its backing memory.
func (c Commit) Clone() Commit {
	out := c
	if c.Changes != nil {
		out.Changes = append([]Change(nil), c.Changes...)
	}
	return out
}

func (c Commit) validate() error {
	if c.Seq == 0 {
		return fmt.Errorf("%w: commit has seq 0", ErrInvalidCommit)
	}
	for i, ch := range c.Changes {
		switch ch.Op {
		case OpPut, OpDelete:
		default:
			return fmt.Errorf("%w: change %d has unknown op %d", ErrInvalidCommit, i, ch.Op)
		}
	}
	return nil
}

// Batch is one page returned by a ChangeLog.
type Batch struct {
	// Commits that have not been seen before appear in increasing Seq order.
	// The page may repeat records from this or an earlier page anywhere in the
	// slice; the coordinator ignores Seq values it has already applied.
	Commits []Commit

	// Done reports that there are no further commits in (after, through]. It is
	// the authoritative end-of-range signal; callers must not infer it from
	// len(Commits) < limit because logs may replay old records.
	Done bool
}
