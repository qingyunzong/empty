// Package eviction implements node-level eviction decisions for the
// resource manager. It combines memory, disk, inode and PID pressure
// signals, ranks pods by request usage, priority, QoS and termination
// cost, and selects the minimal ranked prefix of pods whose termination
// relieves the pressure. Once pressure subsides no new evictions are
// issued, and terminations already in flight are never revoked.
package eviction

import (
	"slices"
	"sort"
)

// Resource is a node resource that can be under pressure.
type Resource string

const (
	ResourceMemory Resource = "memory"
	ResourceDisk   Resource = "disk"
	ResourceInodes Resource = "inodes"
	ResourcePIDs   Resource = "pids"
)

// AllResources lists every tracked resource in a fixed order so that
// pressure reports and iterations are deterministic.
var AllResources = []Resource{ResourceMemory, ResourceDisk, ResourceInodes, ResourcePIDs}

// Resources holds a quantity per resource: bytes for memory and disk,
// counts for inodes and PIDs. Missing entries read as zero.
type Resources map[Resource]int64

// QoSClass is the quality-of-service class of a pod. Lower classes are
// evicted first.
type QoSClass int

const (
	QoSBestEffort QoSClass = iota
	QoSBurstable
	QoSGuaranteed
)

// Pod is the eviction-relevant view of one pod on the node.
type Pod struct {
	Name     string
	Priority int32
	QoS      QoSClass
	// Requests and Usage are indexed by resource. Usage is what
	// termination reclaims.
	Requests Resources
	Usage    Resources
	// TerminationCost orders otherwise-equal pods; cheaper terminations
	// (shorter grace periods, less disruption) are evicted first.
	TerminationCost int64
	// Terminating marks pods already asked to terminate. They are never
	// selected again and their usage already counts toward relief.
	Terminating bool
}

// excess returns how much usage exceeds the request for res.
func (p Pod) excess(res Resource) int64 {
	if d := p.Usage[res] - p.Requests[res]; d > 0 {
		return d
	}
	return 0
}

// excessSum totals excess usage across the pressured resources.
func (p Pod) excessSum(pressures []Resource) int64 {
	var total int64
	for _, res := range pressures {
		total += p.excess(res)
	}
	return total
}

// Manager makes eviction decisions for one node.
type Manager struct {
	// Thresholds gives the minimum acceptable available quantity per
	// resource. Available below the threshold means pressure.
	Thresholds Resources
}

// Decision is the outcome of one planning round.
type Decision struct {
	// Pressures lists the resources under pressure, in AllResources order.
	Pressures []Resource
	// Evict lists pods newly selected for termination, in eviction order.
	Evict []Pod
	// InFlight lists pods already terminating. They are left alone and
	// their reclaimable usage is counted toward relief.
	InFlight []Pod
	// Relieved reports whether projected availability satisfies every
	// threshold once in-flight and selected terminations complete.
	Relieved bool
}

// Pressured reports which resources are below their threshold, in
// AllResources order.
func (m *Manager) Pressured(available Resources) []Resource {
	var out []Resource
	for _, res := range AllResources {
		if available[res] < m.Thresholds[res] {
			out = append(out, res)
		}
	}
	return out
}

// Relieved reports whether available satisfies the threshold of every
// pressured resource.
func (m *Manager) Relieved(available Resources, pressures []Resource) bool {
	for _, res := range pressures {
		if available[res] < m.Thresholds[res] {
			return false
		}
	}
	return true
}

// Project returns available plus the usage reclaimed by terminating the
// given pods.
func Project(available Resources, pods ...Pod) Resources {
	out := make(Resources, len(available))
	for res, v := range available {
		out[res] = v
	}
	for _, p := range pods {
		for res, v := range p.Usage {
			out[res] += v
		}
	}
	return out
}

// Plan computes the eviction decision for the current node state.
//
// Pods already terminating keep their termination and are counted toward
// relief but never selected again. If their reclaim alone satisfies every
// threshold, or no resource is under pressure, no new eviction is issued.
// Otherwise candidates are ranked, selected in rank order until the
// pressure is relieved, and any pod whose removal keeps the set
// relieving is dropped, leaving a minimal release set.
func (m *Manager) Plan(pods []Pod, available Resources) Decision {
	pressures := m.Pressured(available)
	decision := Decision{Pressures: pressures}

	projected := Project(available)
	var candidates []Pod
	for _, p := range pods {
		if p.Terminating {
			decision.InFlight = append(decision.InFlight, p)
			for res, v := range p.Usage {
				projected[res] += v
			}
			continue
		}
		candidates = append(candidates, p)
	}
	// Report in-flight terminations deterministically, independent of
	// input order.
	sort.Slice(decision.InFlight, func(i, j int) bool {
		return decision.InFlight[i].Name < decision.InFlight[j].Name
	})

	if len(pressures) == 0 {
		// Pressure has subsided: issue no new evictions. In-flight
		// terminations are reported but never revoked.
		decision.Relieved = true
		return decision
	}

	for _, p := range RankPods(candidates, pressures) {
		if m.Relieved(projected, pressures) {
			break
		}
		decision.Evict = append(decision.Evict, p)
		for res, v := range p.Usage {
			projected[res] += v
		}
	}
	// Backward elimination: drop any selected pod whose reclaim is not
	// needed, so no proper subset of the decision relieves the pressure.
	for i := len(decision.Evict) - 1; i >= 0; i-- {
		for res, v := range decision.Evict[i].Usage {
			projected[res] -= v
		}
		if m.Relieved(projected, pressures) {
			decision.Evict = slices.Delete(decision.Evict, i, i+1)
		} else {
			for res, v := range decision.Evict[i].Usage {
				projected[res] += v
			}
		}
	}
	decision.Relieved = m.Relieved(projected, pressures)
	return decision
}

// RankPods orders candidates by eviction preference: lower QoS class
// first, then lower priority, then higher usage above request across the
// pressured resources, then lower termination cost, then name. The name
// tie-break makes the order total and therefore deterministic.
func RankPods(pods []Pod, pressures []Resource) []Pod {
	ranked := slices.Clone(pods)
	sort.SliceStable(ranked, func(i, j int) bool {
		return Less(ranked[i], ranked[j], pressures)
	})
	return ranked
}

// Less reports whether a should be evicted before b.
func Less(a, b Pod, pressures []Resource) bool {
	if a.QoS != b.QoS {
		return a.QoS < b.QoS
	}
	if a.Priority != b.Priority {
		return a.Priority < b.Priority
	}
	if ea, eb := a.excessSum(pressures), b.excessSum(pressures); ea != eb {
		return ea > eb
	}
	if a.TerminationCost != b.TerminationCost {
		return a.TerminationCost < b.TerminationCost
	}
	return a.Name < b.Name
}
