package authz

import "fmt"

// ScanAll computes the effective decision for every (node, user) pair
// reachable from root, independently of Evaluate: it walks the tree
// top-down, carrying the inherited decision. A node's own matching rules
// replace the inherited decision for its whole subtree; otherwise the
// inherited decision propagates unchanged.
//
// users must list every registered user (see Directory.Users).
func ScanAll(root *Node, d *Directory, users []string) map[string]map[string]Decision {
	result := map[string]map[string]Decision{}
	for _, user := range users {
		result[user] = map[string]Decision{}
		scanNode(root, d, user, Decision{}, result[user])
	}
	return result
}

func scanNode(n *Node, d *Directory, user string, inherited Decision, out map[string]Decision) {
	// Only the rules physically attached to n may replace the inherited
	// decision; ancestors are never consulted in this pass.
	effective := inherited
	if level := localLevel(n, d, user); level.Matched {
		level.Path = []string{n.Name}
		effective = level
	} else {
		effective.Path = append([]string{n.Name}, inherited.Path...)
	}
	out[n.Name] = effective
	for _, c := range n.Children {
		scanNode(c, d, user, effective, out)
	}
}

// localLevel evaluates only the rules physically attached to n.
func localLevel(n *Node, d *Directory, user string) Decision {
	paths := d.GroupPaths(user)
	var hits []Hit
	for _, r := range n.Rules {
		if r.Subject == user {
			hits = append(hits, Hit{Node: n.Name, Subject: r.Subject, Effect: r.Effect})
		} else if via, ok := paths[r.Subject]; ok {
			hits = append(hits, Hit{Node: n.Name, Subject: r.Subject, Via: via, Effect: r.Effect})
		}
	}
	if len(hits) == 0 {
		return Decision{}
	}
	dec := Decision{Matched: true, Allowed: true, Hits: hits}
	for _, h := range hits {
		if h.Effect == Deny {
			dec.Allowed = false
			break
		}
	}
	return dec
}

// Verify cross-checks Evaluate (bottom-up, nearest-level shadowing) against
// ScanAll (top-down, full reachable scan) for every node and user. It
// returns one entry per disagreement; an empty slice means both
// implementations agree everywhere.
func Verify(root *Node, d *Directory, users []string) []string {
	scanned := ScanAll(root, d, users)
	var problems []string
	var walk func(n *Node)
	walk = func(n *Node) {
		for _, user := range users {
			got := Evaluate(n, d, user)
			want := scanned[user][n.Name]
			if !sameDecision(got, want) {
				problems = append(problems, fmt.Sprintf(
					"node %q user %q: Evaluate=%s but scan=%s",
					n.Name, user, got, want))
			}
		}
		for _, c := range n.Children {
			walk(c)
		}
	}
	walk(root)
	return problems
}

func sameDecision(a, b Decision) bool {
	if a.Allowed != b.Allowed || a.Matched != b.Matched {
		return false
	}
	if len(a.Hits) != len(b.Hits) {
		return false
	}
	for i := range a.Hits {
		if a.Hits[i].Node != b.Hits[i].Node ||
			a.Hits[i].Subject != b.Hits[i].Subject ||
			a.Hits[i].Effect != b.Hits[i].Effect {
			return false
		}
	}
	return true
}
