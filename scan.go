package authz

import "fmt"

// FullScan enumerates every rule on the path from res to the root that
// matches (user, action), regardless of shadowing. It is the
// brute-force reference used to cross-check Evaluate.
func FullScan(user, action string, res *Node, gs *Groups) []Hit {
	reach := gs.Reachable(user)
	var hits []Hit
	depth := 0
	for node := res; node != nil; node = node.Parent {
		for _, r := range node.Rules {
			if !r.matchesAction(action) {
				continue
			}
			var chain []string
			switch {
			case r.Subject == user:
				chain = []string{user}
			default:
				path, ok := reach[r.Subject]
				if !ok {
					continue
				}
				chain = path
			}
			hits = append(hits, Hit{Node: node, Rule: r, Depth: depth, GroupChain: chain})
		}
		depth++
	}
	return hits
}

// DecideFromScan derives a decision from a full scan using the same
// semantics as Evaluate: nearest depth wins, deny beats allow there.
func DecideFromScan(hits []Hit) Decision {
	if len(hits) == 0 {
		return Decision{Allowed: false, Matched: false}
	}
	nearest := hits[0].Depth
	var level []Hit
	allowed := true
	for _, h := range hits {
		if h.Depth != nearest {
			continue
		}
		level = append(level, h)
		if h.Rule.Effect == Deny {
			allowed = false
		}
	}
	return Decision{Allowed: allowed, Matched: true, Hits: level}
}

// CrossCheck verifies that Evaluate agrees with the full reachable scan
// for (user, action, res): same matched flag, same outcome, and exactly
// the same set of deciding hits. It returns a descriptive error on any
// divergence.
func CrossCheck(user, action string, res *Node, gs *Groups) error {
	got := Evaluate(user, action, res, gs)
	want := DecideFromScan(FullScan(user, action, res, gs))

	if got.Matched != want.Matched {
		return fmt.Errorf("matched mismatch: Evaluate=%v scan=%v", got.Matched, want.Matched)
	}
	if got.Allowed != want.Allowed {
		return fmt.Errorf("outcome mismatch: Evaluate=%v scan=%v", got.Allowed, want.Allowed)
	}
	if len(got.Hits) != len(want.Hits) {
		return fmt.Errorf("hit count mismatch: Evaluate=%d scan=%d", len(got.Hits), len(want.Hits))
	}
	type key struct {
		nodeID  string
		subject string
		action  string
		effect  Effect
	}
	count := make(map[key]int)
	for _, h := range got.Hits {
		count[key{h.Node.ID, h.Rule.Subject, h.Rule.Action, h.Rule.Effect}]++
	}
	for _, h := range want.Hits {
		k := key{h.Node.ID, h.Rule.Subject, h.Rule.Action, h.Rule.Effect}
		count[k]--
		if count[k] < 0 {
			return fmt.Errorf("scan hit not reported by Evaluate: %+v", h.Rule)
		}
	}
	for k, n := range count {
		if n != 0 {
			return fmt.Errorf("Evaluate hit not present in scan: %+v", k)
		}
	}
	return nil
}
