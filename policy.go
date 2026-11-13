package dataeng

import "sort"

// ConflictPolicy selects one record from a concurrent conflict set.
// Policies must be deterministic and base their decision only on causal
// metadata and payload; relying on UpdatedAt would make adjudication depend
// on wall clocks, which are explicitly display-only in this library.
type ConflictPolicy interface {
	Resolve(conflicts []Record) (Record, bool)
}

// ConflictPolicyFunc adapts a plain function to ConflictPolicy.
type ConflictPolicyFunc func(conflicts []Record) (Record, bool)

// Resolve implements ConflictPolicy.
func (f ConflictPolicyFunc) Resolve(conflicts []Record) (Record, bool) {
	return f(conflicts)
}

// RetainPolicy is the default policy: it keeps the full conflict set and
// never picks a winner, forcing callers to resolve explicitly.
type RetainPolicy struct{}

// Resolve always reports no winner so the conflict set stays intact.
func (RetainPolicy) Resolve(conflicts []Record) (Record, bool) {
	if len(conflicts) == 0 {
		return Record{}, false
	}
	if len(conflicts) == 1 {
		return conflicts[0], true
	}
	return Record{}, false
}

// RegionPriorityPolicy resolves conflicts by a fixed region preference
// list. Regions appearing earlier win; unknown regions fall back to
// lexicographic region order, then event id, for full determinism.
// Wall-clock time is never consulted.
type RegionPriorityPolicy struct {
	Priority []string
}

// Resolve implements ConflictPolicy.
func (p RegionPriorityPolicy) Resolve(conflicts []Record) (Record, bool) {
	if len(conflicts) == 0 {
		return Record{}, false
	}

	rank := make(map[string]int, len(p.Priority))
	for i, region := range p.Priority {
		rank[region] = i
	}
	unknown := len(p.Priority)

	winner := conflicts[0]
	winnerRank, ok := rank[winner.Region]
	if !ok {
		winnerRank = unknown
	}

	for _, candidate := range conflicts[1:] {
		candidateRank, exists := rank[candidate.Region]
		if !exists {
			candidateRank = unknown
		}
		if lessRecord(candidate, candidateRank, winner, winnerRank) {
			winner, winnerRank = candidate, candidateRank
		}
	}
	return winner, true
}

func lessRecord(a Record, aRank int, b Record, bRank int) bool {
	if aRank != bRank {
		return aRank < bRank
	}
	if a.Region != b.Region {
		return a.Region < b.Region
	}
	return a.EventID < b.EventID
}

// Resolve applies a policy to one key's conflict set. On a winner the
// losing versions are pruned, leaving a single retained version; with the
// RetainPolicy the set is left untouched. The retained record is returned.
func (s *Store) Resolve(key string, policy ConflictPolicy) (Record, bool, error) {
	if policy == nil {
		policy = RetainPolicy{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.data[key]
	if !ok || len(state.versions) == 0 {
		return Record{}, false, nil
	}

	winner, decided := policy.Resolve(cloneRecords(state.versions))
	if !decided {
		return Record{}, false, nil
	}

	state.versions = []Record{winner.clone()}
	return winner.clone(), true, nil
}

// ResolveAll applies the policy to every key currently in conflict and
// returns the keys that converged to one version.
func (s *Store) ResolveAll(policy ConflictPolicy) []string {
	if policy == nil {
		policy = RetainPolicy{}
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	resolved := make([]string, 0)
	for key, state := range s.data {
		if len(state.versions) < 2 {
			continue
		}
		if winner, decided := policy.Resolve(cloneRecords(state.versions)); decided {
			state.versions = []Record{winner.clone()}
			resolved = append(resolved, key)
		}
	}
	sort.Strings(resolved)
	return resolved
}

func cloneRecords(records []Record) []Record {
	out := make([]Record, len(records))
	for i, rec := range records {
		out[i] = rec.clone()
	}
	return out
}
