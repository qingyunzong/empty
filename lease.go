// Package leasesim simulates lease grants confirmed by voters spread
// across fault domains.
//
// A lease becomes effective once it collects a certificate: a set of
// grants from distinct voters whose summed weight reaches the configured
// weight threshold and whose distinct fault domains reach the configured
// domain threshold. A voter never grants two leases whose time intervals
// overlap. All time instants are modelled with half-open intervals
// [Start, End), so two leases that merely touch in time do not conflict.
//
// Safety property: no two valid certificates conflict, where two
// certificates conflict iff their intervals overlap and their voter sets
// are disjoint. Overlapping certificates that share a voter rely on the
// same grant of that voter (the voter cannot have issued a different
// overlapping grant), so they describe the same lease and are compatible.
// The property holds whenever every two quorums intersect, which is
// guaranteed when 2*WeightThreshold > total weight and
// 2*DomainThreshold > total domains (see QuorumIntersectionGuaranteed).
package leasesim

import (
	"fmt"
	"math"
	"sort"
)

// Interval is a half-open time interval [Start, End): it contains every
// instant t with Start <= t < End.
type Interval struct {
	Start, End int64
}

// Valid reports whether the interval is non-empty.
func (iv Interval) Valid() bool { return iv.Start < iv.End }

// Overlaps reports whether the two half-open intervals share at least one
// instant. Touching intervals such as [0,2) and [2,4) do not overlap, and
// an empty interval overlaps nothing.
func (iv Interval) Overlaps(o Interval) bool {
	return iv.Valid() && o.Valid() && iv.Start < o.End && o.Start < iv.End
}

// Intersect returns the intersection of the two intervals and whether it
// is non-empty.
func (iv Interval) Intersect(o Interval) (Interval, bool) {
	r := Interval{Start: max(iv.Start, o.Start), End: min(iv.End, o.End)}
	return r, r.Valid()
}

// Voter confirms leases. Each voter belongs to exactly one fault domain
// and carries a positive weight.
type Voter struct {
	ID     string
	Domain string
	Weight int
}

// Config describes the electorate and the certificate thresholds.
type Config struct {
	Voters          []Voter
	WeightThreshold int // minimum summed voter weight of a certificate
	DomainThreshold int // minimum number of distinct fault domains
}

// Validate checks the configuration for consistency.
func (c Config) Validate() error {
	if len(c.Voters) == 0 {
		return fmt.Errorf("leasesim: no voters")
	}
	if c.WeightThreshold <= 0 {
		return fmt.Errorf("leasesim: weight threshold must be positive, got %d", c.WeightThreshold)
	}
	if c.DomainThreshold <= 0 {
		return fmt.Errorf("leasesim: domain threshold must be positive, got %d", c.DomainThreshold)
	}
	seen := make(map[string]bool, len(c.Voters))
	for _, v := range c.Voters {
		if v.ID == "" {
			return fmt.Errorf("leasesim: voter with empty ID")
		}
		if seen[v.ID] {
			return fmt.Errorf("leasesim: duplicate voter %q", v.ID)
		}
		seen[v.ID] = true
		if v.Weight <= 0 {
			return fmt.Errorf("leasesim: voter %q has non-positive weight %d", v.ID, v.Weight)
		}
		if v.Domain == "" {
			return fmt.Errorf("leasesim: voter %q has empty domain", v.ID)
		}
	}
	return nil
}

// TotalWeight returns the summed weight of all voters.
func (c Config) TotalWeight() int {
	total := 0
	for _, v := range c.Voters {
		total += v.Weight
	}
	return total
}

// TotalDomains returns the number of distinct fault domains.
func (c Config) TotalDomains() int {
	domains := make(map[string]bool, len(c.Voters))
	for _, v := range c.Voters {
		domains[v.Domain] = true
	}
	return len(domains)
}

// QuorumIntersectionGuaranteed reports whether the thresholds suffice to
// guarantee that every two quorums share at least one voter: two disjoint
// quorums would need 2*WeightThreshold weight and 2*DomainThreshold
// distinct domains, more than the electorate has.
func (c Config) QuorumIntersectionGuaranteed() bool {
	return 2*c.WeightThreshold > c.TotalWeight() && 2*c.DomainThreshold > c.TotalDomains()
}

// Grant records that a voter confirmed a lease over an interval.
type Grant struct {
	Voter    string
	Interval Interval
}

// History is a consistent record of the grants issued by every voter.
// It rejects any grant that would make a voter hold two overlapping
// leases.
type History struct {
	cfg    Config
	voters map[string]Voter
	grants map[string][]Interval // per voter ID, pairwise non-overlapping
}

// NewHistory validates the configuration and returns an empty history.
func NewHistory(cfg Config) (*History, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	h := &History{
		cfg:    cfg,
		voters: make(map[string]Voter, len(cfg.Voters)),
		grants: make(map[string][]Interval, len(cfg.Voters)),
	}
	for _, v := range cfg.Voters {
		h.voters[v.ID] = v
	}
	return h, nil
}

// Config returns the configuration the history was created with.
func (h *History) Config() Config { return h.cfg }

// Add records a grant. It fails if the voter is unknown, the interval is
// empty, or the voter already granted a lease overlapping the interval.
func (h *History) Add(g Grant) error {
	if _, ok := h.voters[g.Voter]; !ok {
		return fmt.Errorf("leasesim: unknown voter %q", g.Voter)
	}
	if !g.Interval.Valid() {
		return fmt.Errorf("leasesim: voter %q granted empty interval [%d,%d)", g.Voter, g.Interval.Start, g.Interval.End)
	}
	for _, iv := range h.grants[g.Voter] {
		if iv.Overlaps(g.Interval) {
			return fmt.Errorf("leasesim: voter %q already granted [%d,%d) overlapping [%d,%d)",
				g.Voter, iv.Start, iv.End, g.Interval.Start, g.Interval.End)
		}
	}
	h.grants[g.Voter] = append(h.grants[g.Voter], g.Interval)
	sort.Slice(h.grants[g.Voter], func(i, j int) bool {
		return h.grants[g.Voter][i].Start < h.grants[g.Voter][j].Start
	})
	return nil
}

// Grants returns the grants issued by the given voter, sorted by start.
func (h *History) Grants(voter string) []Interval {
	return append([]Interval(nil), h.grants[voter]...)
}

// Certificate is a proof that a lease holds over Interval: a set of
// grants, one per voter, whose intervals all cover Interval and whose
// weight and domain count meet the thresholds.
type Certificate struct {
	Interval Interval
	Grants   []Grant  // one grant per voter, sorted by voter ID
	Weight   int      // summed weight of the voters
	Domains  []string // distinct fault domains, sorted
}

// voterSet returns the set of voters backing the certificate.
func (c Certificate) voterSet() map[string]bool {
	set := make(map[string]bool, len(c.Grants))
	for _, g := range c.Grants {
		set[g.Voter] = true
	}
	return set
}

// Conflicts reports whether the two certificates represent two different
// leases held at the same instant: their intervals overlap and they share
// no voter. Certificates that overlap but share a voter are compatible,
// because the shared voter cannot have issued them different overlapping
// grants, so both rest on the same grant and describe the same lease.
func (c Certificate) Conflicts(o Certificate) bool {
	if !c.Interval.Overlaps(o.Interval) {
		return false
	}
	other := o.voterSet()
	for _, g := range c.Grants {
		if other[g.Voter] {
			return false
		}
	}
	return true
}

// Certificates enumerates every valid certificate contained in the
// history: for every subset of voters meeting the thresholds and every
// choice of one grant per voter, the intersection of the grant intervals,
// kept when non-empty. It is exponential in the number of voters and is
// meant for simulating small histories.
func (h *History) Certificates() []Certificate {
	ids := make([]string, 0, len(h.cfg.Voters))
	for _, v := range h.cfg.Voters {
		ids = append(ids, v.ID)
	}
	var certs []Certificate
	for mask := 1; mask < 1<<len(ids); mask++ {
		var members []string
		weight := 0
		domainSet := make(map[string]bool)
		for i, id := range ids {
			if mask&(1<<i) == 0 {
				continue
			}
			v := h.voters[id]
			members = append(members, id)
			weight += v.Weight
			domainSet[v.Domain] = true
		}
		if weight < h.cfg.WeightThreshold || len(domainSet) < h.cfg.DomainThreshold {
			continue
		}
		domains := make([]string, 0, len(domainSet))
		for d := range domainSet {
			domains = append(domains, d)
		}
		sort.Strings(domains)
		certs = append(certs, h.productCerts(members, weight, domains)...)
	}
	return certs
}

// productCerts enumerates the certificates of one voter subset by taking
// the cartesian product of the members' grants.
func (h *History) productCerts(members []string, weight int, domains []string) []Certificate {
	var out []Certificate
	var rec func(k int, iv Interval, grants []Grant)
	rec = func(k int, iv Interval, grants []Grant) {
		if k == len(members) {
			out = append(out, Certificate{
				Interval: iv,
				Grants:   append([]Grant(nil), grants...),
				Weight:   weight,
				Domains:  domains,
			})
			return
		}
		for _, g := range h.grants[members[k]] {
			next, ok := iv.Intersect(g)
			if !ok {
				continue
			}
			rec(k+1, next, append(grants, Grant{Voter: members[k], Interval: g}))
		}
	}
	rec(0, Interval{Start: math.MinInt64, End: math.MaxInt64}, nil)
	return out
}

// CheckSafety searches the history for two conflicting valid
// certificates. It returns the first conflicting pair found, or nil if
// the history is safe.
func (h *History) CheckSafety() (a, b *Certificate) {
	certs := h.Certificates()
	for i := range certs {
		for j := i + 1; j < len(certs); j++ {
			if certs[i].Conflicts(certs[j]) {
				return &certs[i], &certs[j]
			}
		}
	}
	return nil, nil
}
