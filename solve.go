package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

// Solve computes a minimum-cost feasible placement.
//
// Model: min-cost flow. Source -> shard (cap k), shard -> per-shard
// domain node (cap 1, enforcing distinct failure domains per shard),
// domain node -> site in that domain (cap 1, cost = site access fee),
// site -> sink (cap = site capacity). Because all costs are
// non-negative an optimal solution uses exactly k replicas per shard.
func Solve(p *Problem) (*Plan, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}

	domains := map[string]int{}
	var domainNames []string
	for _, s := range p.Sites {
		if _, ok := domains[s.Domain]; !ok {
			domains[s.Domain] = len(domainNames)
			domainNames = append(domainNames, s.Domain)
		}
	}
	nSh, nDom, nSit := len(p.Shards), len(domainNames), len(p.Sites)

	const src = 0
	shardNode := func(i int) int { return 1 + i }
	sdNode := func(i, d int) int { return 1 + nSh + i*nDom + d }
	siteNode := func(j int) int { return 1 + nSh + nSh*nDom + j }
	sink := 1 + nSh + nSh*nDom + nSit

	g := newMCFGraph(sink + 1)
	need := 0
	for i, sh := range p.Shards {
		g.addEdge(src, shardNode(i), sh.Replicas, 0, -1)
		need += sh.Replicas
		for d := 0; d < nDom; d++ {
			g.addEdge(shardNode(i), sdNode(i, d), 1, 0, -1)
		}
	}
	// tag encodes shard*site so placements can be recovered from flow.
	for i := 0; i < nSh; i++ {
		for j, s := range p.Sites {
			g.addEdge(sdNode(i, domains[s.Domain]), siteNode(j), 1, s.Cost, i*nSit+j)
		}
	}
	for j, s := range p.Sites {
		g.addEdge(siteNode(j), sink, s.Capacity, 0, -1)
	}

	flow, cost := g.minCostFlow(src, sink, need)
	if flow < need {
		return &Plan{Status: "infeasible",
			Reason: fmt.Sprintf("cannot place all replicas: placed %d of %d (failure-domain or capacity limits)", flow, need)}, nil
	}
	if cost > p.Budget {
		return &Plan{Status: "infeasible",
			Reason: fmt.Sprintf("minimum possible cost %d exceeds budget %d", cost, p.Budget)}, nil
	}

	// Recover placements from tagged forward edges.
	byShard := make([][]Replica, nSh)
	for u := range g.edges {
		for _, e := range g.edges[u] {
			if e.flowFrom >= 0 && e.cap == 0 { // unit edge saturated
				i, j := e.flowFrom/nSit, e.flowFrom%nSit
				s := p.Sites[j]
				byShard[i] = append(byShard[i], Replica{Site: s.ID, Domain: s.Domain, Cost: s.Cost})
			}
		}
	}
	placements := make([]Placement, nSh)
	for i, sh := range p.Shards {
		placements[i] = Placement{Shard: sh.ID, Replicas: byShard[i]}
	}
	plan := &Plan{Status: "optimal", TotalCost: cost, Placements: placements}
	plan.Certificate = buildCertificate(p, plan)
	return plan, nil
}

// digestPlacements hashes the canonical placement list.
func digestPlacements(pl []Placement) string {
	b, _ := json.Marshal(canonicalPlacements(pl))
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// buildCertificate derives the failure-domain and capacity certificate.
func buildCertificate(p *Problem, plan *Plan) *Certificate {
	siteByID := map[string]Site{}
	for _, s := range p.Sites {
		siteByID[s.ID] = s
	}
	used := map[string]int{}
	cert := &Certificate{Budget: p.Budget, TotalCost: plan.TotalCost}
	for _, pl := range plan.Placements {
		var req int
		for _, sh := range p.Shards {
			if sh.ID == pl.Shard {
				req = sh.Replicas
			}
		}
		sc := ShardCert{Shard: pl.Shard, Required: req, Placed: len(pl.Replicas)}
		seen := map[string]bool{}
		distinct := true
		for _, r := range pl.Replicas {
			if seen[r.Domain] {
				distinct = false
			}
			seen[r.Domain] = true
			used[r.Site]++
		}
		for d := range seen {
			sc.Domains = append(sc.Domains, d)
		}
		sort.Strings(sc.Domains)
		sc.DomainsDistinct = distinct
		sc.EnoughReplicas = sc.Placed >= sc.Required
		cert.Shards = append(cert.Shards, sc)
	}
	for _, s := range p.Sites {
		u := used[s.ID]
		cert.Sites = append(cert.Sites, SiteCert{
			Site: s.ID, Domain: s.Domain, Used: u,
			Capacity: s.Capacity, WithinCapacity: u <= s.Capacity,
		})
	}
	cert.WithinBudget = plan.TotalCost <= p.Budget
	cert.Digest = digestPlacements(plan.Placements)
	return cert
}

// Verify independently re-checks a plan against the problem: schema,
// replica counts, failure-domain distinctness, site capacity, cost
// accounting, budget, and the certificate digest. It does not trust
// any field of the plan; everything is recomputed from placements.
func Verify(p *Problem, plan *Plan) error {
	if err := p.Validate(); err != nil {
		return fmt.Errorf("problem invalid: %w", err)
	}
	if plan == nil || plan.Status != "optimal" {
		return fmt.Errorf("plan status is %q, nothing to verify", planStatus(plan))
	}
	siteByID := map[string]Site{}
	for _, s := range p.Sites {
		siteByID[s.ID] = s
	}
	shardReq := map[string]int{}
	for _, sh := range p.Shards {
		shardReq[sh.ID] = sh.Replicas
	}
	if len(plan.Placements) != len(p.Shards) {
		return fmt.Errorf("plan covers %d shards, problem has %d", len(plan.Placements), len(p.Shards))
	}
	seenShard := map[string]bool{}
	used := map[string]int{}
	total := 0
	for _, pl := range plan.Placements {
		req, ok := shardReq[pl.Shard]
		if !ok {
			return fmt.Errorf("placement for unknown shard %q", pl.Shard)
		}
		if seenShard[pl.Shard] {
			return fmt.Errorf("duplicate placement for shard %q", pl.Shard)
		}
		seenShard[pl.Shard] = true
		if len(pl.Replicas) < req {
			return fmt.Errorf("shard %q: %d replicas placed, need at least %d", pl.Shard, len(pl.Replicas), req)
		}
		seenDomain := map[string]bool{}
		seenSite := map[string]bool{}
		for _, r := range pl.Replicas {
			s, ok := siteByID[r.Site]
			if !ok {
				return fmt.Errorf("shard %q: unknown site %q", pl.Shard, r.Site)
			}
			if r.Domain != s.Domain {
				return fmt.Errorf("shard %q: site %q is in domain %q, certificate claims %q", pl.Shard, r.Site, s.Domain, r.Domain)
			}
			if r.Cost != s.Cost {
				return fmt.Errorf("shard %q: site %q costs %d, plan claims %d", pl.Shard, r.Site, s.Cost, r.Cost)
			}
			if seenSite[r.Site] {
				return fmt.Errorf("shard %q: site %q used twice", pl.Shard, r.Site)
			}
			seenSite[r.Site] = true
			if seenDomain[r.Domain] {
				return fmt.Errorf("shard %q: failure domain %q used twice", pl.Shard, r.Domain)
			}
			seenDomain[r.Domain] = true
			used[r.Site]++
			total += s.Cost
		}
	}
	for _, s := range p.Sites {
		if used[s.ID] > s.Capacity {
			return fmt.Errorf("site %q: %d replicas exceed capacity %d", s.ID, used[s.ID], s.Capacity)
		}
	}
	if total != plan.TotalCost {
		return fmt.Errorf("cost mismatch: placements sum to %d, plan claims %d", total, plan.TotalCost)
	}
	if total > p.Budget {
		return fmt.Errorf("total cost %d exceeds budget %d", total, p.Budget)
	}
	if plan.Certificate == nil {
		return fmt.Errorf("missing certificate")
	}
	want := buildCertificate(p, plan)
	got := plan.Certificate
	if got.Digest != want.Digest || got.Digest != digestPlacements(plan.Placements) {
		return fmt.Errorf("certificate digest mismatch")
	}
	gj, _ := json.Marshal(got)
	wj, _ := json.Marshal(want)
	if string(gj) != string(wj) {
		return fmt.Errorf("certificate content mismatch")
	}
	return nil
}

func planStatus(p *Plan) string {
	if p == nil {
		return "<nil>"
	}
	return p.Status
}
