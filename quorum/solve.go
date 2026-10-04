package quorum

import (
	"fmt"
	"math"
	"math/bits"
	"sort"
)

// WeightCertificate proves the strict-majority weight rule for a quorum.
type WeightCertificate struct {
	QuorumWeight int64  `json:"quorum_weight"`
	TotalWeight  int64  `json:"total_weight"`
	Rule         string `json:"rule"`
	Passes       bool   `json:"passes"`
}

// DomainCertificate proves the minimum fault-domain spread of a quorum.
type DomainCertificate struct {
	Domains     []string `json:"domains"`
	Count       int      `json:"count"`
	MinRequired int      `json:"min_required"`
	Passes      bool     `json:"passes"`
}

// QuorumCertificate is the output of the single-quorum solver.
type QuorumCertificate struct {
	Status     string             `json:"status"` // "optimal" or "infeasible"
	Members    []string           `json:"members,omitempty"`
	Cost       int64              `json:"cost,omitempty"`
	Weight     *WeightCertificate `json:"weight_certificate,omitempty"`
	Domains    *DomainCertificate `json:"domain_certificate,omitempty"`
	LowerBound int64              `json:"lower_bound"`
	UpperBound int64              `json:"upper_bound"`
	Explored   uint64             `json:"nodes_explored"`
}

// SolveQuorum finds a minimum-cost set of candidate voters whose total
// weight is strictly more than half of the total voter weight and that
// spans at least MinDomains distinct fault domains. It uses
// branch-and-bound; at most MaxQuorumVoters candidate voters are accepted.
func SolveQuorum(in *Input) (*QuorumCertificate, error) {
	vs, domNames := voters(in)
	if len(vs) > MaxQuorumVoters {
		return nil, fmt.Errorf("quorum: %d candidate voters exceeds limit %d", len(vs), MaxQuorumVoters)
	}
	total := totalWeight(vs)
	n := len(vs)

	// Branch on cheap, heavy nodes first to find good incumbents early.
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	sort.Slice(order, func(a, b int) bool {
		va, vb := vs[order[a]], vs[order[b]]
		if va.cost != vb.cost {
			return va.cost < vb.cost
		}
		if va.weight != vb.weight {
			return va.weight > vb.weight
		}
		return va.id < vb.id
	})

	sufWeight := make([]int64, n+1)
	sufDomains := make([]uint64, n+1)
	for i := n - 1; i >= 0; i-- {
		v := vs[order[i]]
		sufWeight[i] = sufWeight[i+1] + v.weight
		sufDomains[i] = sufDomains[i+1] | 1<<uint(v.domain)
	}

	best := int64(math.MaxInt64)
	var bestMask uint64 // bitmask over original voter indices
	var explored uint64

	var rec func(i int, mask uint64, weight, cost int64, domMask uint64)
	rec = func(i int, mask uint64, weight, cost int64, domMask uint64) {
		explored++
		if cost >= best {
			return
		}
		if 2*weight > total && bits.OnesCount64(domMask) >= MinDomains {
			best, bestMask = cost, mask
			return // costs are non-negative: extending only increases cost
		}
		if i == n {
			return
		}
		if 2*(weight+sufWeight[i]) <= total {
			return // can never reach strict majority
		}
		if bits.OnesCount64(domMask|sufDomains[i]) < MinDomains {
			return // can never reach the domain spread
		}
		v := vs[order[i]]
		rec(i+1, mask|1<<uint(order[i]), weight+v.weight, cost+v.cost, domMask|1<<uint(v.domain))
		rec(i+1, mask, weight, cost, domMask)
	}
	rec(0, 0, 0, 0, 0)

	cert := &QuorumCertificate{Explored: explored}
	if best == math.MaxInt64 {
		cert.Status = "infeasible"
		return cert, nil
	}
	cert.Status = "optimal"
	cert.Cost = best
	cert.LowerBound = best
	cert.UpperBound = best

	var weightSum int64
	var domMask uint64
	for i, v := range vs {
		if bestMask>>uint(i)&1 == 1 {
			cert.Members = append(cert.Members, v.id)
			weightSum += v.weight
			domMask |= 1 << uint(v.domain)
		}
	}
	domCount := bits.OnesCount64(domMask)
	cert.Weight = &WeightCertificate{
		QuorumWeight: weightSum,
		TotalWeight:  total,
		Rule:         "2*quorum_weight > total_weight",
		Passes:       2*weightSum > total,
	}
	cert.Domains = &DomainCertificate{
		Domains:     domainNamesOf(domNames, domMask),
		Count:       domCount,
		MinRequired: MinDomains,
		Passes:      domCount >= MinDomains,
	}
	return cert, nil
}
