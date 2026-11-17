package formal

import "sort"

// Version is one stored revision of a key. Tombstone marks a deletion; when
// true Value carries no user data but the clock still participates in merge.
type Version struct {
	Clock     VClock
	Value     []byte
	Tombstone bool
	// DelEpoch is the cluster epoch at which the tombstone was written;
	// garbage collection keeps it until the safe watermark passes it.
	DelEpoch int64
}

// clone returns a deep copy, copying the value payload so callers cannot
// mutate stored data through a returned slice.
func (v Version) clone() Version {
	out := v
	out.Clock = v.Clock.Copy()
	if v.Value != nil {
		out.Value = append([]byte(nil), v.Value...)
	}
	return out
}

// sameClock reports whether two revisions carry identical vector clocks.
func sameClock(a, b Version) bool { return EqualClocks(a.Clock, b.Clock) }

// MergeVersions reconciles two version sets under vector-clock causality.
// Obsolete revisions dominated on every component are dropped; concurrent
// revisions are retained together as siblings. Equal clocks collapse into a
// single revision, keeping tombstone semantics (a tombstone dominates a live
// value carrying the identical clock).
func MergeVersions(a, b []Version) []Version {
	merged := make([]Version, 0, len(a)+len(b))
	merged = append(merged, cloneAll(a)...)

	for _, incoming := range b {
		kept := true
		for idx := range merged {
			switch {
			case sameClock(incoming, merged[idx]):
				// Identical causal history: collapse. Prefer the tombstone.
				if incoming.Tombstone {
					merged[idx] = incoming.clone()
				}
				kept = false
			case Descends(merged[idx].Clock, incoming.Clock):
				// Incoming is an obsolete ancestor.
				kept = false
			case Descends(incoming.Clock, merged[idx].Clock):
				// Incoming supersedes the stored revision.
				merged[idx] = incoming.clone()
				kept = false
			}
			if !kept {
				break
			}
		}
		if kept {
			merged = append(merged, incoming.clone())
		}
	}

	// Remove any revision newly dominated after the loop (incoming
	// supersession already replaces in place, this guards multi-way chains).
	merged = pruneDominated(merged)
	sortVersions(merged)
	return merged
}

// pruneDominated drops every version whose clock is a strict ancestor of
// another surviving version.
func pruneDominated(vs []Version) []Version {
	out := vs[:0]
	for i, candidate := range vs {
		obsolete := false
		for j, other := range vs {
			if i == j {
				continue
			}
			if Descends(other.Clock, candidate.Clock) &&
				!EqualClocks(other.Clock, candidate.Clock) {
				obsolete = true
				break
			}
		}
		if !obsolete {
			out = append(out, candidate)
		}
	}
	return out
}

// sortVersions orders siblings deterministically by clock content so tests
// (and callers) observe a stable sibling set.
func sortVersions(vs []Version) {
	sort.Slice(vs, func(i, j int) bool {
		ci, cj := vs[i].Clock, vs[j].Clock
		nodes := make([]string, 0, len(ci)+len(cj))
		seen := make(map[string]struct{}, len(ci)+len(cj))
		for n := range ci {
			if _, ok := seen[n]; !ok {
				seen[n] = struct{}{}
				nodes = append(nodes, n)
			}
		}
		for n := range cj {
			if _, ok := seen[n]; !ok {
				seen[n] = struct{}{}
				nodes = append(nodes, n)
			}
		}
		sort.Strings(nodes)
		for _, node := range nodes {
			if ci[node] != cj[node] {
				return ci[node] < cj[node]
			}
		}
		return false
	})
}

// cloneAll deep-copies a version slice.
func cloneAll(vs []Version) []Version {
	out := make([]Version, len(vs))
	for i, v := range vs {
		out[i] = v.clone()
	}
	return out
}

// Visible returns the live (non-tombstone) siblings a request path may hand
// back to a client. Tombstones remain in storage but are hidden here; a
// tombstone that dominates all live versions yields an empty result with
// deleted=true.
func Visible(vs []Version) (live []Version, deleted bool) {
	merged := pruneDominated(cloneAll(vs))
	for _, v := range merged {
		if v.Tombstone {
			deleted = true
			continue
		}
		live = append(live, v)
	}
	return live, deleted
}
