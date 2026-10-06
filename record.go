// Package logcompact implements MVCC-style log compaction to a target commit
// version, preserving records required by pending-transaction recovery and by
// active snapshot readers, with a generational reader registry that rejects
// stale (ABA) releases.
package logcompact

// Kind is the type of a log record.
type Kind int

const (
	Begin Kind = iota
	Write
	Commit
	Abort
)

func (k Kind) String() string {
	switch k {
	case Begin:
		return "begin"
	case Write:
		return "write"
	case Commit:
		return "commit"
	case Abort:
		return "abort"
	}
	return "unknown"
}

// Record is a single log entry. Version is the commit version; it is set on
// Commit records when the record is appended, and is resolved onto Write
// records of committed transactions in the compacted output so the compacted
// log is self-contained.
type Record struct {
	LSN     uint64
	TxnID   uint64
	Kind    Kind
	Key     string
	Value   string
	Version uint64
}
