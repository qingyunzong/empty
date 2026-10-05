// Package main implements a replica placement planner CLI.
//
// Problem: given up to 20 sites (datacenters), each with a failure
// domain, a capacity (max number of replicas it may host) and an
// access cost, place the replicas of up to 8 shards. Every shard
// needs at least k replicas, and the replicas of one shard must sit
// in pairwise distinct failure domains. The total access cost must
// not exceed the budget; among all feasible placements the tool
// finds one of minimum cost and emits a machine-checkable
// failure-domain and capacity certificate.
package main

import (
	"errors"
	"fmt"
	"sort"
)

// Limits required by the specification.
const (
	MaxSites  = 20
	MaxShards = 8
)

// Site is a datacenter candidate.
type Site struct {
	ID       string `json:"id"`
	Domain   string `json:"domain"`   // failure domain identifier
	Capacity int    `json:"capacity"` // max replicas hosted
	Cost     int    `json:"cost"`     // access fee per replica placed here
}

// Shard describes one shard's replication requirement.
type Shard struct {
	ID       string `json:"id"`
	Replicas int    `json:"replicas"` // k: minimum number of replicas
}

// Problem is the planner input.
type Problem struct {
	Budget int     `json:"budget"`
	Sites  []Site  `json:"sites"`
	Shards []Shard `json:"shards"`
}

// Validate checks structural constraints of the input.
func (p *Problem) Validate() error {
	if len(p.Sites) == 0 {
		return errors.New("no sites given")
	}
	if len(p.Sites) > MaxSites {
		return fmt.Errorf("too many sites: %d > %d", len(p.Sites), MaxSites)
	}
	if len(p.Shards) == 0 {
		return errors.New("no shards given")
	}
	if len(p.Shards) > MaxShards {
		return fmt.Errorf("too many shards: %d > %d", len(p.Shards), MaxShards)
	}
	if p.Budget < 0 {
		return fmt.Errorf("negative budget %d", p.Budget)
	}
	seenSite := map[string]bool{}
	for _, s := range p.Sites {
		if s.ID == "" {
			return errors.New("site with empty id")
		}
		if s.Domain == "" {
			return fmt.Errorf("site %q has empty failure domain", s.ID)
		}
		if seenSite[s.ID] {
			return fmt.Errorf("duplicate site id %q", s.ID)
		}
		seenSite[s.ID] = true
		if s.Capacity < 0 {
			return fmt.Errorf("site %q has negative capacity", s.ID)
		}
		if s.Cost < 0 {
			return fmt.Errorf("site %q has negative cost", s.ID)
		}
	}
	seenShard := map[string]bool{}
	for _, sh := range p.Shards {
		if sh.ID == "" {
			return errors.New("shard with empty id")
		}
		if seenShard[sh.ID] {
			return fmt.Errorf("duplicate shard id %q", sh.ID)
		}
		seenShard[sh.ID] = true
		if sh.Replicas < 1 {
			return fmt.Errorf("shard %q needs at least 1 replica, got %d", sh.ID, sh.Replicas)
		}
	}
	return nil
}

// Replica is one placed replica of a shard.
type Replica struct {
	Site   string `json:"site"`
	Domain string `json:"domain"`
	Cost   int    `json:"cost"`
}

// Placement lists the replicas of one shard.
type Placement struct {
	Shard    string    `json:"shard"`
	Replicas []Replica `json:"replicas"`
}

// ShardCert certifies one shard's failure-domain spread.
type ShardCert struct {
	Shard           string   `json:"shard"`
	Required        int      `json:"required"`
	Placed          int      `json:"placed"`
	Domains         []string `json:"domains"`
	DomainsDistinct bool     `json:"domains_distinct"`
	EnoughReplicas  bool     `json:"enough_replicas"`
}

// SiteCert certifies one site's capacity usage.
type SiteCert struct {
	Site           string `json:"site"`
	Domain         string `json:"domain"`
	Used           int    `json:"used"`
	Capacity       int    `json:"capacity"`
	WithinCapacity bool   `json:"within_capacity"`
}

// Certificate is the machine-checkable proof accompanying a plan.
type Certificate struct {
	Shards       []ShardCert `json:"shards"`
	Sites        []SiteCert  `json:"sites"`
	TotalCost    int         `json:"total_cost"`
	Budget       int         `json:"budget"`
	WithinBudget bool        `json:"within_budget"`
	Digest       string      `json:"digest"` // sha256 over canonical placements
}

// Plan is the solver output.
type Plan struct {
	Status      string       `json:"status"` // "optimal" or "infeasible"
	Reason      string       `json:"reason,omitempty"`
	TotalCost   int          `json:"total_cost,omitempty"`
	Placements  []Placement  `json:"placements,omitempty"`
	Certificate *Certificate `json:"certificate,omitempty"`
}

// canonicalPlacements returns placements in a deterministic order so
// that digests are reproducible regardless of solver internals.
func canonicalPlacements(pl []Placement) []Placement {
	out := make([]Placement, len(pl))
	for i, p := range pl {
		rs := make([]Replica, len(p.Replicas))
		copy(rs, p.Replicas)
		sort.Slice(rs, func(a, b int) bool {
			if rs[a].Site != rs[b].Site {
				return rs[a].Site < rs[b].Site
			}
			return rs[a].Domain < rs[b].Domain
		})
		out[i] = Placement{Shard: p.Shard, Replicas: rs}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Shard < out[b].Shard })
	return out
}
