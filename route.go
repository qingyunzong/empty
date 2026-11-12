package dataeng

import (
	"errors"
	"fmt"
)

// exhaustivePairCap bounds how many same-key record pairs Verify enumerates
// directly. Plans above the cap are still validated structurally.
const exhaustivePairCap = 2_000_000

func buildPlan(keys []*keySide, choices []int, totalCells int, totalTransfer int64, req Request) *Plan {
	splits := make([]KeySplit, 0, len(keys))
	leftCount := make(map[string]int64, len(keys))
	rightCount := make(map[string]int64, len(keys))

	slotStart := 0
	for idx, key := range keys {
		opt := key.options[choices[idx]]
		splits = append(splits, KeySplit{
			Key:       key.key,
			R:         opt.r,
			S:         opt.s,
			Cells:     opt.cells,
			SlotStart: slotStart,
		})
		leftCount[key.key] = key.left
		rightCount[key.key] = key.right
		slotStart += opt.cells
	}

	return &Plan{
		Splits:               splits,
		TotalTransferredRows: totalTransfer,
		TotalCells:           totalCells,
		leftCount:            leftCount,
		rightCount:           rightCount,
		slots:                req.Slots,
		maxPairs:             req.MaxPairs,
	}
}

func (p *Plan) split(key string) (KeySplit, bool) {
	for _, split := range p.Splits {
		if split.Key == key {
			return split, true
		}
	}
	return KeySplit{}, false
}

// RouteLeft returns the global slots that must receive left-side row rowNumber
// for key. The stable row number must be in [0, leftRowCount). The returned
// slots are sorted ascending and contain exactly S entries.
func (p *Plan) RouteLeft(key string, rowNumber int64) ([]int, error) {
	split, ok := p.split(key)
	if !ok {
		return nil, fmt.Errorf("key %q has no assigned cells", key)
	}
	count := p.leftCount[key]
	if rowNumber < 0 || rowNumber >= count {
		return nil, fmt.Errorf("left row number %d out of range [0, %d) for key %q", rowNumber, count, key)
	}

	bucket := int(rowNumber % int64(split.R))
	slots := make([]int, 0, split.S)
	for rightBucket := 0; rightBucket < split.S; rightBucket++ {
		slots = append(slots, split.SlotStart+bucket*split.S+rightBucket)
	}
	return slots, nil
}

// RouteRight returns the global slots that must receive right-side row
// rowNumber for key. The stable row number must be in [0, rightRowCount).
// The returned slots are sorted ascending and contain exactly R entries.
func (p *Plan) RouteRight(key string, rowNumber int64) ([]int, error) {
	split, ok := p.split(key)
	if !ok {
		return nil, fmt.Errorf("key %q has no assigned cells", key)
	}
	count := p.rightCount[key]
	if rowNumber < 0 || rowNumber >= count {
		return nil, fmt.Errorf("right row number %d out of range [0, %d) for key %q", rowNumber, count, key)
	}

	bucket := int(rowNumber % int64(split.S))
	slots := make([]int, 0, split.R)
	for leftBucket := 0; leftBucket < split.R; leftBucket++ {
		slots = append(slots, split.SlotStart+leftBucket*split.S+bucket)
	}
	return slots, nil
}

// Verify checks the plan's invariants and, when the number of record pairs is
// small enough, enumerates every same-key pair to prove the pair meets in
// exactly one shared slot. It returns nil when the plan is valid.
func (p *Plan) Verify() error {
	if p == nil {
		return errors.New("nil plan")
	}

	seenRanges := make(map[int]struct{})
	nextStart := 0
	for _, split := range p.Splits {
		left := p.leftCount[split.Key]
		right := p.rightCount[split.Key]

		if split.R < 1 || split.R > int(left) {
			return fmt.Errorf("key %q: r=%d outside [1, %d]", split.Key, split.R, left)
		}
		if split.S < 1 || split.S > int(right) {
			return fmt.Errorf("key %q: s=%d outside [1, %d]", split.Key, split.S, right)
		}
		if split.Cells != split.R*split.S {
			return fmt.Errorf("key %q: cells %d != r*s %d", split.Key, split.Cells, split.R*split.S)
		}
		if split.SlotStart != nextStart {
			return fmt.Errorf("key %q: slot range starts at %d, expected %d", split.Key, split.SlotStart, nextStart)
		}
		end := split.SlotStart + split.Cells
		if end > p.slots {
			return fmt.Errorf("key %q: slot range exceeds the %d slot budget", split.Key, p.slots)
		}
		for slot := split.SlotStart; slot < end; slot++ {
			if _, dup := seenRanges[slot]; dup {
				return fmt.Errorf("slot %d assigned to multiple keys", slot)
			}
			seenRanges[slot] = struct{}{}
		}
		nextStart = end

		worstLeft := ceilDiv(left, int64(split.R))
		worstRight := ceilDiv(right, int64(split.S))
		if productOverflows(worstLeft, worstRight) || worstLeft*worstRight > p.maxPairs {
			return fmt.Errorf("key %q: worst-case cell pairs exceed budget", split.Key)
		}

		// Only enumerate actual rows when the full pair space is small;
		// larger plans rely on the structural invariants checked above.
		if !productOverflows(left, right) && left*right <= exhaustivePairCap {
			if err := verifyRoutingPartitions(split, left, right); err != nil {
				return err
			}
			if err := verifyEveryPairMeetsOnce(split, left, right); err != nil {
				return err
			}
		}
	}

	if p.TotalCells != len(seenRanges) {
		return fmt.Errorf("total cells %d does not match assigned slots %d", p.TotalCells, len(seenRanges))
	}
	return nil
}

// verifyRoutingPartitions confirms bucket assignment partitions every row and
// that routed slots stay inside the key's owned slot range.
func verifyRoutingPartitions(split KeySplit, left, right int64) error {
	leftBuckets := make([]bool, split.R)
	for row := int64(0); row < left; row++ {
		slots, err := routeLeftOf(split, row)
		if err != nil {
			return err
		}
		if len(slots) != split.S {
			return fmt.Errorf("key %q: left row %d routed to %d slots, want %d", split.Key, row, len(slots), split.S)
		}
		leftBuckets[int(row%int64(split.R))] = true
		for _, slot := range slots {
			if slot < split.SlotStart || slot >= split.SlotStart+split.Cells {
				return fmt.Errorf("key %q: routed slot %d outside owned range", split.Key, slot)
			}
		}
	}
	for bucket, hit := range leftBuckets {
		if !hit {
			return fmt.Errorf("key %q: left bucket %d receives no rows", split.Key, bucket)
		}
	}

	rightBuckets := make([]bool, split.S)
	for row := int64(0); row < right; row++ {
		slots, err := routeRightOf(split, row)
		if err != nil {
			return err
		}
		if len(slots) != split.R {
			return fmt.Errorf("key %q: right row %d routed to %d slots, want %d", split.Key, row, len(slots), split.R)
		}
		rightBuckets[int(row%int64(split.S))] = true
		for _, slot := range slots {
			if slot < split.SlotStart || slot >= split.SlotStart+split.Cells {
				return fmt.Errorf("key %q: routed slot %d outside owned range", split.Key, slot)
			}
		}
	}
	for bucket, hit := range rightBuckets {
		if !hit {
			return fmt.Errorf("key %q: right bucket %d receives no rows", split.Key, bucket)
		}
	}
	return nil
}

// verifyEveryPairMeetsOnce enumerates all same-key record pairs and requires
// exactly one common slot per pair.
func verifyEveryPairMeetsOnce(split KeySplit, left, right int64) error {
	leftRoutes := make([][]int, left)
	rightRoutes := make([][]int, right)
	for row := int64(0); row < left; row++ {
		slots, err := routeLeftOf(split, row)
		if err != nil {
			return err
		}
		leftRoutes[row] = slots
	}
	for row := int64(0); row < right; row++ {
		slots, err := routeRightOf(split, row)
		if err != nil {
			return err
		}
		rightRoutes[row] = slots
	}

	for l := int64(0); l < left; l++ {
		for r := int64(0); r < right; r++ {
			meet := intersectionCount(leftRoutes[l], rightRoutes[r])
			if meet != 1 {
				return fmt.Errorf("key %q: pair (left=%d, right=%d) meets in %d slots, want 1", split.Key, l, r, meet)
			}
		}
	}
	return nil
}

func routeLeftOf(split KeySplit, rowNumber int64) ([]int, error) {
	bucket := int(rowNumber % int64(split.R))
	slots := make([]int, 0, split.S)
	for rightBucket := 0; rightBucket < split.S; rightBucket++ {
		slots = append(slots, split.SlotStart+bucket*split.S+rightBucket)
	}
	return slots, nil
}

func routeRightOf(split KeySplit, rowNumber int64) ([]int, error) {
	bucket := int(rowNumber % int64(split.S))
	slots := make([]int, 0, split.R)
	for leftBucket := 0; leftBucket < split.R; leftBucket++ {
		slots = append(slots, split.SlotStart+leftBucket*split.S+bucket)
	}
	return slots, nil
}

func intersectionCount(a, b []int) int {
	seen := make(map[int]struct{}, len(a))
	for _, slot := range a {
		seen[slot] = struct{}{}
	}
	count := 0
	for _, slot := range b {
		if _, ok := seen[slot]; ok {
			count++
		}
	}
	return count
}
