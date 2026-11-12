package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"math/bits"
	"sort"
	"strings"
)

// MaxRecords is the maximum number of records on either side of a match.
const MaxRecords = 18

// Sentinel sorts after every valid UTF-8 ID. It is used in RightForLeft for
// an unmatched left record. IDs are assumed to be valid UTF-8.
const Sentinel = "\xff"

// UnmatchedSentinel is an alias for Sentinel.
const UnmatchedSentinel = Sentinel

var (
	// ErrTooManyRecords reports a side containing more than MaxRecords IDs.
	ErrTooManyRecords = errors.New("dataeng: too many records")
	// ErrDuplicateID reports a repeated ID on one side.
	ErrDuplicateID = errors.New("dataeng: duplicate record ID")
	// ErrUnknownID reports a candidate edge naming an unknown record.
	ErrUnknownID = errors.New("dataeng: candidate names unknown record")
	// ErrDuplicateEdge reports the same left/right candidate more than once.
	ErrDuplicateEdge = errors.New("dataeng: duplicate candidate edge")
	// ErrNegativeCost reports a candidate with a negative cost.
	ErrNegativeCost = errors.New("dataeng: negative candidate cost")
	// ErrInvalidCost reports a candidate cost that is not a non-negative integer.
	ErrInvalidCost = errors.New("dataeng: invalid candidate cost")
)

// Candidate is a caller-supplied edge between a left and a right record.
//
// Cost accepts arbitrary-precision non-negative integers. Supported dynamic
// types are *big.Int, big.Int, string, json.Number, all signed and unsigned
// integer types, and fmt.Stringer values whose String method returns a base-10
// integer.
type Candidate struct {
	LeftID  string
	RightID string
	Cost    any
}

// Edge is an alias for Candidate.
type Edge = Candidate

// Pair is one matched left/right pair. Cost is the candidate cost of the edge.
type Pair struct {
	LeftID  string
	RightID string
	Cost    *big.Int
}

// MatchedPair is an alias for Pair.
type MatchedPair = Pair

// Result is the exact optimal matching.
//
// Matches contains the matched pairs in ascending left-ID byte order.
// UnmatchedLeft and UnmatchedRight contain the unmatched IDs in ascending
// byte order. RightForLeft has one entry per left record, in ascending left-ID
// order: either the matched right ID or Sentinel. TotalCost is the sum of the
// matched edge costs.
type Result struct {
	Matches        []Pair
	UnmatchedLeft  []string
	UnmatchedRight []string
	TotalCost      *big.Int
	RightForLeft   []string
}

// Match returns a maximum-cardinality, minimum-cost matching. Ties are broken
// lexicographically by the right IDs corresponding to ascending left IDs, with
// Sentinel standing in for an unmatched left record.
func Match(leftIDs, rightIDs []string, candidates []Candidate) (Result, error) {
	left, right, edgesByLeft, edgeCosts, err := normalize(leftIDs, rightIDs, candidates)
	if err != nil {
		return Result{}, err
	}
	return solve(left, right, edgesByLeft, edgeCosts), nil
}

// Solve is an alias for Match.
func Solve(leftIDs, rightIDs []string, candidates []Candidate) (Result, error) {
	return Match(leftIDs, rightIDs, candidates)
}

// MatchRecords is an alias for Match.
func MatchRecords(leftIDs, rightIDs []string, candidates []Candidate) (Result, error) {
	return Match(leftIDs, rightIDs, candidates)
}

// PairRecords is an alias for Match.
func PairRecords(leftIDs, rightIDs []string, candidates []Candidate) (Result, error) {
	return Match(leftIDs, rightIDs, candidates)
}

// TotalCostString returns TotalCost as a base-10 integer.
func (r Result) TotalCostString() string {
	if r.TotalCost == nil {
		return "0"
	}
	return r.TotalCost.String()
}

// MatchCount returns the number of matched pairs.
func (r Result) MatchCount() int {
	return len(r.Matches)
}

type parsedEdge struct {
	right int
	cost  *big.Int
}

func normalize(leftIDs, rightIDs []string, candidates []Candidate) (
	left, right []string,
	edgesByLeft [][]parsedEdge,
	edgeCosts [][]*big.Int,
	err error,
) {
	if len(leftIDs) > MaxRecords {
		return nil, nil, nil, nil, fmt.Errorf("%w: left side has %d records", ErrTooManyRecords, len(leftIDs))
	}
	if len(rightIDs) > MaxRecords {
		return nil, nil, nil, nil, fmt.Errorf("%w: right side has %d records", ErrTooManyRecords, len(rightIDs))
	}

	left = append([]string(nil), leftIDs...)
	right = append([]string(nil), rightIDs...)
	sort.Strings(left)
	sort.Strings(right)

	leftIndex := make(map[string]int, len(left))
	for i, id := range left {
		if _, exists := leftIndex[id]; exists {
			return nil, nil, nil, nil, fmt.Errorf("%w: left ID %q", ErrDuplicateID, id)
		}
		leftIndex[id] = i
	}
	rightIndex := make(map[string]int, len(right))
	for i, id := range right {
		if _, exists := rightIndex[id]; exists {
			return nil, nil, nil, nil, fmt.Errorf("%w: right ID %q", ErrDuplicateID, id)
		}
		rightIndex[id] = i
	}

	edgesByLeft = make([][]parsedEdge, len(left))
	edgeCosts = make([][]*big.Int, len(left))
	for i := range edgeCosts {
		edgeCosts[i] = make([]*big.Int, len(right))
	}

	seen := make(map[uint32]struct{}, len(candidates))
	for _, candidate := range candidates {
		li, ok := leftIndex[candidate.LeftID]
		if !ok {
			return nil, nil, nil, nil, fmt.Errorf("%w: left ID %q", ErrUnknownID, candidate.LeftID)
		}
		ri, ok := rightIndex[candidate.RightID]
		if !ok {
			return nil, nil, nil, nil, fmt.Errorf("%w: right ID %q", ErrUnknownID, candidate.RightID)
		}

		key := uint32(li)<<5 | uint32(ri)
		if _, exists := seen[key]; exists {
			return nil, nil, nil, nil, fmt.Errorf("%w: (%q, %q)", ErrDuplicateEdge, candidate.LeftID, candidate.RightID)
		}
		seen[key] = struct{}{}

		cost, costErr := parseCost(candidate.Cost)
		if costErr != nil {
			return nil, nil, nil, nil, costErr
		}
		edgesByLeft[li] = append(edgesByLeft[li], parsedEdge{right: ri, cost: cost})
		edgeCosts[li][ri] = cost
	}
	return left, right, edgesByLeft, edgeCosts, nil
}

func parseCost(value any) (*big.Int, error) {
	var cost *big.Int
	switch v := value.(type) {
	case nil:
		return nil, fmt.Errorf("%w: nil", ErrInvalidCost)
	case *big.Int:
		if v == nil {
			return nil, fmt.Errorf("%w: nil", ErrInvalidCost)
		}
		cost = new(big.Int).Set(v)
	case big.Int:
		cost = new(big.Int).Set(&v)
	case string:
		parsed, err := parseCostText(v)
		if err != nil {
			return nil, err
		}
		cost = parsed
	case json.Number:
		parsed, err := parseCostText(v.String())
		if err != nil {
			return nil, err
		}
		cost = parsed
	case int:
		return costFromInt64(int64(v))
	case int8:
		return costFromInt64(int64(v))
	case int16:
		return costFromInt64(int64(v))
	case int32:
		return costFromInt64(int64(v))
	case int64:
		return costFromInt64(v)
	case uint:
		return costFromUint64(uint64(v))
	case uint8:
		return costFromUint64(uint64(v))
	case uint16:
		return costFromUint64(uint64(v))
	case uint32:
		return costFromUint64(uint64(v))
	case uint64:
		return costFromUint64(v)
	case uintptr:
		return costFromUint64(uint64(v))
	case fmt.Stringer:
		parsed, err := parseCostText(v.String())
		if err != nil {
			return nil, err
		}
		cost = parsed
	default:
		return nil, fmt.Errorf("%w: unsupported type %T", ErrInvalidCost, value)
	}
	if cost.Sign() < 0 {
		return nil, fmt.Errorf("%w: %s", ErrNegativeCost, cost)
	}
	return cost, nil
}

func parseCostText(text string) (*big.Int, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("%w: empty string", ErrInvalidCost)
	}
	cost, ok := new(big.Int).SetString(text, 10)
	if !ok {
		return nil, fmt.Errorf("%w: %q is not a base-10 integer", ErrInvalidCost, text)
	}
	if cost.Sign() < 0 {
		return nil, fmt.Errorf("%w: %s", ErrNegativeCost, cost)
	}
	return cost, nil
}

func costFromInt64(value int64) (*big.Int, error) {
	if value < 0 {
		return nil, fmt.Errorf("%w: %d", ErrNegativeCost, value)
	}
	return new(big.Int).SetInt64(value), nil
}

func costFromUint64(value uint64) (*big.Int, error) {
	return new(big.Int).SetUint64(value), nil
}

const assignmentSentinel uint8 = 0xff

type assignment [MaxRecords]uint8

func sentinelAssignment() assignment {
	var a assignment
	for i := range a {
		a[i] = assignmentSentinel
	}
	return a
}

func assignmentLess(a, b assignment) bool {
	for i := 0; i < MaxRecords; i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return false
}

func solve(
	left, right []string,
	edgesByLeft [][]parsedEdge,
	edgeCosts [][]*big.Int,
) Result {
	rightCount := len(right)
	stateCount := 1 << rightCount

	currentCost := make([]*big.Int, stateCount)
	currentAssignment := make([]assignment, stateCount)
	currentCost[0] = new(big.Int)
	currentAssignment[0] = sentinelAssignment()

	var candidateCost big.Int
	for li := 0; li < len(left); li++ {
		nextCost := make([]*big.Int, stateCount)
		nextAssignment := make([]assignment, stateCount)
		copy(nextCost, currentCost)
		copy(nextAssignment, currentAssignment)

		for _, edge := range edgesByLeft[li] {
			bit := 1 << edge.right
			for mask := 0; mask < stateCount; mask++ {
				if mask&bit != 0 {
					continue
				}
				base := currentCost[mask]
				if base == nil {
					continue
				}
				newMask := mask | bit
				candidateCost.Add(base, edge.cost)

				old := nextCost[newMask]
				better := old == nil
				if !better {
					cmp := candidateCost.Cmp(old)
					better = cmp < 0
					if cmp == 0 {
						candidateAssignment := currentAssignment[mask]
						candidateAssignment[li] = uint8(edge.right)
						better = assignmentLess(candidateAssignment, nextAssignment[newMask])
					}
				}
				if better {
					nextCost[newMask] = new(big.Int).Set(&candidateCost)
					candidateAssignment := currentAssignment[mask]
					candidateAssignment[li] = uint8(edge.right)
					nextAssignment[newMask] = candidateAssignment
				}
			}
		}
		currentCost = nextCost
		currentAssignment = nextAssignment
	}

	bestMask := 0
	bestCount := 0
	bestCost := currentCost[0]
	bestAssignment := currentAssignment[0]
	for mask, cost := range currentCost {
		if cost == nil {
			continue
		}
		count := bits.OnesCount(uint(mask))
		if bestCost == nil || count > bestCount {
			bestMask, bestCount, bestCost, bestAssignment = mask, count, cost, currentAssignment[mask]
			continue
		}
		if count != bestCount {
			continue
		}
		cmp := cost.Cmp(bestCost)
		if cmp < 0 || (cmp == 0 && assignmentLess(currentAssignment[mask], bestAssignment)) {
			bestMask, bestCost, bestAssignment = mask, cost, currentAssignment[mask]
		}
	}

	result := Result{
		TotalCost: new(big.Int).Set(bestCost),
	}
	if len(left) > 0 {
		result.Matches = make([]Pair, 0, bestCount)
		result.UnmatchedLeft = make([]string, 0, len(left)-bestCount)
		result.RightForLeft = make([]string, 0, len(left))
	}
	if len(right) > bestCount {
		result.UnmatchedRight = make([]string, 0, len(right)-bestCount)
	}

	for li, leftID := range left {
		ri := bestAssignment[li]
		if ri == assignmentSentinel {
			result.UnmatchedLeft = append(result.UnmatchedLeft, leftID)
			result.RightForLeft = append(result.RightForLeft, Sentinel)
			continue
		}
		rightID := right[ri]
		result.Matches = append(result.Matches, Pair{
			LeftID:  leftID,
			RightID: rightID,
			Cost:    new(big.Int).Set(edgeCosts[li][ri]),
		})
		result.RightForLeft = append(result.RightForLeft, rightID)
	}
	for ri, rightID := range right {
		if bestMask&(1<<ri) == 0 {
			result.UnmatchedRight = append(result.UnmatchedRight, rightID)
		}
	}
	return result
}
