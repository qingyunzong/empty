package solver

import (
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

// MaxTickets is the maximum number of ticket types (each buyable at most once).
const MaxTickets = 22

// MaxDays is the maximum number of distinct travel days (bitmask width).
const MaxDays = 64

// maxCoverNodes bounds the branch-and-bound search effort.
const maxCoverNodes = 20_000_000

// CoverTicket covers a fixed set of days and can be bought at most once.
type CoverTicket struct {
	ID   string
	Cost int
	Days []int
}

// DayCover certifies that one travel day is covered by one chosen ticket.
type DayCover struct {
	Day      int    `json:"day"`
	TicketID string `json:"ticketId"`
}

// CoverSolution is the optimal purchase set plus its coverage certificate.
type CoverSolution struct {
	Cost     int        `json:"cost"`
	Count    int        `json:"count"`
	IDs      []string   `json:"ticketIds"`
	Coverage []DayCover `json:"coverage"`
}

// ErrInfeasible is returned when the travel days cannot be covered.
var ErrInfeasible = errors.New("no feasible solution")

// normalizeDays deduplicates and sorts the travel days.
func normalizeDays(days []int) ([]int, error) {
	seen := map[int]bool{}
	out := make([]int, 0, len(days))
	for _, d := range days {
		if d < 1 {
			return nil, fmt.Errorf("invalid travel day %d: days must be >= 1", d)
		}
		if !seen[d] {
			seen[d] = true
			out = append(out, d)
		}
	}
	sort.Ints(out)
	if len(out) > MaxDays {
		return nil, fmt.Errorf("too many distinct travel days: %d > %d", len(out), MaxDays)
	}
	return out, nil
}

// validateCoverInput checks common constraints and returns sorted unique days.
func validateCoverInput(days []int, tickets []CoverTicket) ([]int, error) {
	travel, err := normalizeDays(days)
	if err != nil {
		return nil, err
	}
	if len(tickets) > MaxTickets {
		return nil, fmt.Errorf("too many ticket types: %d > %d", len(tickets), MaxTickets)
	}
	seen := map[string]bool{}
	for _, t := range tickets {
		if t.ID == "" {
			return nil, errors.New("ticket with empty id")
		}
		if seen[t.ID] {
			return nil, fmt.Errorf("duplicate ticket id %q", t.ID)
		}
		seen[t.ID] = true
		if t.Cost < 0 {
			return nil, fmt.Errorf("ticket %q has negative cost %d", t.ID, t.Cost)
		}
	}
	return travel, nil
}

// coverMasks maps every ticket to the bitmask of travel days it covers.
func coverMasks(travel []int, tickets []CoverTicket) []uint64 {
	idx := make(map[int]int, len(travel))
	for i, d := range travel {
		idx[d] = i
	}
	masks := make([]uint64, len(tickets))
	for ti, t := range tickets {
		var m uint64
		for _, d := range t.Days {
			if i, ok := idx[d]; ok {
				m |= 1 << uint(i)
			}
		}
		masks[ti] = m
	}
	return masks
}

func fullMask(n int) uint64 {
	if n >= 64 {
		return ^uint64(0)
	}
	return (uint64(1) << uint(n)) - 1
}

// SolveCover finds the optimal set of tickets covering all travel days using
// branch and bound over the first uncovered day.
func SolveCover(days []int, tickets []CoverTicket) (*CoverSolution, error) {
	travel, err := validateCoverInput(days, tickets)
	if err != nil {
		return nil, err
	}
	if len(travel) == 0 {
		return &CoverSolution{IDs: []string{}, Coverage: []DayCover{}}, nil
	}
	n := len(tickets)
	masks := coverMasks(travel, tickets)
	full := fullMask(len(travel))

	// Candidate tickets per day, cheapest first (then larger coverage, then id)
	// so the search finds strong incumbents early.
	cand := make([][]int, len(travel))
	for i := range travel {
		for t := 0; t < n; t++ {
			if masks[t]>>uint(i)&1 == 1 {
				cand[i] = append(cand[i], t)
			}
		}
		list := cand[i]
		sort.Slice(list, func(a, b int) bool {
			ta, tb := list[a], list[b]
			if tickets[ta].Cost != tickets[tb].Cost {
				return tickets[ta].Cost < tickets[tb].Cost
			}
			pa, pb := bits.OnesCount64(masks[ta]), bits.OnesCount64(masks[tb])
			if pa != pb {
				return pa > pb
			}
			return tickets[ta].ID < tickets[tb].ID
		})
		if len(cand[i]) == 0 {
			return nil, fmt.Errorf("day %d: %w", travel[i], ErrInfeasible)
		}
	}

	bestCost, bestCount := int(^uint(0)>>1), 0
	var bestIDs []string
	found := false

	// Greedy seed: repeatedly take the ticket with the lowest cost per newly
	// covered day.
	{
		covered, used := uint64(0), uint32(0)
		cost, count := 0, 0
		var ids []string
		for covered != full {
			bestT, bestNew, bestC := -1, 0, 0
			for t := 0; t < n; t++ {
				if used>>uint(t)&1 == 1 {
					continue
				}
				newBits := bits.OnesCount64(masks[t] &^ covered)
				if newBits == 0 {
					continue
				}
				// minimize cost/newBits, tie-break smaller cost
				if bestT == -1 || tickets[t].Cost*bestNew > bestC*newBits ||
					(tickets[t].Cost*bestNew == bestC*newBits && tickets[t].Cost < bestC) {
					bestT, bestNew, bestC = t, newBits, tickets[t].Cost
				}
			}
			if bestT == -1 {
				break
			}
			used |= 1 << uint(bestT)
			covered |= masks[bestT]
			cost += bestC
			count++
			ids = insertSorted(ids, tickets[bestT].ID)
		}
		if covered == full {
			found = true
			bestCost, bestCount, bestIDs = cost, count, ids
		}
	}

	nodes := 0
	aborted := false
	var rec func(covered uint64, used uint32, cost, count int, ids []string)
	rec = func(covered uint64, used uint32, cost, count int, ids []string) {
		if aborted {
			return
		}
		nodes++
		if nodes > maxCoverNodes {
			aborted = true
			return
		}
		if covered == full {
			if !found || betterTriple(cost, count, ids, bestCost, bestCount, bestIDs) {
				found = true
				bestCost, bestCount, bestIDs = cost, count, ids
			}
			return
		}
		// Any completion needs at least one more ticket, so an incumbent that
		// is already matched on cost and count can only be strictly worsened.
		if found && (cost > bestCost || (cost == bestCost && count >= bestCount)) {
			return
		}
		i := bits.TrailingZeros64(full &^ covered)
		for _, t := range cand[i] {
			if used>>uint(t)&1 == 1 {
				continue
			}
			rec(covered|masks[t], used|1<<uint(t), cost+tickets[t].Cost, count+1, insertSorted(ids, tickets[t].ID))
			if aborted {
				return
			}
		}
	}
	rec(0, 0, 0, 0, nil)
	if aborted {
		return nil, errors.New("search space too large")
	}
	if !found {
		return nil, ErrInfeasible
	}
	return buildCoverSolution(travel, tickets, masks, bestCost, bestCount, bestIDs), nil
}

// buildCoverSolution assigns each travel day to the lexicographically first
// chosen ticket covering it, producing the coverage certificate.
func buildCoverSolution(travel []int, tickets []CoverTicket, masks []uint64, cost, count int, ids []string) *CoverSolution {
	byID := make(map[string]int, len(tickets))
	for i, t := range tickets {
		byID[t.ID] = i
	}
	coverage := make([]DayCover, 0, len(travel))
	for i, d := range travel {
		for _, id := range ids {
			if masks[byID[id]]>>uint(i)&1 == 1 {
				coverage = append(coverage, DayCover{Day: d, TicketID: id})
				break
			}
		}
	}
	return &CoverSolution{Cost: cost, Count: count, IDs: ids, Coverage: coverage}
}

// CheckCoverCertificate validates the structure of a coverage certificate
// without re-solving: chosen tickets exist and are unique, cost and count
// match, and every travel day is certified by a chosen ticket covering it.
func CheckCoverCertificate(days []int, tickets []CoverTicket, sol *CoverSolution) error {
	if sol == nil {
		return errors.New("nil solution")
	}
	travel, err := validateCoverInput(days, tickets)
	if err != nil {
		return err
	}
	byID := make(map[string]CoverTicket, len(tickets))
	for _, t := range tickets {
		byID[t.ID] = t
	}
	seen := map[string]bool{}
	cost := 0
	for _, id := range sol.IDs {
		t, ok := byID[id]
		if !ok {
			return fmt.Errorf("certificate uses unknown ticket %q", id)
		}
		if seen[id] {
			return fmt.Errorf("ticket %q bought more than once", id)
		}
		seen[id] = true
		cost += t.Cost
	}
	if cost != sol.Cost {
		return fmt.Errorf("certificate cost %d does not match ticket sum %d", sol.Cost, cost)
	}
	if len(sol.IDs) != sol.Count {
		return fmt.Errorf("certificate count %d does not match %d tickets", sol.Count, len(sol.IDs))
	}
	certified := make(map[int]string, len(sol.Coverage))
	for _, c := range sol.Coverage {
		if _, ok := certified[c.Day]; ok {
			return fmt.Errorf("day %d certified twice", c.Day)
		}
		t, ok := byID[c.TicketID]
		if !ok || !seen[c.TicketID] {
			return fmt.Errorf("day %d certified by unchosen ticket %q", c.Day, c.TicketID)
		}
		okDay := false
		for _, d := range t.Days {
			if d == c.Day {
				okDay = true
				break
			}
		}
		if !okDay {
			return fmt.Errorf("ticket %q does not cover day %d", c.TicketID, c.Day)
		}
		certified[c.Day] = c.TicketID
	}
	for _, d := range travel {
		if _, ok := certified[d]; !ok {
			return fmt.Errorf("day %d is not covered by the certificate", d)
		}
	}
	return nil
}

// BruteForceCover independently enumerates all 2^n purchase subsets and
// returns the optimum. It is the small-scale verifier for SolveCover.
func BruteForceCover(days []int, tickets []CoverTicket) (*CoverSolution, error) {
	travel, err := validateCoverInput(days, tickets)
	if err != nil {
		return nil, err
	}
	if len(travel) == 0 {
		return &CoverSolution{IDs: []string{}, Coverage: []DayCover{}}, nil
	}
	n := len(tickets)
	masks := coverMasks(travel, tickets)
	full := fullMask(len(travel))

	found := false
	bestCost, bestCount := 0, 0
	var bestIDs []string
	for subset := uint32(0); subset < uint32(1)<<uint(n); subset++ {
		var covered uint64
		cost, count := 0, 0
		var ids []string
		for t := 0; t < n; t++ {
			if subset>>uint(t)&1 == 1 {
				covered |= masks[t]
				cost += tickets[t].Cost
				count++
				ids = insertSorted(ids, tickets[t].ID)
			}
		}
		if covered != full {
			continue
		}
		if !found || betterTriple(cost, count, ids, bestCost, bestCount, bestIDs) {
			found = true
			bestCost, bestCount, bestIDs = cost, count, ids
		}
	}
	if !found {
		return nil, ErrInfeasible
	}
	return buildCoverSolution(travel, tickets, masks, bestCost, bestCount, bestIDs), nil
}

// SameOptimum reports whether two solutions achieve the same objective value.
func SameOptimum(costA, countA int, idsA []string, costB, countB int, idsB []string) bool {
	return costA == costB && countA == countB && compareIDs(idsA, idsB) == 0
}
