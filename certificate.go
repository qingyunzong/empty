package main

import "fmt"

// DimValue is a human-readable (dimension, value) endpoint.
type DimValue struct {
	Dim   string `json:"dim"`
	Value string `json:"value"`
}

// PairJSON is a human-readable pair of endpoints.
type PairJSON struct {
	A DimValue `json:"a"`
	B DimValue `json:"b"`
}

// ConfigEntry is one chosen configuration with its legality attestation.
type ConfigEntry struct {
	Index  int        `json:"index"`
	Values Assignment `json:"values"`
	Legal  bool       `json:"legal"`
}

// CoverageEntry attests that one legal pair is covered by one config.
type CoverageEntry struct {
	Pair   PairJSON `json:"pair"`
	Config int      `json:"config"`
}

// Minimality records the exhaustive-subset-enumeration check for small sets.
type Minimality struct {
	Method           string `json:"method"`
	LegalConfigCount int    `json:"legalConfigCount"`
	OptimalSize      int    `json:"optimalSize"`
	SolutionSize     int    `json:"solutionSize"`
	Verified         bool   `json:"verified"`
}

// Certificate is a self-contained proof of legality and pairwise coverage.
type Certificate struct {
	ConfigCount      int             `json:"configCount"`
	MaxConfigs       int             `json:"maxConfigs"`
	Configs          []ConfigEntry   `json:"configs"`
	Coverage         []CoverageEntry `json:"coverage"`
	UncoverablePairs []PairJSON      `json:"uncoverablePairs"`
	UncoveredPairs   []PairJSON      `json:"uncoveredPairs,omitempty"`
	Minimality       *Minimality     `json:"minimality,omitempty"`
}

func (s *Spec) pairToJSON(p Pair) PairJSON {
	return PairJSON{
		A: DimValue{s.Dimensions[p.D1].Name, s.Dimensions[p.D1].Values[p.V1]},
		B: DimValue{s.Dimensions[p.D2].Name, s.Dimensions[p.D2].Values[p.V2]},
	}
}

func (s *Spec) pairFromJSON(pj PairJSON) (Pair, error) {
	di := s.dimIndex()
	vi := s.valueIndex()
	d1, ok := di[pj.A.Dim]
	if !ok {
		return Pair{}, fmt.Errorf("unknown dimension %q", pj.A.Dim)
	}
	d2, ok := di[pj.B.Dim]
	if !ok {
		return Pair{}, fmt.Errorf("unknown dimension %q", pj.B.Dim)
	}
	v1, ok := vi[d1][pj.A.Value]
	if !ok {
		return Pair{}, fmt.Errorf("unknown value %q of dimension %q", pj.A.Value, pj.A.Dim)
	}
	v2, ok := vi[d2][pj.B.Value]
	if !ok {
		return Pair{}, fmt.Errorf("unknown value %q of dimension %q", pj.B.Value, pj.B.Dim)
	}
	if d1 == d2 {
		return Pair{}, fmt.Errorf("pair endpoints share dimension %q", pj.A.Dim)
	}
	if d2 < d1 {
		d1, v1, d2, v2 = d2, v2, d1, v1
	}
	return Pair{d1, v1, d2, v2}, nil
}

func configToAssignment(s *Spec, cfg []int) Assignment {
	a := make(Assignment, len(cfg))
	for i, v := range cfg {
		a[s.Dimensions[i].Name] = s.Dimensions[i].Values[v]
	}
	return a
}

// BuildCertificate solves the spec and assembles the certificate.
// exactLimit bounds the legal-config universe size for the exhaustive
// subset-enumeration minimality check (0 disables the check).
func BuildCertificate(s *Spec, maxConfigs, exactLimit int) (*Certificate, error) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	if maxConfigs < 1 {
		return nil, fmt.Errorf("maxConfigs must be >= 1")
	}
	cs := compile(s)
	all := AllPairs(s)
	var coverable, uncoverable []Pair
	for _, p := range all {
		if Coverable(cs, p) {
			coverable = append(coverable, p)
		} else {
			uncoverable = append(uncoverable, p)
		}
	}
	configs, coverMap, leftover := GreedyCover(cs, coverable, maxConfigs)

	cert := &Certificate{MaxConfigs: maxConfigs}
	for i, cfg := range configs {
		cert.Configs = append(cert.Configs, ConfigEntry{
			Index:  i,
			Values: configToAssignment(s, cfg),
			Legal:  cs.Legal(cfg),
		})
	}
	for _, p := range coverable {
		if idx, ok := coverMap[p]; ok {
			cert.Coverage = append(cert.Coverage, CoverageEntry{Pair: s.pairToJSON(p), Config: idx})
		}
	}
	for _, p := range uncoverable {
		cert.UncoverablePairs = append(cert.UncoverablePairs, s.pairToJSON(p))
	}
	for _, p := range leftover {
		cert.UncoveredPairs = append(cert.UncoveredPairs, s.pairToJSON(p))
	}
	cert.ConfigCount = len(cert.Configs)

	// Small-set check: enumerate the full legal-config universe and verify
	// minimality by exhaustive subset enumeration.
	if exactLimit > 0 && len(leftover) == 0 {
		if legal, ok := EnumerateLegal(cs, exactLimit); ok {
			optConfigs, optSize := ExactMinCover(legal, coverable, len(configs))
			if optConfigs != nil && optSize < len(configs) {
				// Greedy was not minimal; adopt the optimal solution instead.
				return rebuildWith(s, cs, optConfigs, coverable, uncoverable, maxConfigs, len(legal))
			}
			cert.Minimality = &Minimality{
				Method:           "exhaustive-subset-enumeration",
				LegalConfigCount: len(legal),
				OptimalSize:      optSize,
				SolutionSize:     len(configs),
				Verified:         optSize == len(configs),
			}
		}
	}
	return cert, nil
}

// rebuildWith swaps in the optimal config set and re-derives coverage.
func rebuildWith(s *Spec, cs *compiledSpec, configs [][]int, coverable, uncoverable []Pair, maxConfigs, legalCount int) (*Certificate, error) {
	cert := &Certificate{MaxConfigs: maxConfigs}
	coverMap := make(map[Pair]int)
	for i, cfg := range configs {
		cert.Configs = append(cert.Configs, ConfigEntry{
			Index:  i,
			Values: configToAssignment(s, cfg),
			Legal:  cs.Legal(cfg),
		})
		for _, p := range pairsOf(cfg) {
			if _, done := coverMap[p]; !done {
				coverMap[p] = i
			}
		}
	}
	for _, p := range coverable {
		idx, ok := coverMap[p]
		if !ok {
			return nil, fmt.Errorf("internal: optimal set does not cover a coverable pair")
		}
		cert.Coverage = append(cert.Coverage, CoverageEntry{Pair: s.pairToJSON(p), Config: idx})
	}
	for _, p := range uncoverable {
		cert.UncoverablePairs = append(cert.UncoverablePairs, s.pairToJSON(p))
	}
	cert.ConfigCount = len(cert.Configs)
	cert.Minimality = &Minimality{
		Method:           "exhaustive-subset-enumeration",
		LegalConfigCount: legalCount,
		OptimalSize:      len(configs),
		SolutionSize:     len(configs),
		Verified:         true,
	}
	return cert, nil
}

// VerifyCertificate independently re-checks every claim in the certificate.
// It returns a list of violations; an empty list means the proof is valid.
func VerifyCertificate(s *Spec, cert *Certificate, exactLimit int) []string {
	var bad []string
	if err := s.Validate(); err != nil {
		return []string{"invalid spec: " + err.Error()}
	}
	cs := compile(s)

	// 1. Every listed config is complete and legal.
	var configs [][]int
	for _, ce := range cert.Configs {
		cfg, err := assignmentToConfig(s, ce.Values)
		if err != nil {
			bad = append(bad, fmt.Sprintf("config %d: %v", ce.Index, err))
			continue
		}
		if !cs.Legal(cfg) {
			bad = append(bad, fmt.Sprintf("config %d is illegal: %v", ce.Index, ce.Values))
		}
		if !ce.Legal {
			bad = append(bad, fmt.Sprintf("config %d not attested legal", ce.Index))
		}
		configs = append(configs, cfg)
	}
	if cert.ConfigCount != len(cert.Configs) {
		bad = append(bad, fmt.Sprintf("configCount %d != %d listed configs", cert.ConfigCount, len(cert.Configs)))
	}
	if len(cert.Configs) > cert.MaxConfigs {
		bad = append(bad, fmt.Sprintf("%d configs exceed cap %d", len(cert.Configs), cert.MaxConfigs))
	}

	// 2. Partition check: every pair appears in exactly one category.
	coveredSet := map[Pair]int{}
	for _, ce := range cert.Coverage {
		p, err := s.pairFromJSON(ce.Pair)
		if err != nil {
			bad = append(bad, "coverage: "+err.Error())
			continue
		}
		if ce.Config < 0 || ce.Config >= len(configs) {
			bad = append(bad, fmt.Sprintf("coverage of %+v references missing config %d", p, ce.Config))
			continue
		}
		cfg := configs[ce.Config]
		if cfg == nil || cfg[p.D1] != p.V1 || cfg[p.D2] != p.V2 {
			bad = append(bad, fmt.Sprintf("config %d does not contain claimed pair %+v", ce.Config, p))
			continue
		}
		coveredSet[p] = ce.Config
	}
	uncoverableSet := map[Pair]bool{}
	for _, pj := range cert.UncoverablePairs {
		p, err := s.pairFromJSON(pj)
		if err != nil {
			bad = append(bad, "uncoverable: "+err.Error())
			continue
		}
		uncoverableSet[p] = true
		// Uncoverability must hold: no legal config may extend the pair.
		if Coverable(cs, p) {
			bad = append(bad, fmt.Sprintf("pair %+v listed uncoverable but is coverable", p))
		}
	}
	uncoveredSet := map[Pair]bool{}
	for _, pj := range cert.UncoveredPairs {
		p, err := s.pairFromJSON(pj)
		if err != nil {
			bad = append(bad, "uncovered: "+err.Error())
			continue
		}
		uncoveredSet[p] = true
		if !Coverable(cs, p) {
			bad = append(bad, fmt.Sprintf("pair %+v listed uncovered-due-to-cap but is uncoverable", p))
		}
	}
	for _, p := range AllPairs(s) {
		_, cov := coveredSet[p]
		unc := uncoverableSet[p]
		left := uncoveredSet[p]
		n := 0
		for _, b := range []bool{cov, unc, left} {
			if b {
				n++
			}
		}
		if n != 1 {
			bad = append(bad, fmt.Sprintf("pair %+v appears in %d categories (want 1)", p, n))
		}
	}
	// Uncovered-due-to-cap is only acceptable when the cap was fully used.
	if len(cert.UncoveredPairs) > 0 && len(cert.Configs) < cert.MaxConfigs {
		bad = append(bad, "uncovered pairs reported although config cap was not reached")
	}

	// 3. Minimality claim: re-run the exhaustive subset enumeration.
	if cert.Minimality != nil {
		m := cert.Minimality
		if m.Method != "exhaustive-subset-enumeration" {
			bad = append(bad, "unknown minimality method "+m.Method)
		} else if exactLimit > 0 {
			legal, ok := EnumerateLegal(cs, exactLimit)
			if !ok {
				bad = append(bad, "cannot re-verify minimality: legal universe exceeds exact limit")
			} else {
				if m.LegalConfigCount != len(legal) {
					bad = append(bad, fmt.Sprintf("minimality legalConfigCount %d != %d", m.LegalConfigCount, len(legal)))
				}
				var targets []Pair
				for p := range coveredSet {
					targets = append(targets, p)
				}
				for p := range uncoveredSet {
					targets = append(targets, p)
				}
				_, optSize := ExactMinCover(legal, targets, len(cert.Configs))
				if optSize != m.OptimalSize {
					bad = append(bad, fmt.Sprintf("minimality optimalSize %d != recomputed %d", m.OptimalSize, optSize))
				}
				if m.SolutionSize != len(cert.Configs) {
					bad = append(bad, fmt.Sprintf("minimality solutionSize %d != %d configs", m.SolutionSize, len(cert.Configs)))
				}
				if m.Verified && m.OptimalSize != m.SolutionSize {
					bad = append(bad, "minimality marked verified but optimalSize != solutionSize")
				}
			}
		}
	}
	return bad
}

func assignmentToConfig(s *Spec, a Assignment) ([]int, error) {
	if len(a) != len(s.Dimensions) {
		return nil, fmt.Errorf("assignment has %d dims, spec has %d", len(a), len(s.Dimensions))
	}
	di := s.dimIndex()
	vi := s.valueIndex()
	cfg := make([]int, len(s.Dimensions))
	for name, val := range a {
		d, ok := di[name]
		if !ok {
			return nil, fmt.Errorf("unknown dimension %q", name)
		}
		v, ok := vi[d][val]
		if !ok {
			return nil, fmt.Errorf("unknown value %q of dimension %q", val, name)
		}
		cfg[d] = v
	}
	return cfg, nil
}
