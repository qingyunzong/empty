// Package main implements denydiag, a diagnostic CLI that explains why a
// request is rejected by a set of layered integer-interval rules.
//
// Public semantics (layered inheritance with deny-priority, default ACCEPT):
//
//   - Each rule has an id, an inheritance layer, an action (allow|deny) and
//     an inclusive integer interval [lo, hi]. A rule matches request q iff
//     lo <= q <= hi.
//   - Layers are inheritance levels: an ALLOW at layer L grants access at
//     layer L and the grant is inherited by all higher layers unless revoked.
//   - A DENY at layer L revokes every grant inherited from layers <= L.
//     Deny-priority: at the same layer a DENY beats an ALLOW.
//   - Default policy is ACCEPT: a DENY with no matching ALLOW is moot, and a
//     request matched by nothing is accepted.
//
// Therefore, with A = layers of matching ALLOWs and D = layers of matching
// DENYs:  REJECT(q)  <=>  A != {} and D != {} and max(D) >= max(A).
package main

import (
	"bufio"
	"fmt"
	"io"
	"strings"
)

// MaxRules is the input contract: at most 18 rules, so the exhaustive
// acceptance scan evaluates at most 2^18 subsets.
const MaxRules = 18

type Action int

const (
	Allow Action = iota
	Deny
)

func (a Action) String() string {
	if a == Deny {
		return "deny"
	}
	return "allow"
}

type Rule struct {
	ID    int
	Layer int
	Act   Action
	Lo    int
	Hi    int
}

func (r Rule) Matches(q int) bool { return q >= r.Lo && q <= r.Hi }

func (r Rule) String() string {
	return fmt.Sprintf("id=%d layer=%d %s [%d,%d]", r.ID, r.Layer, r.Act, r.Lo, r.Hi)
}

// Rejected is the authoritative evaluator of the public semantics.
func Rejected(rules []Rule, q int) bool {
	maxAllow, maxDeny := -1, -1
	for _, r := range rules {
		if !r.Matches(q) {
			continue
		}
		if r.Act == Allow {
			if r.Layer > maxAllow {
				maxAllow = r.Layer
			}
		} else {
			if r.Layer > maxDeny {
				maxDeny = r.Layer
			}
		}
	}
	return maxAllow >= 0 && maxDeny >= maxAllow
}

// ParseInput reads the CLI input format:
//
//	line 1:   N Q            (rule count, rejected request)
//	next N:   ID LAYER ACTION LO HI
func ParseInput(r io.Reader) ([]Rule, int, error) {
	sc := bufio.NewScanner(r)
	sc.Split(bufio.ScanWords)
	next := func() (string, error) {
		if !sc.Scan() {
			if err := sc.Err(); err != nil {
				return "", err
			}
			return "", fmt.Errorf("unexpected end of input")
		}
		return sc.Text(), nil
	}
	readInt := func() (int, error) {
		tok, err := next()
		if err != nil {
			return 0, err
		}
		var v int
		if _, err := fmt.Sscanf(tok, "%d", &v); err != nil {
			return 0, fmt.Errorf("invalid integer %q", tok)
		}
		return v, nil
	}

	n, err := readInt()
	if err != nil {
		return nil, 0, fmt.Errorf("reading rule count: %w", err)
	}
	if n < 0 || n > MaxRules {
		return nil, 0, fmt.Errorf("rule count %d out of range [0,%d]", n, MaxRules)
	}
	q, err := readInt()
	if err != nil {
		return nil, 0, fmt.Errorf("reading request: %w", err)
	}

	rules := make([]Rule, 0, n)
	seen := make(map[int]bool, n)
	for i := 0; i < n; i++ {
		var rule Rule
		var act string
		if rule.ID, err = readInt(); err != nil {
			return nil, 0, fmt.Errorf("rule %d: %w", i+1, err)
		}
		if rule.Layer, err = readInt(); err != nil {
			return nil, 0, fmt.Errorf("rule %d: %w", i+1, err)
		}
		if rule.Layer < 0 {
			return nil, 0, fmt.Errorf("rule %d: negative layer %d", i+1, rule.Layer)
		}
		if act, err = next(); err != nil {
			return nil, 0, fmt.Errorf("rule %d: %w", i+1, err)
		}
		switch strings.ToLower(act) {
		case "allow":
			rule.Act = Allow
		case "deny":
			rule.Act = Deny
		default:
			return nil, 0, fmt.Errorf("rule %d: unknown action %q", i+1, act)
		}
		if rule.Lo, err = readInt(); err != nil {
			return nil, 0, fmt.Errorf("rule %d: %w", i+1, err)
		}
		if rule.Hi, err = readInt(); err != nil {
			return nil, 0, fmt.Errorf("rule %d: %w", i+1, err)
		}
		if rule.Lo > rule.Hi {
			return nil, 0, fmt.Errorf("rule %d: empty interval [%d,%d]", i+1, rule.Lo, rule.Hi)
		}
		if seen[rule.ID] {
			return nil, 0, fmt.Errorf("rule %d: duplicate id %d", i+1, rule.ID)
		}
		seen[rule.ID] = true
		rules = append(rules, rule)
	}
	return rules, q, nil
}
