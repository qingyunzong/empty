package main

import (
	"fmt"
	"sort"
	"strings"
)

// Limits from the problem statement.
const (
	MaxSites  = 20
	MaxShards = 8
)

// Site is a datacenter candidate: it belongs to one fault domain, can host up
// to Capacity replicas, and charges Cost per hosted replica (access cost).
type Site struct {
	ID       string `json:"id"`
	Domain   string `json:"domain"`
	Capacity int    `json:"capacity"`
	Cost     int64  `json:"cost"`
}

// Shard needs at least K replicas placed in pairwise distinct fault domains.
// Costs optionally overrides the per-replica access cost for specific sites.
type Shard struct {
	ID    string           `json:"id"`
	Costs map[string]int64 `json:"costs,omitempty"`
}

// Input is the planning problem instance.
type Input struct {
	K      int     `json:"k"`
	Budget int64   `json:"budget"`
	Sites  []Site  `json:"sites"`
	Shards []Shard `json:"shards"`
}

// Replica is one placed replica of a shard.
type Replica struct {
	Site   string `json:"site"`
	Domain string `json:"domain"`
	Cost   int64  `json:"cost"`
}

// ShardPlan lists the replicas chosen for one shard.
type ShardPlan struct {
	Shard    string    `json:"shard"`
	Replicas []Replica `json:"replicas"`
}

// Plan is the solver output: placement plus its total cost.
type Plan struct {
	Shards    []ShardPlan `json:"shards"`
	TotalCost int64       `json:"totalCost"`
	Budget    int64       `json:"budget"`
}

func validate(in *Input) error {
	if in.K < 1 {
		return fmt.Errorf("k must be >= 1, got %d", in.K)
	}
	if len(in.Sites) < 1 || len(in.Sites) > MaxSites {
		return fmt.Errorf("need 1..%d sites, got %d", MaxSites, len(in.Sites))
	}
	if len(in.Shards) < 1 || len(in.Shards) > MaxShards {
		return fmt.Errorf("need 1..%d shards, got %d", MaxShards, len(in.Shards))
	}
	if in.Budget < 0 {
		return fmt.Errorf("budget must be >= 0, got %d", in.Budget)
	}
	seen := make(map[string]bool)
	for _, s := range in.Sites {
		if s.ID == "" {
			return fmt.Errorf("site id must not be empty")
		}
		if seen[s.ID] {
			return fmt.Errorf("duplicate site id %q", s.ID)
		}
		seen[s.ID] = true
		if s.Domain == "" {
			return fmt.Errorf("site %q: domain must not be empty", s.ID)
		}
		if s.Capacity < 0 {
			return fmt.Errorf("site %q: capacity must be >= 0", s.ID)
		}
		if s.Cost < 0 {
			return fmt.Errorf("site %q: cost must be >= 0", s.ID)
		}
	}
	seenShard := make(map[string]bool)
	for _, sh := range in.Shards {
		if sh.ID == "" {
			return fmt.Errorf("shard id must not be empty")
		}
		if seenShard[sh.ID] {
			return fmt.Errorf("duplicate shard id %q", sh.ID)
		}
		seenShard[sh.ID] = true
		for siteID, c := range sh.Costs {
			if !seen[siteID] {
				return fmt.Errorf("shard %q: cost override for unknown site %q", sh.ID, siteID)
			}
			if c < 0 {
				return fmt.Errorf("shard %q: negative cost override for site %q", sh.ID, siteID)
			}
		}
	}
	return nil
}

// shardCost returns the access cost of placing one replica of shard s at site i.
func shardCost(in *Input, s, i int) int64 {
	if in.Shards[s].Costs != nil {
		if c, ok := in.Shards[s].Costs[in.Sites[i].ID]; ok {
			return c
		}
	}
	return in.Sites[i].Cost
}

// Solve computes a minimum-cost placement: every shard gets exactly K
// replicas (the cheapest way to satisfy "at least K" since costs are
// non-negative), each in a distinct fault domain, respecting site capacities.
// It returns an error if the instance is infeasible or the minimum cost
// exceeds the budget.
func Solve(in *Input) (*Plan, error) {
	if err := validate(in); err != nil {
		return nil, err
	}
	S := len(in.Shards)
	N := len(in.Sites)

	domains := []string{}
	domIdx := map[string]int{}
	for _, s := range in.Sites {
		if _, ok := domIdx[s.Domain]; !ok {
			domIdx[s.Domain] = len(domains)
			domains = append(domains, s.Domain)
		}
	}
	D := len(domains)

	// Flow network:
	//   source -> shard (cap K)
	//   shard -> (shard, domain) (cap 1: at most one replica per domain)
	//   (shard, domain) -> site in that domain (cap 1, cost = access cost)
	//   site -> sink (cap = site capacity)
	src := 0
	shardBase := 1
	sdBase := shardBase + S
	siteBase := sdBase + S*D
	sink := siteBase + N

	m := newMCMF(sink + 1)
	for s := range in.Shards {
		m.addEdge(src, shardBase+s, in.K, 0)
		for d := 0; d < D; d++ {
			m.addEdge(shardBase+s, sdBase+s*D+d, 1, 0)
		}
	}
	for i := range in.Sites {
		d := domIdx[in.Sites[i].Domain]
		for s := range in.Shards {
			m.addEdge(sdBase+s*D+d, siteBase+i, 1, shardCost(in, s, i))
		}
		m.addEdge(siteBase+i, sink, in.Sites[i].Capacity, 0)
	}

	need := S * in.K
	flow, cost := m.minCostFlow(src, sink, need)
	if flow < need {
		return nil, fmt.Errorf("infeasible: only %d of %d required replicas can be placed (fault-domain or capacity limits)", flow, need)
	}
	if cost > in.Budget {
		return nil, fmt.Errorf("infeasible: minimum cost %d exceeds budget %d", cost, in.Budget)
	}

	plan := &Plan{TotalCost: cost, Budget: in.Budget}
	for s := range in.Shards {
		sp := ShardPlan{Shard: in.Shards[s].ID}
		for d, dom := range domains {
			node := sdBase + s*D + d
			for _, e := range m.g[node] {
				if e.to >= siteBase && e.to < siteBase+N && e.cap == 0 {
					i := e.to - siteBase
					sp.Replicas = append(sp.Replicas, Replica{
						Site:   in.Sites[i].ID,
						Domain: dom,
						Cost:   shardCost(in, s, i),
					})
				}
			}
		}
		sort.Slice(sp.Replicas, func(a, b int) bool { return sp.Replicas[a].Site < sp.Replicas[b].Site })
		plan.Shards = append(plan.Shards, sp)
	}
	return plan, nil
}

// Verify independently checks a plan against the input and returns an error
// describing the first violated constraint.
func Verify(in *Input, p *Plan) error {
	if err := validate(in); err != nil {
		return err
	}
	siteIdx := make(map[string]int, len(in.Sites))
	for i, s := range in.Sites {
		siteIdx[s.ID] = i
	}
	shardIdx := make(map[string]int, len(in.Shards))
	for i, sh := range in.Shards {
		shardIdx[sh.ID] = i
	}
	used := make([]int, len(in.Sites))
	seenShard := make(map[string]bool)
	var total int64
	for _, sp := range p.Shards {
		s, ok := shardIdx[sp.Shard]
		if !ok {
			return fmt.Errorf("plan references unknown shard %q", sp.Shard)
		}
		if seenShard[sp.Shard] {
			return fmt.Errorf("plan lists shard %q twice", sp.Shard)
		}
		seenShard[sp.Shard] = true
		if len(sp.Replicas) < in.K {
			return fmt.Errorf("shard %q: %d replicas < k=%d", sp.Shard, len(sp.Replicas), in.K)
		}
		domSeen := make(map[string]string)
		for _, r := range sp.Replicas {
			i, ok := siteIdx[r.Site]
			if !ok {
				return fmt.Errorf("shard %q: unknown site %q", sp.Shard, r.Site)
			}
			if prev, dup := domSeen[r.Domain]; dup {
				return fmt.Errorf("shard %q: fault domain %q used by both %s and %s", sp.Shard, r.Domain, prev, r.Site)
			}
			domSeen[r.Domain] = r.Site
			if r.Domain != in.Sites[i].Domain {
				return fmt.Errorf("shard %q: site %q is in domain %q, not %q", sp.Shard, r.Site, in.Sites[i].Domain, r.Domain)
			}
			if want := shardCost(in, s, i); r.Cost != want {
				return fmt.Errorf("shard %q: replica at %q has cost %d, want %d", sp.Shard, r.Site, r.Cost, want)
			}
			used[i]++
			total += r.Cost
		}
	}
	for _, sh := range in.Shards {
		if !seenShard[sh.ID] {
			return fmt.Errorf("plan missing shard %q", sh.ID)
		}
	}
	for i, s := range in.Sites {
		if used[i] > s.Capacity {
			return fmt.Errorf("site %q: %d replicas exceed capacity %d", s.ID, used[i], s.Capacity)
		}
	}
	if total != p.TotalCost {
		return fmt.Errorf("plan total cost %d does not match replica sum %d", p.TotalCost, total)
	}
	if p.TotalCost > in.Budget {
		return fmt.Errorf("total cost %d exceeds budget %d", p.TotalCost, in.Budget)
	}
	return nil
}

// Certificate produces a human-readable proof that the plan satisfies every
// constraint: per-shard replica count and fault-domain diversity, per-site
// capacity usage, and the budget check.
func Certificate(in *Input, p *Plan) []string {
	var lines []string
	for _, sp := range p.Shards {
		doms := make([]string, 0, len(sp.Replicas))
		for _, r := range sp.Replicas {
			doms = append(doms, fmt.Sprintf("%s(site=%s)", r.Domain, r.Site))
		}
		lines = append(lines, fmt.Sprintf("shard %s: %d replicas >= k=%d; fault domains [%s] pairwise distinct",
			sp.Shard, len(sp.Replicas), in.K, strings.Join(doms, ", ")))
	}
	used := make(map[string]int)
	for _, sp := range p.Shards {
		for _, r := range sp.Replicas {
			used[r.Site]++
		}
	}
	for _, s := range in.Sites {
		lines = append(lines, fmt.Sprintf("site %s: %d replicas <= capacity %d", s.ID, used[s.ID], s.Capacity))
	}
	lines = append(lines, fmt.Sprintf("total cost %d <= budget %d", p.TotalCost, in.Budget))
	return lines
}

// --- min-cost max-flow (SPFA-based successive shortest paths) ---

type edge struct {
	to, rev, cap int
	cost         int64
}

type mcmf struct {
	g [][]edge
}

func newMCMF(n int) *mcmf {
	return &mcmf{g: make([][]edge, n)}
}

func (m *mcmf) addEdge(u, v, cap int, cost int64) {
	m.g[u] = append(m.g[u], edge{to: v, rev: len(m.g[v]), cap: cap, cost: cost})
	m.g[v] = append(m.g[v], edge{to: u, rev: len(m.g[u]) - 1, cap: 0, cost: -cost})
}

func (m *mcmf) minCostFlow(s, t, maxf int) (int, int64) {
	const inf = int64(1) << 62
	n := len(m.g)
	flow := 0
	var cost int64
	for flow < maxf {
		dist := make([]int64, n)
		inq := make([]bool, n)
		prevv := make([]int, n)
		preve := make([]int, n)
		for i := range dist {
			dist[i] = inf
		}
		dist[s] = 0
		q := []int{s}
		inq[s] = true
		for len(q) > 0 {
			u := q[0]
			q = q[1:]
			inq[u] = false
			for i, e := range m.g[u] {
				if e.cap > 0 && dist[e.to] > dist[u]+e.cost {
					dist[e.to] = dist[u] + e.cost
					prevv[e.to] = u
					preve[e.to] = i
					if !inq[e.to] {
						q = append(q, e.to)
						inq[e.to] = true
					}
				}
			}
		}
		if dist[t] == inf {
			break
		}
		d := maxf - flow
		for v := t; v != s; v = prevv[v] {
			if c := m.g[prevv[v]][preve[v]].cap; c < d {
				d = c
			}
		}
		flow += d
		cost += int64(d) * dist[t]
		for v := t; v != s; v = prevv[v] {
			e := &m.g[prevv[v]][preve[v]]
			e.cap -= d
			m.g[v][e.rev].cap += d
		}
	}
	return flow, cost
}
