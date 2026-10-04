package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Spec is the JSON description of a test-planning instance.
type Spec struct {
	Name      string              `json:"name"`
	Branches  []string            `json:"branches"`
	Features  map[string][]string `json:"features"`
	TimeLimit int                 `json:"time_limit"`
	Tests     []TestSpec          `json:"tests"`
}

// TestSpec describes one candidate test.
type TestSpec struct {
	Name     string            `json:"name"`
	Cost     int               `json:"cost"`
	Duration int               `json:"duration"`
	Requires []string          `json:"requires"`
	Branches []string          `json:"branches"`
	Assign   map[string]string `json:"assign"`
}

const maxTests = 24

func loadSpec(path string) (*Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var s Spec
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if err := s.validate(); err != nil {
		return nil, err
	}
	return &s, nil
}

func (s *Spec) validate() error {
	if len(s.Tests) == 0 {
		return fmt.Errorf("spec has no tests")
	}
	if len(s.Tests) > maxTests {
		return fmt.Errorf("spec has %d tests, maximum supported is %d", len(s.Tests), maxTests)
	}
	if s.TimeLimit < 0 {
		return fmt.Errorf("time_limit must be >= 0")
	}
	seen := map[string]bool{}
	for i := range s.Tests {
		t := &s.Tests[i]
		if t.Name == "" {
			return fmt.Errorf("test #%d has empty name", i)
		}
		if seen[t.Name] {
			return fmt.Errorf("duplicate test name %q", t.Name)
		}
		seen[t.Name] = true
		if t.Cost < 0 || t.Duration < 0 {
			return fmt.Errorf("test %q: cost and duration must be >= 0", t.Name)
		}
	}
	branchSet := map[string]bool{}
	for _, b := range s.Branches {
		if branchSet[b] {
			return fmt.Errorf("duplicate branch %q", b)
		}
		branchSet[b] = true
	}
	for f, vals := range s.Features {
		if len(vals) == 0 {
			return fmt.Errorf("feature %q has no values", f)
		}
		vseen := map[string]bool{}
		for _, v := range vals {
			if vseen[v] {
				return fmt.Errorf("feature %q: duplicate value %q", f, v)
			}
			vseen[v] = true
		}
	}
	for i := range s.Tests {
		t := &s.Tests[i]
		for _, r := range t.Requires {
			if !seen[r] {
				return fmt.Errorf("test %q requires unknown test %q", t.Name, r)
			}
		}
		for _, b := range t.Branches {
			if !branchSet[b] {
				return fmt.Errorf("test %q covers unknown branch %q", t.Name, b)
			}
		}
		for f, v := range t.Assign {
			vals, ok := s.Features[f]
			if !ok {
				return fmt.Errorf("test %q assigns unknown feature %q", t.Name, f)
			}
			found := false
			for _, av := range vals {
				if av == v {
					found = true
					break
				}
			}
			if !found {
				return fmt.Errorf("test %q assigns unknown value %q to feature %q", t.Name, v, f)
			}
		}
	}
	return nil
}

// featureNames returns feature names in deterministic (sorted) order.
func (s *Spec) featureNames() []string {
	names := make([]string, 0, len(s.Features))
	for f := range s.Features {
		names = append(names, f)
	}
	sort.Strings(names)
	return names
}

// pairElement is the canonical universe-element name for a pairwise
// interaction between two feature assignments.
func pairElement(f1, v1, f2, v2 string) string {
	return "pair:" + f1 + "=" + v1 + "&" + f2 + "=" + v2
}

// branchElement is the canonical universe-element name for a public branch.
func branchElement(b string) string {
	return "branch:" + b
}
