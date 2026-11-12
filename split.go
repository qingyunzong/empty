// Package dataeng plans how the Cartesian product of heavy join keys is
// distributed over a fixed number of worker slots before an equi-join runs.
package dataeng

import (
	"fmt"
	"sort"
)

// Maximum number of distinct keys accepted by the planner.
const MaxKeys = 64

// maxSlots is the largest legal number of worker slots.
const maxSlots = 128

// maxCount is the largest accepted row count for one side of one key.
const maxCount = 1_000_000_000_000

// FailureCode explains why a plan could not be produced.
type FailureCode string

const (
	// InvalidInput means the request itself is malformed.
	InvalidInput FailureCode = "invalid_input"
	// KeyInfeasible means at least one key that needs slots has no (r, s)
	// choice satisfying the per-cell row-pair budget.
	KeyInfeasible FailureCode = "key_infeasible"
	// BudgetExceeded means every key is feasible in isolation but no
	// combination of choices fits inside the global slot budget.
	BudgetExceeded FailureCode = "budget_exceeded"
)

// Failure is the structured reason returned when no plan exists. It is never
// a partial plan.
type Failure struct {
	Code    FailureCode
	Message string
	// Key is the offending join key. It is empty for failures that are not
	// tied to a particular key.
	Key string
}

func (f *Failure) Error() string {
	if f.Key != "" {
		return fmt.Sprintf("%s: %s (key=%q)", f.Code, f.Message, f.Key)
	}
	return fmt.Sprintf("%s: %s", f.Code, f.Message)
}

// KeyCount gives the number of rows of one relation for one join key.
type KeyCount struct {
	Key   string
	Count int64
}

// Request describes the heavy-key splitting problem.
type Request struct {
	// Left and Right hold per-key row counts. Each key may appear at most
	// once on a side; counts must be non-negative.
	Left  []KeyCount
	Right []KeyCount
	// Slots is the number P of worker slots, between 1 and 128.
	Slots int
	// MaxPairs is the per-cell worst-case row-pair budget B.
	MaxPairs int64
}

// KeySplit is the chosen (r, s) shape for one join key together with the
// contiguous slot range assigned to that key.
type KeySplit struct {
	Key       string
	R         int // number of left buckets, 1 <= R <= left row count
	S         int // number of right buckets, 1 <= S <= right row count
	Cells     int // R * S, the number of slots owned by this key
	SlotStart int // global slot index of cell (0, 0)
}

// Plan is a complete, globally optimal splitting plan.
type Plan struct {
	Splits []KeySplit
	// TotalTransferredRows is sum(L*s + R*r), the primary objective.
	TotalTransferredRows int64
	// TotalCells is sum(r*s), never larger than the requested slot budget.
	TotalCells int

	// Unexported per-key counts used by the routing and verification APIs.
	leftCount  map[string]int64
	rightCount map[string]int64
	slots      int
	maxPairs   int64
}

// option is one feasible (r, s) choice for a key.
type option struct {
	r        int
	s        int
	cells    int
	transfer int64
}

// keySide collects the merged per-key input counts.
type keySide struct {
	key     string
	left    int64
	right   int64
	options []option
}

// dpState is one reachable "number of slots used" state of the dynamic
// program after processing a prefix of the join keys. Rather than copying the
// whole chosen sequence at every transition, each layer keeps back-pointers;
// the final sequence is reconstructed once from the winning state.
type dpState struct {
	transfer  int64
	reachable bool
	prevUsed  int // predecessor's used-cell count in the previous layer
	optionIdx int // option index chosen for the key that produced this state
}

// PlanSplit computes the globally optimal splitting plan. If no plan exists it
// returns a *Failure and a nil plan; it never returns a partial plan.
func PlanSplit(req Request) (*Plan, error) {
	if err := validate(req); err != nil {
		return nil, err
	}

	sides := mergeKeys(req)

	active := make([]*keySide, 0, len(sides))
	for i := range sides {
		side := &sides[i]
		if side.left == 0 || side.right == 0 {
			continue
		}
		side.options = enumerateOptions(side.left, side.right, int64(req.Slots), req.MaxPairs)
		if len(side.options) == 0 {
			return nil, &Failure{
				Code:    KeyInfeasible,
				Message: "no (r, s) choice keeps the worst-case cell row pairs within the budget",
				Key:     side.key,
			}
		}
		active = append(active, side)
	}

	choices, totalCells, totalTransfer, err := solveDP(active, req.Slots)
	if err != nil {
		return nil, err
	}

	return buildPlan(active, choices, totalCells, totalTransfer, req), nil
}

func validate(req Request) error {
	if req.Slots < 1 || req.Slots > maxSlots {
		return &Failure{
			Code:    InvalidInput,
			Message: fmt.Sprintf("slots must be between 1 and %d, got %d", maxSlots, req.Slots),
		}
	}
	if req.MaxPairs < 1 {
		return &Failure{
			Code:    InvalidInput,
			Message: "max row pairs per cell must be a positive integer",
		}
	}
	if len(req.Left) > MaxKeys || len(req.Right) > MaxKeys {
		return &Failure{
			Code:    InvalidInput,
			Message: fmt.Sprintf("each side may contain at most %d keys", MaxKeys),
		}
	}
	if err := validateSide(req.Left, "left"); err != nil {
		return err
	}
	return validateSide(req.Right, "right")
}

func validateSide(rows []KeyCount, side string) error {
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		if row.Count < 0 {
			return &Failure{
				Code:    InvalidInput,
				Message: fmt.Sprintf("%s side row count for key %q is negative", side, row.Key),
				Key:     row.Key,
			}
		}
		if row.Count > maxCount {
			return &Failure{
				Code:    InvalidInput,
				Message: fmt.Sprintf("%s side row count for key %q exceeds %d", side, row.Key, maxCount),
				Key:     row.Key,
			}
		}
		if _, dup := seen[row.Key]; dup {
			return &Failure{
				Code:    InvalidInput,
				Message: fmt.Sprintf("key %q appears more than once on the %s side", row.Key, side),
				Key:     row.Key,
			}
		}
		seen[row.Key] = struct{}{}
	}
	return nil
}

// mergeKeys joins both sides into one UTF-8 byte-ordered slice. A key missing
// on one side gets a count of zero there.
func mergeKeys(req Request) []keySide {
	union := make(map[string]*keySide, len(req.Left)+len(req.Right))
	for _, row := range req.Left {
		side := getOrCreate(union, row.Key)
		side.left = row.Count
	}
	for _, row := range req.Right {
		side := getOrCreate(union, row.Key)
		side.right = row.Count
	}

	keys := make([]string, 0, len(union))
	for key := range union {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	merged := make([]keySide, 0, len(keys))
	for _, key := range keys {
		merged = append(merged, *union[key])
	}
	return merged
}

func getOrCreate(union map[string]*keySide, key string) *keySide {
	if side, ok := union[key]; ok {
		return side
	}
	side := &keySide{key: key}
	union[key] = side
	return side
}

// productOverflows reports whether a*b cannot be represented exactly as int64.
func productOverflows(a, b int64) bool {
	if a <= 0 || b <= 0 {
		return false
	}
	return a > (1<<63-1)/b
}

// ceilDiv returns ceil(a/b) for positive b without overflowing.
func ceilDiv(a, b int64) int64 {
	return (a + b - 1) / b
}

// enumerateOptions returns every feasible (r, s) choice, pruned to the best
// choice for each distinct cell count r*s. All arithmetic stays inside int64.
func enumerateOptions(left, right, slots, maxPairs int64) []option {
	maxR := int64Min(left, slots)
	maxS := int64Min(right, slots)

	// Cell counts range over 1..slots, so a fixed array is enough and avoids
	// map overhead in this hottest function.
	bestByCells := make([]option, slots+1)
	cellSeen := make([]bool, slots+1)
	leftCeil := make([]int64, maxR+1)
	rightCeil := make([]int64, maxS+1)
	for r := int64(1); r <= maxR; r++ {
		leftCeil[r] = ceilDiv(left, r)
	}
	for s := int64(1); s <= maxS; s++ {
		rightCeil[s] = ceilDiv(right, s)
	}

	for r := int64(1); r <= maxR; r++ {
		leftPerCell := leftCeil[r]
		for s := int64(1); s <= maxS; s++ {
			// r*s must not exceed the slot budget. Division keeps the check
			// exact even when the product would overflow machine integers.
			if r > slots/s {
				continue
			}
			rightPerCell := rightCeil[s]
			// Each ceil factor is at most 1e12, so their product can
			// overflow; compare through division instead of multiplying.
			if productOverflows(leftPerCell, rightPerCell) ||
				leftPerCell*rightPerCell > maxPairs {
				continue
			}

			cells := int(r * s)
			transfer := left*s + right*r
			candidate := option{
				r:        int(r),
				s:        int(s),
				cells:    cells,
				transfer: transfer,
			}
			if !cellSeen[cells] || betterOption(candidate, bestByCells[cells]) {
				bestByCells[cells] = candidate
				cellSeen[cells] = true
			}
		}
	}

	options := make([]option, 0, slots)
	for cells := 1; cells <= int(slots); cells++ {
		if !cellSeen[cells] {
			continue
		}
		options = append(options, bestByCells[cells])
	}
	return options
}

// betterOption orders choices sharing a cell count: minimum transferred rows,
// then lexicographically smallest (r, s).
func betterOption(a, b option) bool {
	if a.transfer != b.transfer {
		return a.transfer < b.transfer
	}
	if a.r != b.r {
		return a.r < b.r
	}
	return a.s < b.s
}

func int64Min(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

// solveDP finds the globally optimal option choice per key under the slot
// budget. The optimization order is: minimum total transferred rows, then
// minimum total cells, then lexicographically smallest (r, s) sequence.
func solveDP(keys []*keySide, slots int) ([]int, int, int64, error) {
	if len(keys) == 0 {
		return nil, 0, 0, nil
	}

	// All layers share one backing array: back-pointers reference previous
	// layers and must survive the whole run, while zero-value states are
	// unreachable until explicitly populated.
	backing := make([]dpState, (len(keys)+1)*(slots+1))
	layerStride := slots + 1
	layers := make([][]dpState, len(keys)+1)
	for i := range layers {
		layers[i] = backing[i*layerStride : (i+1)*layerStride]
	}
	layers[0][0].reachable = true

	for keyIdx, key := range keys {
		next := layers[keyIdx+1]

		for used := 0; used <= slots; used++ {
			state := &layers[keyIdx][used]
			if !state.reachable {
				continue
			}
			for optIdx, opt := range key.options {
				newUsed := used + opt.cells
				if newUsed > slots {
					break // options are ordered by ascending cell count
				}
				candidate := dpState{
					transfer:  state.transfer + opt.transfer,
					reachable: true,
					prevUsed:  used,
					optionIdx: optIdx,
				}
				if !next[newUsed].reachable ||
					betterState(key, candidate, next[newUsed]) {
					next[newUsed] = candidate
				}
			}
		}
	}

	dp := layers[len(keys)]
	best := -1
	for used := 1; used <= slots; used++ {
		if !dp[used].reachable {
			continue
		}
		if best == -1 || dp[used].transfer < dp[best].transfer ||
			(dp[used].transfer == dp[best].transfer && used < best) {
			best = used
		}
	}
	if best == -1 {
		return nil, 0, 0, &Failure{
			Code:    BudgetExceeded,
			Message: "every key is feasible alone but the combined cell count exceeds the slot budget",
		}
	}

	// Reconstruct the chosen option per key by walking the back-pointers.
	choices := make([]int, len(keys))
	used := best
	for keyIdx := len(keys) - 1; keyIdx >= 0; keyIdx-- {
		state := layers[keyIdx+1][used]
		choices[keyIdx] = state.optionIdx
		used = state.prevUsed
	}
	return choices, best, dp[best].transfer, nil
}

// betterState applies the global objective ordering between two reachable
// states that land on the same used-cell count in the same layer. The cell
// count is equal by construction, so ties break on the (r, s) chosen for the
// current key, which is exactly the first differing position of the two
// sequences because their prefixes reach the same predecessor cell count only
// when the predecessor objective ordering already selected the best prefix.
func betterState(key *keySide, a, b dpState) bool {
	if a.transfer != b.transfer {
		return a.transfer < b.transfer
	}
	ao := key.options[a.optionIdx]
	bo := key.options[b.optionIdx]
	if ao.r != bo.r {
		return ao.r < bo.r
	}
	return ao.s < bo.s
}
