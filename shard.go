package dataeng

import (
	"fmt"
	"math/big"
	"strings"
)

// ShardID identifies a DynamoDB Streams shard.
type ShardID string

func (id ShardID) String() string { return string(id) }

// SequenceNumber is an opaque DynamoDB Streams sequence number. DynamoDB
// currently emits large decimal values, which this package can order; other
// opaque values are treated as equal only when byte-for-byte identical.
type SequenceNumber string

func (n SequenceNumber) String() string { return string(n) }

// Compare returns -1, 0, or 1 when both sequence numbers can be ordered.
// Decimal sequence numbers are compared numerically so values wider than
// uint64 are handled correctly. Values sharing a non-numeric prefix and a
// decimal suffix, such as "seq-9" and "seq-10", are also ordered. For fully
// opaque values only equality is provable and the second result is false for
// differing values.
func (n SequenceNumber) Compare(other SequenceNumber) (int, bool) {
	left, right := strings.TrimSpace(string(n)), strings.TrimSpace(string(other))
	if left == right {
		return 0, true
	}
	if left == "" || right == "" {
		return 0, false
	}
	if cmp, ok := compareDecimal(left, right); ok {
		return cmp, true
	}
	leftPrefix, leftNumber, leftSuffix := splitNumericSuffix(left)
	rightPrefix, rightNumber, rightSuffix := splitNumericSuffix(right)
	if leftSuffix && rightSuffix && leftPrefix != "" && leftPrefix == rightPrefix {
		l, _ := new(big.Int).SetString(leftNumber, 10)
		r, _ := new(big.Int).SetString(rightNumber, 10)
		return l.Cmp(r), true
	}
	return 0, false
}

// Shard is the subset of a DynamoDB Streams shard description needed to
// schedule inheritance. An empty EndingSequenceNumber means the shard is still
// open.
type Shard struct {
	ShardID                ShardID
	ParentShardID          ShardID
	AdjacentParentShardID  ShardID
	StartingSequenceNumber SequenceNumber
	EndingSequenceNumber   SequenceNumber
}

// NewShard constructs a shard description. Empty parents are ignored by the
// dependency graph.
func NewShard(
	id ShardID,
	parent ShardID,
	adjacentParent ShardID,
	start SequenceNumber,
	end SequenceNumber,
) Shard {
	return Shard{
		ShardID:                id,
		ParentShardID:          parent,
		AdjacentParentShardID:  adjacentParent,
		StartingSequenceNumber: start,
		EndingSequenceNumber:   end,
	}
}

// Closed reports whether DescribeStream supplied an ending sequence number.
func (s Shard) Closed() bool {
	return strings.TrimSpace(string(s.EndingSequenceNumber)) != ""
}

// IsClosed is an alias for Closed.
func (s Shard) IsClosed() bool { return s.Closed() }

// ParentIDs returns the distinct parent dependencies in parent-then-adjacent
// order. Empty identifiers are omitted.
func (s Shard) ParentIDs() []ShardID {
	parents := make([]ShardID, 0, 2)
	seen := make(map[ShardID]struct{}, 2)
	for _, id := range []ShardID{s.ParentShardID, s.AdjacentParentShardID} {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		parents = append(parents, id)
	}
	return parents
}

// Validate checks the invariants that do not require the rest of the graph.
func (s Shard) Validate() error {
	if strings.TrimSpace(string(s.ShardID)) == "" {
		return fmt.Errorf("dataeng: shard id is empty")
	}
	if s.ParentShardID == s.ShardID {
		return &CycleError{Path: []ShardID{s.ShardID, s.ShardID}}
	}
	if s.AdjacentParentShardID == s.ShardID {
		return &CycleError{Path: []ShardID{s.ShardID, s.ShardID}}
	}
	return nil
}

func compareDecimal(left, right string) (int, bool) {
	l, okLeft := new(big.Int).SetString(left, 10)
	r, okRight := new(big.Int).SetString(right, 10)
	if !okLeft || !okRight || l.Sign() < 0 || r.Sign() < 0 {
		return 0, false
	}
	return l.Cmp(r), true
}

func splitNumericSuffix(value string) (prefix, number string, ok bool) {
	index := len(value)
	for index > 0 {
		c := value[index-1]
		if c < '0' || c > '9' {
			break
		}
		index--
	}
	if index == len(value) {
		return "", "", false
	}
	return value[:index], value[index:], true
}
