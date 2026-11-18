package formal

import (
	"container/heap"
	"errors"
	"fmt"
	"math"
	"sort"
)

// DefaultMaxDeviation is the smallest deviation bound that can be guaranteed
// for every possible topology. Because counts are integral, an exact
// proportional share may fall halfway between two counts.
const DefaultMaxDeviation = 1.0

var (
	// ErrNoActiveZones is returned when endpoints are supplied but no zone has
	// a positive capacity.
	ErrNoActiveZones = errors.New("formal: no active zones")
)

// Endpoint is one endpoint that must be assigned to a zone.
//
// ZoneHint is a soft topology preference. It is honored when the
// proportional targets leave room for it. Terminating and not-ready endpoints
// do not contribute hint weight and their hints never change the targets, but
// they may still be placed in their hinted zone when a slot is available.
type Endpoint struct {
	ID          string
	ZoneHint    string
	Ready       bool
	Terminating bool
}

// Weight returns the hint weight of the endpoint. Ready, non-terminating
// endpoints have weight one; all other endpoints have weight zero.
func (e Endpoint) Weight() int {
	if e.Ready && !e.Terminating {
		return 1
	}
	return 0
}

// Zone describes a zone and its relative capacity. Capacity is a
// non-negative relative weight, such as allocatable CPU millicores or node
// count. A zero capacity marks an inactive zone: no endpoint is assigned to
// it.
type Zone struct {
	Name     string
	Capacity float64
}

// Assignment maps an endpoint ID to the name of its assigned zone.
type Assignment map[string]string

// Options controls allocation behavior.
type Options struct {
	// MaxDeviation is the largest allowed difference between a zone's
	// integer count and its exact proportional share. A zero value selects
	// DefaultMaxDeviation. Values below one are legal but can be infeasible
	// for some topologies; in that case allocation returns an error.
	MaxDeviation float64
}

func (o Options) normalized() (Options, error) {
	if math.IsNaN(o.MaxDeviation) || math.IsInf(o.MaxDeviation, 0) || o.MaxDeviation < 0 {
		return Options{}, fmt.Errorf("formal: invalid max deviation %v", o.MaxDeviation)
	}
	if o.MaxDeviation == 0 {
		o.MaxDeviation = DefaultMaxDeviation
	}
	return o, nil
}

// Result is the outcome of a partition operation.
type Result struct {
	// Assignments contains exactly one zone for every input endpoint.
	Assignments Assignment

	// Counts contains the number of all endpoints assigned to each active
	// zone, including terminating and not-ready endpoints.
	Counts map[string]int

	// WeightedCounts contains the number of ready, non-terminating endpoints
	// assigned to each active zone.
	WeightedCounts map[string]int

	// WeightedTargets contains each active zone's exact proportional share of
	// the weighted endpoints.
	WeightedTargets map[string]float64

	// TotalTargets contains each active zone's exact proportional share of all
	// endpoints.
	TotalTargets map[string]float64

	// Moved lists, in ID order, the endpoints whose assignment differs from
	// the previous assignment that was supplied to the partition operation.
	Moved []string
}

// Partition assigns every endpoint to exactly one active zone.
//
// Previous assignments are treated as hints for stability: endpoints stay in
// their previous zone whenever the new proportional targets permit it.
// Endpoints assigned to zones that are no longer active are rebalanced among
// the remaining zones.
func Partition(zones []Zone, endpoints []Endpoint, previous Assignment, options ...Options) (Result, error) {
	opts, err := mergeOptions(options)
	if err != nil {
		return Result{}, err
	}
	topo, eps, err := prepare(zones, endpoints)
	if err != nil {
		return Result{}, err
	}
	return partition(topo, eps, previous, opts)
}

// Verify checks that assignments form a valid partition for the supplied
// topology and endpoints.
//
// It verifies that every endpoint occurs exactly once, that every assigned
// zone is active, and that both weighted and total counts are within the
// configured deviation bound of their proportional shares.
func Verify(zones []Zone, endpoints []Endpoint, assignments Assignment, options ...Options) error {
	opts, err := mergeOptions(options)
	if err != nil {
		return err
	}
	topo, eps, err := prepare(zones, endpoints)
	if err != nil {
		return err
	}
	if len(assignments) != len(eps) {
		return fmt.Errorf("formal: assignments contain %d entries for %d endpoints", len(assignments), len(eps))
	}

	weighted := 0
	counts := zeroCounts(topo.active)
	weightedCounts := zeroCounts(topo.active)
	seen := make(map[string]struct{}, len(eps))
	for _, ep := range eps {
		zone, ok := assignments[ep.ID]
		if !ok {
			return fmt.Errorf("formal: endpoint %q is not assigned", ep.ID)
		}
		if _, ok := topo.activeZones[zone]; !ok {
			return fmt.Errorf("formal: endpoint %q is assigned to inactive zone %q", ep.ID, zone)
		}
		if _, duplicate := seen[ep.ID]; duplicate {
			return fmt.Errorf("formal: endpoint %q is assigned more than once", ep.ID)
		}
		seen[ep.ID] = struct{}{}
		counts[zone]++
		if ep.Weight() == 1 {
			weighted++
			weightedCounts[zone]++
		}
	}
	for id := range assignments {
		if !containsEndpoint(eps, id) {
			return fmt.Errorf("formal: assignment for unknown endpoint %q", id)
		}
	}

	weightedTargets := exactTargets(topo.active, weighted)
	totalTargets := exactTargets(topo.active, len(eps))
	if err := checkDeviation("weighted", topo.active, weightedCounts, weightedTargets, opts.MaxDeviation); err != nil {
		return err
	}
	if err := checkDeviation("total", topo.active, counts, totalTargets, opts.MaxDeviation); err != nil {
		return err
	}
	return nil
}

type topology struct {
	active      []Zone // sorted by name, capacity > 0
	activeZones map[string]Zone
}

func prepare(zones []Zone, endpoints []Endpoint) (topology, []Endpoint, error) {
	topo, err := prepareZones(zones)
	if err != nil {
		return topology{}, nil, err
	}
	eps, err := prepareEndpoints(endpoints)
	if err != nil {
		return topology{}, nil, err
	}
	if len(eps) > 0 && len(topo.active) == 0 {
		return topology{}, nil, fmt.Errorf("%w: %d endpoints need an active zone", ErrNoActiveZones, len(eps))
	}
	return topo, eps, nil
}

func prepareZones(zones []Zone) (topology, error) {
	topo := topology{
		activeZones: make(map[string]Zone),
	}
	seen := make(map[string]struct{}, len(zones))
	for _, zone := range zones {
		if zone.Name == "" {
			return topology{}, errors.New("formal: zone name must not be empty")
		}
		if _, ok := seen[zone.Name]; ok {
			return topology{}, fmt.Errorf("formal: duplicate zone %q", zone.Name)
		}
		seen[zone.Name] = struct{}{}
		if math.IsNaN(zone.Capacity) || math.IsInf(zone.Capacity, 0) || zone.Capacity < 0 {
			return topology{}, fmt.Errorf("formal: invalid capacity %v for zone %q", zone.Capacity, zone.Name)
		}
	}
	sortedZones := append([]Zone(nil), zones...)
	sort.Slice(sortedZones, func(i, j int) bool { return sortedZones[i].Name < sortedZones[j].Name })
	for _, zone := range sortedZones {
		if zone.Capacity > 0 {
			topo.active = append(topo.active, zone)
			topo.activeZones[zone.Name] = zone
		}
	}
	return topo, nil
}

func prepareEndpoints(endpoints []Endpoint) ([]Endpoint, error) {
	eps := append([]Endpoint(nil), endpoints...)
	seen := make(map[string]struct{}, len(eps))
	for _, ep := range eps {
		if ep.ID == "" {
			return nil, errors.New("formal: endpoint ID must not be empty")
		}
		if _, ok := seen[ep.ID]; ok {
			return nil, fmt.Errorf("formal: duplicate endpoint ID %q", ep.ID)
		}
		seen[ep.ID] = struct{}{}
	}
	sort.Slice(eps, func(i, j int) bool { return eps[i].ID < eps[j].ID })
	return eps, nil
}

func mergeOptions(options []Options) (Options, error) {
	if len(options) == 0 {
		return Options{}.normalized()
	}
	if len(options) > 1 {
		return Options{}, errors.New("formal: at most one Options value may be supplied")
	}
	return options[0].normalized()
}

func partition(topo topology, endpoints []Endpoint, previous Assignment, opts Options) (Result, error) {
	weighted := make([]Endpoint, 0, len(endpoints))
	unweighted := make([]Endpoint, 0, len(endpoints))
	for _, ep := range endpoints {
		if ep.Weight() == 1 {
			weighted = append(weighted, ep)
		} else {
			unweighted = append(unweighted, ep)
		}
	}

	previousWeighted := previousCounts(weighted, previous, topo.activeZones)
	previousUnweighted := previousCounts(unweighted, previous, topo.activeZones)
	weightedQuotas := proportionalQuotas(topo.active, len(weighted), previousWeighted)
	totalQuotas := boundedTotalQuotas(topo.active, len(endpoints), weightedQuotas, previousUnweighted)

	assignments := make(Assignment, len(endpoints))
	if err := assignWithQuotas(weighted, weightedQuotas, previous, topo.activeZones, true, assignments); err != nil {
		return Result{}, err
	}
	unweightedQuotas := make(map[string]int, len(topo.active))
	for _, zone := range topo.active {
		unweightedQuotas[zone.Name] = totalQuotas[zone.Name] - weightedQuotas[zone.Name]
	}
	if err := assignWithQuotas(unweighted, unweightedQuotas, previous, topo.activeZones, true, assignments); err != nil {
		return Result{}, err
	}
	if len(assignments) != len(endpoints) {
		return Result{}, fmt.Errorf("formal: internal error: assigned %d of %d endpoints", len(assignments), len(endpoints))
	}

	weightedTargets := exactTargets(topo.active, len(weighted))
	totalTargets := exactTargets(topo.active, len(endpoints))
	counts := zeroCounts(topo.active)
	weightedCounts := zeroCounts(topo.active)
	for _, ep := range endpoints {
		zone := assignments[ep.ID]
		counts[zone]++
		if ep.Weight() == 1 {
			weightedCounts[zone]++
		}
	}
	if err := checkDeviation("weighted", topo.active, weightedCounts, weightedTargets, opts.MaxDeviation); err != nil {
		return Result{}, err
	}
	if err := checkDeviation("total", topo.active, counts, totalTargets, opts.MaxDeviation); err != nil {
		return Result{}, err
	}

	moved := make([]string, 0)
	for _, ep := range endpoints {
		if zone, ok := previous[ep.ID]; ok && zone != assignments[ep.ID] {
			moved = append(moved, ep.ID)
		}
	}
	return Result{
		Assignments:     assignments,
		Counts:          counts,
		WeightedCounts:  weightedCounts,
		WeightedTargets: weightedTargets,
		TotalTargets:    totalTargets,
		Moved:           moved,
	}, nil
}

func previousCounts(endpoints []Endpoint, previous Assignment, active map[string]Zone) map[string]int {
	counts := make(map[string]int)
	for _, ep := range endpoints {
		if zone, ok := previous[ep.ID]; ok {
			if _, active := active[zone]; active {
				counts[zone]++
			}
		}
	}
	return counts
}

func exactTargets(zones []Zone, total int) map[string]float64 {
	targets := make(map[string]float64, len(zones))
	if total == 0 {
		for _, zone := range zones {
			targets[zone.Name] = 0
		}
		return targets
	}
	maxCapacity := 0.0
	for _, zone := range zones {
		if zone.Capacity > maxCapacity {
			maxCapacity = zone.Capacity
		}
	}
	if maxCapacity == 0 {
		for _, zone := range zones {
			targets[zone.Name] = 0
		}
		return targets
	}
	totalCapacity := 0.0
	for _, zone := range zones {
		totalCapacity += zone.Capacity / maxCapacity
	}
	for _, zone := range zones {
		targets[zone.Name] = float64(total) * (zone.Capacity / maxCapacity) / totalCapacity
	}
	return targets
}

type quotaCandidate struct {
	name string
	base int
	frac float64
	prev int
}

// proportionalQuotas apportions total endpoints among zones with the largest
// remainder method. Ties are resolved toward the zone that already contains
// an endpoint at that level, which reduces moves between reconciliations.
func proportionalQuotas(zones []Zone, total int, previous map[string]int) map[string]int {
	quotas := zeroCounts(zones)
	if total == 0 {
		return quotas
	}
	exact := exactTargets(zones, total)
	candidates := make([]quotaCandidate, 0, len(zones))
	baseSum := 0
	for _, zone := range zones {
		value := exact[zone.Name]
		base := int(math.Floor(value))
		if base < 0 {
			base = 0
		}
		quotas[zone.Name] = base
		baseSum += base
		candidates = append(candidates, quotaCandidate{
			name: zone.Name,
			base: base,
			frac: value - float64(base),
			prev: previous[zone.Name],
		})
	}

	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].frac != candidates[j].frac {
			return candidates[i].frac > candidates[j].frac
		}
		iHas := candidates[i].prev > candidates[i].base
		jHas := candidates[j].prev > candidates[j].base
		if iHas != jHas {
			return iHas
		}
		iDistance := absInt(candidates[i].prev - (candidates[i].base + 1))
		jDistance := absInt(candidates[j].prev - (candidates[j].base + 1))
		if iDistance != jDistance {
			return iDistance < jDistance
		}
		return candidates[i].name < candidates[j].name
	})

	remaining := total - baseSum
	// Floating-point rounding should never leave a negative remainder, but
	// guard against it so that the quota sum is always exactly total.
	for remaining < 0 {
		removed := false
		for i := len(candidates) - 1; i >= 0; i-- {
			if quotas[candidates[i].name] > 0 {
				quotas[candidates[i].name]--
				remaining++
				removed = true
				break
			}
		}
		if !removed {
			break
		}
	}
	for remaining > 0 {
		for i := range candidates {
			if remaining == 0 {
				break
			}
			quotas[candidates[i].name]++
			remaining--
		}
	}
	return quotas
}

// boundedTotalQuotas chooses total integer counts that are at least the
// weighted counts and remain within one of the exact total proportional
// shares. Starting from the weighted counts, each remaining endpoint is
// assigned to the zone with the largest remaining deficit. This is a
// water-filling apportionment with lower bounds.
func boundedTotalQuotas(zones []Zone, total int, weighted, previousUnweighted map[string]int) map[string]int {
	quotas := zeroCounts(zones)
	for _, zone := range zones {
		quotas[zone.Name] = weighted[zone.Name]
	}
	if total == 0 {
		return quotas
	}
	exact := exactTargets(zones, total)
	remaining := total
	for _, zone := range zones {
		remaining -= quotas[zone.Name]
	}
	if remaining < 0 {
		remaining = 0
	}

	h := make(deficitHeap, 0, len(zones))
	for _, zone := range zones {
		h = append(h, deficit{
			name:     zone.Name,
			value:    exact[zone.Name] - float64(quotas[zone.Name]),
			previous: previousUnweighted[zone.Name],
		})
	}
	heap.Init(&h)
	for i := 0; i < remaining; i++ {
		top := heap.Pop(&h).(deficit)
		quotas[top.name]++
		top.value--
		top.extra++
		heap.Push(&h, top)
	}
	return quotas
}

type deficit struct {
	name     string
	value    float64
	previous int
	extra    int
}

type deficitHeap []deficit

func (h deficitHeap) Len() int { return len(h) }

func (h deficitHeap) Less(i, j int) bool {
	if h[i].value != h[j].value {
		return h[i].value > h[j].value
	}
	iKeeps := h[i].previous > h[i].extra
	jKeeps := h[j].previous > h[j].extra
	if iKeeps != jKeeps {
		return iKeeps
	}
	if h[i].previous != h[j].previous {
		return h[i].previous > h[j].previous
	}
	return h[i].name < h[j].name
}

func (h deficitHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }

func (h *deficitHeap) Push(value any) {
	*h = append(*h, value.(deficit))
}

func (h *deficitHeap) Pop() any {
	old := *h
	last := len(old) - 1
	value := old[last]
	*h = old[:last]
	return value
}

func assignWithQuotas(
	endpoints []Endpoint,
	quotas map[string]int,
	previous Assignment,
	active map[string]Zone,
	useHints bool,
	assignments Assignment,
) error {
	remaining := make(map[string]int, len(quotas))
	for zone, quota := range quotas {
		remaining[zone] = quota
	}
	zoneNames := make([]string, 0, len(quotas))
	for zone := range quotas {
		zoneNames = append(zoneNames, zone)
	}
	sort.Strings(zoneNames)

	byPrevious := make(map[string][]Endpoint)
	for _, ep := range endpoints {
		zone, ok := previous[ep.ID]
		if !ok {
			continue
		}
		if _, ok := active[zone]; !ok {
			continue
		}
		byPrevious[zone] = append(byPrevious[zone], ep)
	}
	for _, zone := range zoneNames {
		keep := remaining[zone]
		if keep > len(byPrevious[zone]) {
			keep = len(byPrevious[zone])
		}
		for _, ep := range byPrevious[zone][:keep] {
			assignments[ep.ID] = zone
		}
		remaining[zone] -= keep
	}

	if useHints {
		for _, ep := range endpoints {
			if _, done := assignments[ep.ID]; done || ep.ZoneHint == "" {
				continue
			}
			if _, ok := active[ep.ZoneHint]; !ok {
				continue
			}
			if remaining[ep.ZoneHint] == 0 {
				continue
			}
			assignments[ep.ID] = ep.ZoneHint
			remaining[ep.ZoneHint]--
		}
	}

	for _, ep := range endpoints {
		if _, done := assignments[ep.ID]; done {
			continue
		}
		zone := zoneWithMostRemaining(zoneNames, remaining)
		if zone == "" {
			return fmt.Errorf("formal: internal error: no quota left for endpoint %q", ep.ID)
		}
		assignments[ep.ID] = zone
		remaining[zone]--
	}
	for _, zone := range zoneNames {
		if remaining[zone] != 0 {
			return fmt.Errorf("formal: internal error: zone %q has %d unused slots", zone, remaining[zone])
		}
	}
	return nil
}

func zoneWithMostRemaining(zones []string, remaining map[string]int) string {
	best := ""
	bestCount := -1
	for _, zone := range zones {
		if remaining[zone] > bestCount {
			best = zone
			bestCount = remaining[zone]
		}
	}
	if bestCount <= 0 {
		return ""
	}
	return best
}

func checkDeviation(kind string, zones []Zone, counts map[string]int, targets map[string]float64, maxDeviation float64) error {
	const tolerance = 1e-9
	for _, zone := range zones {
		deviation := math.Abs(float64(counts[zone.Name]) - targets[zone.Name])
		if deviation > maxDeviation+tolerance {
			return fmt.Errorf(
				"formal: %s deviation for zone %q is %.6f, exceeds %.6f",
				kind, zone.Name, deviation, maxDeviation,
			)
		}
	}
	return nil
}

func zeroCounts(zones []Zone) map[string]int {
	counts := make(map[string]int, len(zones))
	for _, zone := range zones {
		counts[zone.Name] = 0
	}
	return counts
}

func containsEndpoint(endpoints []Endpoint, id string) bool {
	index := sort.Search(len(endpoints), func(i int) bool { return endpoints[i].ID >= id })
	return index < len(endpoints) && endpoints[index].ID == id
}

func cloneAssignment(assignments Assignment) Assignment {
	if assignments == nil {
		return nil
	}
	clone := make(Assignment, len(assignments))
	for id, zone := range assignments {
		clone[id] = zone
	}
	return clone
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
