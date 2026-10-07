package logcompact

// RecordType identifies the kind of a log record.
type RecordType uint8

const (
	BeginRecord RecordType = iota + 1
	UpdateRecord
	CommitRecord
	AbortRecord
)

func (t RecordType) String() string {
	switch t {
	case BeginRecord:
		return "Begin"
	case UpdateRecord:
		return "Update"
	case CommitRecord:
		return "Commit"
	case AbortRecord:
		return "Abort"
	default:
		return "Unknown"
	}
}

// Record is a single entry in the append-only log. LSNs are assigned
// monotonically and remain stable across compactions.
type Record struct {
	LSN     uint64
	TxnID   uint64
	Type    RecordType
	Key     string
	Value   string
	PrevLSN uint64 // previous LSN of the same transaction, 0 if none
}
