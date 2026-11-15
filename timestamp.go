package dataeng

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// Timestamp is a BSON timestamp, the representation MongoDB uses for
// clusterTime. T is the number of seconds since the Unix epoch and I is the
// per-second increment. Comparing both fields is important: events in the same
// second are ordered by I.
type Timestamp struct {
	T uint32 `json:"t"`
	I uint32 `json:"i"`
}

// ClusterTime is an alias for Timestamp. It makes signatures that talk about
// MongoDB cluster time read naturally.
type ClusterTime = Timestamp

// NewTimestamp returns a BSON timestamp with the supplied seconds and
// increment.
func NewTimestamp(seconds, increment uint32) Timestamp {
	return Timestamp{T: seconds, I: increment}
}

// TimestampFromInt64 decodes the packed BSON timestamp representation.
func TimestampFromInt64(v int64) Timestamp {
	u := uint64(v)
	return Timestamp{T: uint32(u >> 32), I: uint32(u)}
}

// Int64 returns the packed BSON timestamp representation.
func (t Timestamp) Int64() int64 {
	return int64(uint64(t.T)<<32 | uint64(t.I))
}

// IsZero reports whether t is the zero timestamp.
func (t Timestamp) IsZero() bool {
	return t.T == 0 && t.I == 0
}

// Compare returns -1 if t is before other, 0 if they are equal and 1 if t is
// after other.
func (t Timestamp) Compare(other Timestamp) int {
	switch {
	case t.T < other.T:
		return -1
	case t.T > other.T:
		return 1
	case t.I < other.I:
		return -1
	case t.I > other.I:
		return 1
	default:
		return 0
	}
}

// Before reports whether t is strictly before other.
func (t Timestamp) Before(other Timestamp) bool {
	return t.Compare(other) < 0
}

// After reports whether t is strictly after other.
func (t Timestamp) After(other Timestamp) bool {
	return t.Compare(other) > 0
}

// BeforeOrEqual reports whether t is before or equal to other.
func (t Timestamp) BeforeOrEqual(other Timestamp) bool {
	return t.Compare(other) <= 0
}

// AfterOrEqual reports whether t is after or equal to other.
func (t Timestamp) AfterOrEqual(other Timestamp) bool {
	return t.Compare(other) >= 0
}

// Next returns the smallest BSON timestamp greater than t.
func (t Timestamp) Next() Timestamp {
	if t.I == ^uint32(0) {
		return Timestamp{T: t.T + 1}
	}
	return Timestamp{T: t.T, I: t.I + 1}
}

// Prev returns the largest BSON timestamp smaller than t. It returns the zero
// timestamp when t is zero.
func (t Timestamp) Prev() Timestamp {
	if t.IsZero() {
		return Timestamp{}
	}
	if t.I == 0 {
		return Timestamp{T: t.T - 1, I: ^uint32(0)}
	}
	return Timestamp{T: t.T, I: t.I - 1}
}

// String implements fmt.Stringer using MongoDB's familiar "t:i" notation.
func (t Timestamp) String() string {
	return strconv.FormatUint(uint64(t.T), 10) + ":" + strconv.FormatUint(uint64(t.I), 10)
}

// MarshalJSON encodes the timestamp as {"t":...,"i":...}.
func (t Timestamp) MarshalJSON() ([]byte, error) {
	type wire Timestamp
	return json.Marshal(wire(t))
}

// UnmarshalJSON accepts {"t":...,"i":...}, {"$timestamp":{"t":...,"i":...}}
// and a packed integer. Accepting the extended JSON form makes it possible to
// feed captured change stream documents directly into Event.
func (t *Timestamp) UnmarshalJSON(data []byte) error {
	if len(data) == 0 || string(data) == "null" {
		*t = Timestamp{}
		return nil
	}

	if data[0] != '{' {
		var packed int64
		if err := json.Unmarshal(data, &packed); err != nil {
			return fmt.Errorf("dataeng: decode timestamp: %w", err)
		}
		*t = TimestampFromInt64(packed)
		return nil
	}

	var object struct {
		T         *uint32 `json:"t"`
		I         *uint32 `json:"i"`
		Timestamp *struct {
			T *uint32 `json:"t"`
			I *uint32 `json:"i"`
		} `json:"$timestamp"`
	}
	if err := json.Unmarshal(data, &object); err != nil {
		return fmt.Errorf("dataeng: decode timestamp: %w", err)
	}
	if object.Timestamp != nil {
		if object.Timestamp.T != nil {
			object.T = object.Timestamp.T
		}
		if object.Timestamp.I != nil {
			object.I = object.Timestamp.I
		}
	}
	if object.T == nil || object.I == nil {
		return fmt.Errorf("dataeng: timestamp requires both t and i")
	}
	*t = Timestamp{T: *object.T, I: *object.I}
	return nil
}
