// Package leasesim simulates a lease protocol in which voters located in
// distinct fault domains confirm leases. A lease certificate is valid only
// when the confirming voters satisfy both a total-weight threshold and a
// distinct fault-domain threshold. A voter never grants two leases whose
// time intervals overlap. All time intervals are half-open: [Start, End).
package leasesim

import "fmt"

// Interval is a half-open time interval [Start, End).
type Interval struct {
	Start int64
	End   int64
}

// Valid reports whether the interval is non-empty.
func (a Interval) Valid() bool { return a.Start < a.End }

// Overlaps reports whether two half-open intervals share any point in time.
// Adjacent intervals such as [0,1) and [1,2) do not overlap.
func (a Interval) Overlaps(b Interval) bool {
	return a.Start < b.End && b.Start < a.End
}

// Voter confirms leases. Each voter carries a weight and belongs to a fault
// domain.
type Voter struct {
	ID     string
	Weight int
	Domain string
}

// Config describes the voter set and the thresholds a certificate must meet.
type Config struct {
	Voters          []Voter
	WeightThreshold int
	DomainThreshold int
}

// TotalWeight returns the summed weight of all voters.
func (cfg Config) TotalWeight() int {
	total := 0
	for _, v := range cfg.Voters {
		total += v.Weight
	}
	return total
}

// TotalDomains returns the number of distinct fault domains.
func (cfg Config) TotalDomains() int {
	domains := make(map[string]struct{})
	for _, v := range cfg.Voters {
		domains[v.Domain] = struct{}{}
	}
	return len(domains)
}

// QuorumsIntersect reports whether any two voter sets that each satisfy the
// thresholds must share at least one voter. This is the precondition for the
// safety property "no two valid certificates overlap in time".
func (cfg Config) QuorumsIntersect() bool {
	return 2*cfg.WeightThreshold > cfg.TotalWeight() &&
		2*cfg.DomainThreshold > cfg.TotalDomains()
}

func (cfg Config) voter(id string) (Voter, bool) {
	for _, v := range cfg.Voters {
		if v.ID == id {
			return v, true
		}
	}
	return Voter{}, false
}

// Grant records that one voter confirmed a lease for Holder on Interval.
type Grant struct {
	VoterID  string
	Holder   string
	Interval Interval
}

// Certificate is a set of grants collected for one lease request. Every
// grant in a certificate names the same holder and interval.
type Certificate struct {
	Holder   string
	Interval Interval
	Grants   []Grant
}

// Valid reports whether the certificate satisfies the weight and domain
// thresholds of cfg. Grants from unknown voters or duplicate grants from the
// same voter are ignored.
func (cfg Config) Valid(cert Certificate) bool {
	weight := 0
	domains := make(map[string]struct{})
	seen := make(map[string]struct{})
	for _, g := range cert.Grants {
		if _, dup := seen[g.VoterID]; dup {
			continue
		}
		v, ok := cfg.voter(g.VoterID)
		if !ok {
			continue
		}
		seen[g.VoterID] = struct{}{}
		weight += v.Weight
		domains[v.Domain] = struct{}{}
	}
	return weight >= cfg.WeightThreshold && len(domains) >= cfg.DomainThreshold
}

// Simulator runs lease requests against a voter set. Each voter grants a
// request only when the requested interval does not overlap any lease the
// voter has already granted.
type Simulator struct {
	cfg    Config
	grants map[string][]Grant // granted leases, keyed by voter ID
}

// NewSimulator returns a Simulator for cfg.
func NewSimulator(cfg Config) *Simulator {
	return &Simulator{cfg: cfg, grants: make(map[string][]Grant)}
}

// Request asks every voter to confirm a lease for holder on iv. A voter
// confirms iff iv is valid and does not overlap any lease it previously
// granted. The returned certificate contains the grants collected; use
// Config.Valid to check whether the thresholds were met.
func (s *Simulator) Request(holder string, iv Interval) Certificate {
	cert := Certificate{Holder: holder, Interval: iv}
	if !iv.Valid() {
		return cert
	}
	for _, v := range s.cfg.Voters {
		conflict := false
		for _, g := range s.grants[v.ID] {
			if g.Interval.Overlaps(iv) {
				conflict = true
				break
			}
		}
		if conflict {
			continue
		}
		grant := Grant{VoterID: v.ID, Holder: holder, Interval: iv}
		s.grants[v.ID] = append(s.grants[v.ID], grant)
		cert.Grants = append(cert.Grants, grant)
	}
	return cert
}

// CheckSafety verifies that no two valid certificates held by different
// holders overlap in time. It returns an error describing the first
// violation found, or nil if the history is safe.
func CheckSafety(cfg Config, certs []Certificate) error {
	for i := 0; i < len(certs); i++ {
		if !cfg.Valid(certs[i]) {
			continue
		}
		for j := i + 1; j < len(certs); j++ {
			if certs[i].Holder == certs[j].Holder {
				continue
			}
			if !cfg.Valid(certs[j]) {
				continue
			}
			if certs[i].Interval.Overlaps(certs[j].Interval) {
				return fmt.Errorf("overlapping valid certificates: holder %q on [%d,%d) and holder %q on [%d,%d)",
					certs[i].Holder, certs[i].Interval.Start, certs[i].Interval.End,
					certs[j].Holder, certs[j].Interval.Start, certs[j].Interval.End)
			}
		}
	}
	return nil
}
