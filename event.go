package dataeng

import (
	"encoding/json"
	"strconv"
	"strings"
)

// Transaction carries the parts of a change stream transaction identity that
// are needed for ordering and duplicate detection. LSID is the logical session
// id, Number is the transaction number and OpIndex is the position of the
// operation inside the transaction. ID may be used instead of LSID when a
// caller has already canonicalized the identity.
type Transaction struct {
	ID      string `json:"id,omitempty"`
	LSID    string `json:"lsid,omitempty"`
	Number  int64  `json:"number,omitempty"`
	OpIndex int64  `json:"opIndex,omitempty"`
}

// IsZero reports whether t contains no transaction evidence.
func (t Transaction) IsZero() bool {
	return t.ID == "" && t.LSID == "" && t.Number == 0 && t.OpIndex == 0
}

func (t Transaction) hasEvidence() bool {
	return t.ID != "" || t.LSID != "" || t.Number != 0
}

func (t Transaction) key() string {
	if t.IsZero() {
		return ""
	}
	id := t.ID
	if id == "" {
		id = t.LSID
	}
	return strconv.Itoa(len(id)) + ":" + id +
		"|" + strconv.FormatInt(t.Number, 10) +
		"|" + strconv.FormatInt(t.OpIndex, 10)
}

// CanonicalDocumentKey serializes a document _id into the stable string form
// expected by Event.DocumentKey. Driver-specific _id types can implement
// json.Marshaler; otherwise the driver's canonical value should be used.
func CanonicalDocumentKey(id any) (string, error) {
	encoded, err := json.Marshal(id)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// Event is one normalized change stream event. ResumeToken is opaque: this
// package only compares and stores it, so tokens produced by any MongoDB
// version remain usable.
type Event struct {
	// Generation optionally identifies the generation this event belongs to.
	// Zero means "the merger's current generation". A non-zero value that is
	// older than the merger's generation is stale and is dropped.
	Generation uint64 `json:"generation,omitempty"`

	ShardID     string    `json:"shard"`
	ResumeToken string    `json:"resumeToken"`
	ClusterTime Timestamp `json:"clusterTime"`

	// DocumentKey is a canonical representation of the document's _id. It is
	// used to recognize the same logical event arriving from both the source
	// and destination shard during a chunk migration.
	DocumentKey   string `json:"documentKey,omitempty"`
	OperationType string `json:"operationType,omitempty"`
	Database      string `json:"database,omitempty"`
	Collection    string `json:"collection,omitempty"`

	Transaction *Transaction `json:"transaction,omitempty"`
	Invalidate  bool         `json:"invalidate,omitempty"`

	// Sequence is assigned by a Merger when the event is emitted. Values
	// supplied on input are ignored.
	Sequence uint64 `json:"sequence,omitempty"`
}

func (e Event) clone() Event {
	if e.Transaction != nil {
		txn := *e.Transaction
		e.Transaction = &txn
	}
	return e
}

func (e Event) transaction() Transaction {
	if e.Transaction == nil {
		return Transaction{}
	}
	return *e.Transaction
}

// Position is a total-order position in the merged sequence. Token and
// transaction identity are retained so the position can be used as a durable
// resume point even when two events share a cluster time.
type Position struct {
	Sequence      uint64      `json:"sequence"`
	Generation    uint64      `json:"generation"`
	ClusterTime   Timestamp   `json:"clusterTime"`
	ShardID       string      `json:"shard"`
	ResumeToken   string      `json:"resumeToken"`
	Transaction   Transaction `json:"transaction,omitempty"`
	OperationType string      `json:"operationType,omitempty"`
	Invalidate    bool        `json:"invalidate,omitempty"`
}

// Position returns the event's position. Sequence is set for events emitted by
// a Merger; for an input event it may be zero.
func (e Event) Position() Position {
	return Position{
		Sequence:      e.Sequence,
		Generation:    e.Generation,
		ClusterTime:   e.ClusterTime,
		ShardID:       e.ShardID,
		ResumeToken:   e.ResumeToken,
		Transaction:   e.transaction(),
		OperationType: e.OperationType,
		Invalidate:    e.Invalidate,
	}
}

// IsZero reports whether p is the zero position.
func (p Position) IsZero() bool {
	return p.Sequence == 0 &&
		p.Generation == 0 &&
		p.ClusterTime.IsZero() &&
		p.ShardID == "" &&
		p.ResumeToken == "" &&
		p.Transaction.IsZero()
}

// Less reports whether p sorts before other. A non-zero sequence is the final
// authority because a Merger has already ordered the events; otherwise the
// same tuple used by the merger is compared.
func (p Position) Less(other Position) bool {
	if p.Sequence != 0 && other.Sequence != 0 && p.Sequence != other.Sequence {
		return p.Sequence < other.Sequence
	}
	if p.Generation != other.Generation {
		return p.Generation < other.Generation
	}
	if cmp := p.ClusterTime.Compare(other.ClusterTime); cmp != 0 {
		return cmp < 0
	}
	if p.Invalidate != other.Invalidate {
		return !p.Invalidate
	}
	if p.ShardID != other.ShardID {
		return p.ShardID < other.ShardID
	}
	if p.ResumeToken != other.ResumeToken {
		return p.ResumeToken < other.ResumeToken
	}
	if pk, otherKey := p.Transaction.key(), other.Transaction.key(); pk != otherKey {
		return pk < otherKey
	}
	return p.OperationType < other.OperationType
}

func eventLess(a, b Event, aSeq, bSeq uint64) bool {
	if cmp := a.ClusterTime.Compare(b.ClusterTime); cmp != 0 {
		return cmp < 0
	}
	// At an identical cluster time, a normal event precedes the invalidate
	// that closes the generation. This keeps the generation boundary last.
	if a.Invalidate != b.Invalidate {
		return !a.Invalidate
	}
	if a.ShardID != b.ShardID {
		return a.ShardID < b.ShardID
	}
	if a.ResumeToken != b.ResumeToken {
		return a.ResumeToken < b.ResumeToken
	}
	if ak, bk := a.transaction().key(), b.transaction().key(); ak != bk {
		return ak < bk
	}
	if a.OperationType != b.OperationType {
		return a.OperationType < b.OperationType
	}
	if a.DocumentKey != b.DocumentKey {
		return a.DocumentKey < b.DocumentKey
	}
	return aSeq < bSeq
}

func normalizeEvent(e Event) Event {
	e = e.clone()
	e.ShardID = strings.TrimSpace(e.ShardID)
	e.Database = strings.TrimSpace(e.Database)
	e.Collection = strings.TrimSpace(e.Collection)
	e.OperationType = strings.TrimSpace(e.OperationType)
	if strings.EqualFold(e.OperationType, "invalidate") {
		e.Invalidate = true
	}
	e.Sequence = 0
	return e
}
