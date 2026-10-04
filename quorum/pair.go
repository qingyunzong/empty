package quorum

import (
	"container/heap"
	"fmt"
	"math/bits"
	"sort"
)

// FaultCertificate certifies one allowed single-fault scenario for a
// read/write quorum pair: both quorums keep satisfying the weight and
// domain rules after the fault, and they still intersect.
type FaultCertificate struct {
	Fault                 string   `json:"fault"`
	ReadSurvivingWeight   int64    `json:"read_surviving_weight"`
	ReadSurvivingDomains  []string `json:"read_surviving_domains"`
	ReadPasses            bool     `json:"read_passes"`
	WriteSurvivingWeight  int64    `json:"write_surviving_weight"`
	WriteSurvivingDomains []string `json:"write_surviving_domains"`
	WritePasses           bool     `json:"write_passes"`
	Intersection          []string `json:"intersection"`
	Intersects            bool     `json:"intersects"`
}

// PairCertificate is the output of the read/write pair solver.
type PairCertificate struct {
	Status        string             `json:"status"` // "optimal" or "infeasible"
	Read          []string           `json:"read,omitempty"`
	Write         []string           `json:"write,omitempty"`
	Cost          int64              `json:"cost,omitempty"`
	TotalWeight   int64              `json:"total_weight"`
	Faults        []FaultCertificate `json:"fault_certificates,omitempty"`
	LowerBound    int64              `json:"lower_bound"`
	UpperBound    int64              `json:"upper_bound"`
	PairsExamined uint64             `json:"pairs_examined"`
}

type faultDomain struct {
	name   string
	mask   uint64 // voter nodes inside the domain
	domBit uint64 // domain bit in domain masks
}

// SolvePair picks a distinct read quorum R and write quorum W minimizing
// cost(R)+cost(W) such that, after any allowed single fault F (one fault
// domain failing), both R\F and W\F still satisfy the weight and domain
// rules and (R∩W)\F is non-empty. At most MaxPairVoters candidate voters
// are accepted.
func SolvePair(in *Input) (*PairCertificate, error) {
	vs, domNames := voters(in)
	if len(vs) > MaxPairVoters {
		return nil, fmt.Errorf("pair: %d candidate voters exceeds limit %d", len(vs), MaxPairVoters)
	}
	total := totalWeight(vs)
	faultNames, err := faultList(in, domNames)
	if err != nil {
		return nil, err
	}

	n := len(vs)
	m := 1 << uint(n)
	weight := make([]int64, m)
	cost := make([]int64, m)
	domMask := make([]uint64, m)
	for s := 1; s < m; s++ {
		low := s & -s
		i := bits.TrailingZeros64(uint64(low))
		p := s ^ low
		weight[s] = weight[p] + vs[i].weight
		cost[s] = cost[p] + vs[i].cost
		domMask[s] = domMask[p] | 1<<uint(vs[i].domain)
	}

	domIndex := map[string]int{}
	for i, name := range domNames {
		domIndex[name] = i
	}
	var faults []faultDomain
	for _, name := range faultNames {
		f := faultDomain{name: name}
		if di, ok := domIndex[name]; ok {
			f.domBit = 1 << uint(di)
			for i, v := range vs {
				if v.domain == di {
					f.mask |= 1 << uint(i)
				}
			}
		}
		faults = append(faults, f)
	}

	// Resilient quorums: legal after every allowed single fault.
	type candidate struct {
		mask uint64
		cost int64
	}
	var cands []candidate
	for s := 1; s < m; s++ {
		ok := true
		for _, f := range faults {
			sw := weight[s] - weight[s&int(f.mask)]
			sd := domMask[s] &^ f.domBit
			if 2*sw <= total || bits.OnesCount64(sd) < MinDomains {
				ok = false
				break
			}
		}
		if ok {
			cands = append(cands, candidate{mask: uint64(s), cost: cost[s]})
		}
	}

	cert := &PairCertificate{Status: "optimal", TotalWeight: total}
	if len(cands) < 2 {
		cert.Status = "infeasible"
		return cert, nil
	}
	sort.Slice(cands, func(a, b int) bool {
		if cands[a].cost != cands[b].cost {
			return cands[a].cost < cands[b].cost
		}
		return cands[a].mask < cands[b].mask
	})

	intersectsAfterFaults := func(a, b uint64) bool {
		for _, f := range faults {
			if a&b&^f.mask == 0 {
				return false
			}
		}
		return true
	}

	// Best-first search over unordered pairs of distinct candidates in
	// ascending cost-sum order; the first feasible pair is optimal.
	pq := &pairHeap{}
	visited := map[uint64]bool{}
	push := func(i, j int) {
		key := uint64(i)<<32 | uint64(j)
		if visited[key] {
			return
		}
		visited[key] = true
		heap.Push(pq, pairItem{sum: cands[i].cost + cands[j].cost, i: i, j: j})
	}
	push(0, 1)

	found := false
	var optSum int64
	var bi, bj int
	var examined uint64
	for pq.Len() > 0 {
		it := heap.Pop(pq).(pairItem)
		examined++
		if intersectsAfterFaults(cands[it.i].mask, cands[it.j].mask) {
			found, optSum, bi, bj = true, it.sum, it.i, it.j
			break
		}
		if it.i+1 < it.j {
			push(it.i+1, it.j)
		}
		if it.j+1 < len(cands) {
			push(it.i, it.j+1)
		}
	}
	cert.PairsExamined = examined
	if !found {
		cert.Status = "infeasible"
		return cert, nil
	}

	rMask, wMask := cands[bi].mask, cands[bj].mask
	cert.Read = memberIDs(vs, rMask)
	cert.Write = memberIDs(vs, wMask)
	cert.Cost = optSum
	cert.LowerBound = optSum
	cert.UpperBound = optSum
	for _, f := range faults {
		fc := FaultCertificate{Fault: f.name}
		fc.ReadSurvivingWeight = weight[rMask] - weight[rMask&f.mask]
		fc.ReadSurvivingDomains = domainNamesOf(domNames, domMask[rMask]&^f.domBit)
		fc.ReadPasses = 2*fc.ReadSurvivingWeight > total && len(fc.ReadSurvivingDomains) >= MinDomains
		fc.WriteSurvivingWeight = weight[wMask] - weight[wMask&f.mask]
		fc.WriteSurvivingDomains = domainNamesOf(domNames, domMask[wMask]&^f.domBit)
		fc.WritePasses = 2*fc.WriteSurvivingWeight > total && len(fc.WriteSurvivingDomains) >= MinDomains
		inter := rMask & wMask &^ f.mask
		fc.Intersection = memberIDs(vs, inter)
		fc.Intersects = inter != 0
		cert.Faults = append(cert.Faults, fc)
	}
	return cert, nil
}

type pairItem struct {
	sum  int64
	i, j int
}

type pairHeap []pairItem

func (h pairHeap) Len() int { return len(h) }
func (h pairHeap) Less(a, b int) bool {
	if h[a].sum != h[b].sum {
		return h[a].sum < h[b].sum
	}
	if h[a].i != h[b].i {
		return h[a].i < h[b].i
	}
	return h[a].j < h[b].j
}
func (h pairHeap) Swap(a, b int)       { h[a], h[b] = h[b], h[a] }
func (h *pairHeap) Push(x interface{}) { *h = append(*h, x.(pairItem)) }
func (h *pairHeap) Pop() interface{} {
	old := *h
	n := len(old)
	it := old[n-1]
	*h = old[:n-1]
	return it
}
