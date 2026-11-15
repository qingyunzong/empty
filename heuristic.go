package dataeng

import (
	"math"
	"sort"
	"strings"
	"time"
)

func (s *solver) initialSolution() []uint8 {
	orders := s.blockOrders()
	candidates := make([]leafEvaluation, 0, 32)
	seen := make(map[string]struct{})
	add := func(asn []uint8) {
		if asn == nil || !s.validAssignment(asn) {
			return
		}
		key := assignmentKey(asn)
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		candidates = append(candidates, leafEvaluation{
			obj: s.objective(s.countsFor(asn)),
			asn: asn,
		})
	}

	for _, order := range orders {
		if s.m <= 70 {
			for trainEnd := 0; trainEnd <= s.m; trainEnd++ {
				for validationEnd := trainEnd; validationEnd <= s.m; validationEnd++ {
					asn := make([]uint8, s.m)
					for pos, idx := range order {
						switch {
						case pos < trainEnd:
							asn[idx] = 0
						case pos < validationEnd:
							asn[idx] = 1
						default:
							asn[idx] = 2
						}
					}
					add(asn)
				}
			}
		} else {
			for _, trainEnd := range cutCandidates(order, s.p, 0.8) {
				for _, validationEnd := range cutCandidates(order, s.p, 0.9) {
					if validationEnd < trainEnd {
						continue
					}
					asn := make([]uint8, s.m)
					for pos, idx := range order {
						switch {
						case pos < trainEnd:
							asn[idx] = 0
						case pos < validationEnd:
							asn[idx] = 1
						default:
							asn[idx] = 2
						}
					}
					add(asn)
				}
			}
		}
	}

	for _, order := range orders {
		if asn := s.greedyAssignment(order); asn != nil {
			add(asn)
		}
	}

	if len(candidates) == 0 {
		return nil
	}
	sort.Slice(candidates, func(i, j int) bool {
		if math.Abs(candidates[i].obj-candidates[j].obj) > s.eps {
			return candidates[i].obj < candidates[j].obj
		}
		return compareAssignments(candidates[i].asn, candidates[j].asn) < 0
	})

	best := candidates[0]
	limit := len(candidates)
	if limit > 6 {
		limit = 6
	}
	for i := 0; i < limit; i++ {
		improved := s.localSearch(candidates[i].asn)
		obj := s.objective(s.countsFor(improved))
		if obj < best.obj-s.eps ||
			(math.Abs(obj-best.obj) <= s.eps && compareAssignments(improved, best.asn) < 0) {
			best = leafEvaluation{obj: obj, asn: improved}
		}
	}
	return best.asn
}

func (s *solver) blockOrders() [][]int {
	orders := make([][]int, 0, 3)
	base := make([]int, s.m)
	for i := range base {
		base[i] = i
	}
	addOrder := func(less func(i, j int) bool) {
		order := append([]int(nil), base...)
		sort.SliceStable(order, func(i, j int) bool { return less(order[i], order[j]) })
		for _, existing := range orders {
			if equalInts(existing, order) {
				return
			}
		}
		orders = append(orders, order)
	}
	addOrder(func(i, j int) bool {
		a, b := s.p.blocks[i], s.p.blocks[j]
		if !a.latest.Equal(b.latest) {
			return a.latest.Before(b.latest)
		}
		return a.key < b.key
	})
	addOrder(func(i, j int) bool {
		a, b := s.p.blocks[i], s.p.blocks[j]
		if !a.earliest.Equal(b.earliest) {
			return a.earliest.Before(b.earliest)
		}
		return a.key < b.key
	})
	addOrder(func(i, j int) bool { return s.p.blocks[i].key < s.p.blocks[j].key })
	return orders
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func cutCandidates(order []int, p *prepared, fraction float64) []int {
	var total float64
	for _, idx := range order {
		total += p.blocks[idx].weight
	}
	target := fraction * total
	var cumulative float64
	best := 0
	bestDiff := math.Inf(1)
	for pos, idx := range order {
		cumulative += p.blocks[idx].weight
		if diff := math.Abs(cumulative - target); diff < bestDiff {
			bestDiff = diff
			best = pos + 1
		}
	}
	cuts := []int{0, 1, best, best + 1, best - 1, len(order) - 1, len(order)}
	sort.Ints(cuts)
	out := cuts[:0]
	for _, cut := range cuts {
		if cut < 0 || cut > len(order) {
			continue
		}
		if len(out) == 0 || out[len(out)-1] != cut {
			out = append(out, cut)
		}
	}
	return out
}

func (s *solver) greedyAssignment(order []int) []uint8 {
	asn := make([]uint8, s.m)
	for i := range asn {
		asn[i] = 0
	}
	var splitMass [3]float64
	var hasTrain, hasTest bool
	var maxTrain, minTest time.Time

	for pos, idx := range order {
		b := &s.p.blocks[idx]
		allowed := [3]bool{true, true, true}
		if s.p.hasTime {
			if hasTest && !b.latest.Before(minTest) {
				allowed[0] = false
			}
			if hasTrain && !b.earliest.After(maxTrain) {
				allowed[2] = false
			}
		}
		if !s.p.allowEmptySplits {
			remaining := s.m - pos - 1
			empty := 0
			for split := 0; split < 3; split++ {
				if splitMass[split] == 0 {
					empty++
				}
			}
			for split := 0; split < 3; split++ {
				emptyAfter := empty
				if splitMass[split] == 0 {
					emptyAfter--
				}
				if allowed[split] && remaining < emptyAfter {
					allowed[split] = false
				}
			}
		}

		choice := -1
		bestScore := math.Inf(-1)
		for split := 0; split < 3; split++ {
			if !allowed[split] {
				continue
			}
			score := s.p.targetSplit[split] - splitMass[split]
			if score > bestScore {
				bestScore = score
				choice = split
			}
		}
		if choice < 0 {
			return nil
		}
		asn[idx] = uint8(choice)
		splitMass[choice] += b.weight / s.p.totalWeight
		if s.p.hasTime {
			switch choice {
			case 0:
				if !hasTrain || b.latest.After(maxTrain) {
					maxTrain = b.latest
				}
				hasTrain = true
			case 2:
				if !hasTest || b.earliest.Before(minTest) {
					minTest = b.earliest
				}
				hasTest = true
			}
		}
	}
	if !s.validAssignment(asn) {
		return nil
	}
	return asn
}

func (s *solver) validAssignment(asn []uint8) bool {
	if len(asn) != s.m {
		return false
	}
	var filled [3]int
	var maxTrain, minTest time.Time
	var hasTrain, hasTest bool
	for i, choice := range asn {
		if choice > 2 {
			return false
		}
		b := &s.p.blocks[i]
		filled[choice]++
		if s.p.hasTime {
			switch choice {
			case 0:
				if !hasTrain || b.latest.After(maxTrain) {
					maxTrain = b.latest
				}
				hasTrain = true
			case 2:
				if !hasTest || b.earliest.Before(minTest) {
					minTest = b.earliest
				}
				hasTest = true
			}
		}
	}
	if s.p.hasTime && hasTrain && hasTest && !maxTrain.Before(minTest) {
		return false
	}
	if !s.p.allowEmptySplits {
		for _, count := range filled {
			if count == 0 {
				return false
			}
		}
	}
	return true
}

func (s *solver) localSearch(start []uint8) []uint8 {
	current := append([]uint8(nil), start...)
	currentObj := s.objective(s.countsFor(current))
	maxIterations := 2*s.m + 8
	for iteration := 0; iteration < maxIterations; iteration++ {
		best := current
		bestObj := currentObj
		improved := false

		for block := 0; block < s.m; block++ {
			for split := 0; split < 3; split++ {
				if int(current[block]) == split {
					continue
				}
				candidate := append([]uint8(nil), current...)
				candidate[block] = uint8(split)
				if !s.validAssignment(candidate) {
					continue
				}
				obj := s.objective(s.countsFor(candidate))
				if assignmentBetter(candidate, obj, best, bestObj, s.eps) {
					best, bestObj, improved = candidate, obj, true
				}
			}
		}

		if s.m <= 60 {
			for i := 0; i < s.m; i++ {
				for j := i + 1; j < s.m; j++ {
					if current[i] == current[j] {
						continue
					}
					candidate := append([]uint8(nil), current...)
					candidate[i], candidate[j] = candidate[j], candidate[i]
					if !s.validAssignment(candidate) {
						continue
					}
					obj := s.objective(s.countsFor(candidate))
					if assignmentBetter(candidate, obj, best, bestObj, s.eps) {
						best, bestObj, improved = candidate, obj, true
					}
				}
			}
		}

		if !improved {
			break
		}
		current, currentObj = best, bestObj
	}
	return current
}

func assignmentBetter(a []uint8, aObj float64, b []uint8, bObj, eps float64) bool {
	if aObj < bObj-eps {
		return true
	}
	if aObj > bObj+eps {
		return false
	}
	return compareAssignments(a, b) < 0
}

func assignmentKey(asn []uint8) string {
	var b strings.Builder
	b.Grow(len(asn))
	for _, choice := range asn {
		b.WriteByte(byte('0' + choice))
	}
	return b.String()
}
