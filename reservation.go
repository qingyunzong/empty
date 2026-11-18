package formal

import (
	"fmt"
	"sort"
)

// HoldState distinguishes an in-flight reservation from a committed
// allocation. Both consume quota.
type HoldState string

const (
	// Reserved marks capacity held for an admission that has not committed yet.
	Reserved HoldState = "reserved"
	// Allocated marks committed capacity.
	Allocated HoldState = "allocated"
)

// Request asks for resources at one quota node. An empty ID is assigned by
// the calculator. A zero Priority inherits the node's priority.
type Request struct {
	ID        string
	Node      string
	Priority  int64
	Resources Resources
}

// Hold is an immutable snapshot of a reservation or allocation.
type Hold struct {
	ID        string
	Node      string
	Priority  int64
	Requested Resources
	Granted   Resources
	State     HoldState
}

type hold struct {
	id        string
	node      *quotaNode
	priority  int64
	requested Resources
	granted   Resources
	state     HoldState
	seq       uint64
}

func (h *hold) snapshot() Hold {
	return Hold{
		ID:        h.id,
		Node:      h.node.id,
		Priority:  h.priority,
		Requested: h.requested.Clone(),
		Granted:   h.granted.Clone(),
		State:     h.state,
	}
}

// Reserve atomically reserves the full request or fails with
// ErrInsufficientQuota. A request is granted only to the extent that every
// ancestor has free capacity for every requested resource.
func (c *Calculator) Reserve(request Request) (Hold, error) {
	return c.reserve(request, false)
}

// Admit is an alias for Reserve.
func (c *Calculator) Admit(request Request) (Hold, error) {
	return c.Reserve(request)
}

// TryReserve atomically reserves as much of request as currently fits. It
// returns ErrInsufficientQuota without creating a hold when nothing at all can
// be granted.
func (c *Calculator) TryReserve(request Request) (Hold, error) {
	return c.reserve(request, true)
}

func (c *Calculator) reserve(request Request, partial bool) (Hold, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	node, exists := c.nodes[request.Node]
	if !exists {
		return Hold{}, fmt.Errorf("%w: %q", ErrUnknownNode, request.Node)
	}
	if err := request.Resources.Validate(); err != nil {
		return Hold{}, err
	}

	id := request.ID
	if id == "" {
		c.seq++
		id = fmt.Sprintf("auto-%d", c.seq)
	}
	if _, exists := c.holds[id]; exists {
		return Hold{}, fmt.Errorf("%w: %q", ErrDuplicateID, id)
	}

	granted := make(Resources, len(request.Resources))
	for resource, wanted := range request.Resources {
		if wanted < 0 {
			return Hold{}, fmt.Errorf("%w: resource %q", ErrInvalidAmount, resource)
		}
		available := wanted
		for current := node; current != nil; current = current.parent {
			if free := c.freeLocked(current, resource); free < available {
				available = free
			}
			if available == 0 {
				break
			}
		}
		granted[resource] = available
	}

	anyGranted := false
	for resource, wanted := range request.Resources {
		if granted[resource] > 0 {
			anyGranted = true
		}
		if !partial && granted[resource] < wanted {
			return Hold{}, fmt.Errorf("%w: node %q resource %q wants %d, available %d",
				ErrInsufficientQuota, node.id, resource, wanted, granted[resource])
		}
	}
	if partial && len(request.Resources) > 0 && !anyGranted {
		return Hold{}, fmt.Errorf("%w: node %q", ErrInsufficientQuota, node.id)
	}
	for resource, amount := range granted {
		if amount == 0 {
			delete(granted, resource)
		}
	}

	priority := request.Priority
	if priority == 0 {
		priority = node.priority
	}
	c.seq++
	entry := &hold{
		id:        id,
		node:      node,
		priority:  priority,
		requested: request.Resources.Clone(),
		granted:   granted,
		state:     Reserved,
		seq:       c.seq,
	}
	c.holds[id] = entry
	for resource, amount := range granted {
		if amount > 0 {
			c.addUsageLocked(node, resource, 0, amount)
		}
	}
	return entry.snapshot(), nil
}

// Commit converts a reservation into an allocation without changing the
// amount of quota consumed. Committing an already committed hold is a no-op.
func (c *Calculator) Commit(id string) (Hold, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, exists := c.holds[id]
	if !exists {
		return Hold{}, fmt.Errorf("%w: %q", ErrUnknownHold, id)
	}
	if entry.state == Allocated {
		return entry.snapshot(), nil
	}
	for resource, amount := range entry.granted {
		if amount > 0 {
			c.addUsageLocked(entry.node, resource, amount, -amount)
		}
	}
	entry.state = Allocated
	return entry.snapshot(), nil
}

// Release removes a reservation or allocation and returns its final grant.
func (c *Calculator) Release(id string) (Hold, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, exists := c.holds[id]
	if !exists {
		return Hold{}, fmt.Errorf("%w: %q", ErrUnknownHold, id)
	}
	if entry.state == Allocated {
		for resource, amount := range entry.granted {
			if amount > 0 {
				c.addUsageLocked(entry.node, resource, -amount, 0)
			}
		}
	} else {
		for resource, amount := range entry.granted {
			if amount > 0 {
				c.addUsageLocked(entry.node, resource, 0, -amount)
			}
		}
	}
	delete(c.holds, id)
	return entry.snapshot(), nil
}

// Cancel is an alias for Release.
func (c *Calculator) Cancel(id string) (Hold, error) {
	return c.Release(id)
}

// Get returns a snapshot of one hold.
func (c *Calculator) Get(id string) (Hold, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, exists := c.holds[id]
	if !exists {
		return Hold{}, false
	}
	return entry.snapshot(), true
}

// Holds returns all active holds ordered by creation sequence.
func (c *Calculator) Holds() []Hold {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.holdsLocked()
}

func (c *Calculator) holdsLocked() []Hold {
	entries := make([]*hold, 0, len(c.holds))
	for _, entry := range c.holds {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].seq != entries[j].seq {
			return entries[i].seq < entries[j].seq
		}
		return entries[i].id < entries[j].id
	})
	holds := make([]Hold, len(entries))
	for i, entry := range entries {
		holds[i] = entry.snapshot()
	}
	return holds
}

// Usage reports subtree consumption at one node. Used is Allocated plus
// Reserved.
type Usage struct {
	Used      Resources
	Allocated Resources
	Reserved  Resources
}

// NodeUsage returns the quota consumed at and below node.
func (c *Calculator) NodeUsage(node string) (Usage, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if _, exists := c.nodes[node]; !exists {
		return Usage{}, fmt.Errorf("%w: %q", ErrUnknownNode, node)
	}
	return Usage{
		Used:      c.used[node].Clone(),
		Allocated: c.allocated[node].Clone(),
		Reserved:  c.reserved[node].Clone(),
	}, nil
}

// Snapshot is a consistent view of all holds and subtree usage.
type Snapshot struct {
	Holds []Hold
	Usage map[string]Usage
}

// Snapshot returns a deep, lock-consistent copy of the calculator state.
func (c *Calculator) Snapshot() Snapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	snapshot := Snapshot{
		Holds: c.holdsLocked(),
		Usage: make(map[string]Usage, len(c.nodes)),
	}
	for id := range c.nodes {
		snapshot.Usage[id] = Usage{
			Used:      c.used[id].Clone(),
			Allocated: c.allocated[id].Clone(),
			Reserved:  c.reserved[id].Clone(),
		}
	}
	return snapshot
}

// Preempt reclaims target from holds at or below node, taking the lowest
// priority holds first. Within one priority, capacity is apportioned
// proportionally to each hold's current grant with largest-remainder rounding,
// so the reclaimed amount is deterministic and exactly conserved. A partial
// result is applied and reported with ErrReclaimShortfall.
func (c *Calculator) Preempt(node string, target Resources) (Resources, error) {
	return c.preempt(node, nil, target)
}

// Reclaim is an alias for Preempt.
func (c *Calculator) Reclaim(node string, target Resources) (Resources, error) {
	return c.Preempt(node, target)
}

// PreemptBelow reclaims only from holds whose priority is strictly lower than
// priority. It is the usual scheduling entry point when a high-priority
// request needs capacity.
func (c *Calculator) PreemptBelow(node string, priority int64, target Resources) (Resources, error) {
	return c.preempt(node, &priority, target)
}

// PreemptFor is an alias for PreemptBelow.
func (c *Calculator) PreemptFor(node string, priority int64, target Resources) (Resources, error) {
	return c.PreemptBelow(node, priority, target)
}

func (c *Calculator) preempt(nodeID string, below *int64, target Resources) (Resources, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	node, exists := c.nodes[nodeID]
	if !exists {
		return nil, fmt.Errorf("%w: %q", ErrUnknownNode, nodeID)
	}
	if err := target.Validate(); err != nil {
		return nil, err
	}

	reductions := make(map[*hold]Resources)
	reclaimed := make(Resources)
	missing := make(Resources)

	for resource, wanted := range target {
		if wanted <= 0 {
			continue
		}
		victims := make([]*hold, 0, len(c.holds))
		for _, entry := range c.holds {
			if entry.granted[resource] <= 0 {
				continue
			}
			if !c.isDescendantOrSelf(entry.node, node) {
				continue
			}
			if below != nil && entry.priority >= *below {
				continue
			}
			victims = append(victims, entry)
		}
		if len(victims) == 0 {
			missing[resource] = wanted
			continue
		}
		sort.Slice(victims, func(i, j int) bool {
			if victims[i].priority != victims[j].priority {
				return victims[i].priority < victims[j].priority
			}
			return victims[i].seq < victims[j].seq
		})

		remaining := wanted
		for start := 0; start < len(victims) && remaining > 0; {
			priority := victims[start].priority
			end := start + 1
			for end < len(victims) && victims[end].priority == priority {
				end++
			}
			group := victims[start:end]

			var groupTotal int64
			items := make([]apportionItem, 0, len(group))
			for _, entry := range group {
				amount := entry.granted[resource]
				groupTotal = saturatingAdd(groupTotal, amount)
				items = append(items, apportionItem{
					demand: amount,
					max:    amount,
					order:  entry.id,
				})
			}

			if groupTotal <= remaining {
				for _, entry := range group {
					addReduction(reductions, entry, resource, entry.granted[resource])
				}
				remaining -= groupTotal
				start = end
				continue
			}

			shares := apportion(remaining, items)
			for i, entry := range group {
				if shares[i] > 0 {
					addReduction(reductions, entry, resource, shares[i])
				}
			}
			remaining = 0
			start = end
		}
		reclaimed[resource] = wanted - remaining
		if remaining > 0 {
			missing[resource] = remaining
		}
	}

	empty := make([]*hold, 0)
	for entry, byResource := range reductions {
		for resource, amount := range byResource {
			entry.granted[resource] -= amount
			if entry.granted[resource] == 0 {
				delete(entry.granted, resource)
			}
			if entry.state == Allocated {
				c.addUsageLocked(entry.node, resource, -amount, 0)
			} else {
				c.addUsageLocked(entry.node, resource, 0, -amount)
			}
		}
		if entry.granted.IsZero() {
			empty = append(empty, entry)
		}
	}
	for _, entry := range empty {
		delete(c.holds, entry.id)
	}

	if len(missing) > 0 {
		return reclaimed, &ShortfallError{Missing: missing}
	}
	return reclaimed, nil
}

func addReduction(reductions map[*hold]Resources, entry *hold, resource Resource, amount int64) {
	if amount <= 0 {
		return
	}
	if reductions[entry] == nil {
		reductions[entry] = Resources{}
	}
	reductions[entry][resource] += amount
}

// Check verifies the core accounting invariants:
//
//   - no resource exceeds its hard limit at any node;
//   - subtree usage equals the sum of grants of holds at or below the node;
//   - used equals allocated plus reserved at every node;
//   - all grants are non-negative and do not exceed their requests.
//
// It is intended for tests, assertions, and periodic audits.
func (c *Calculator) Check() error {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.checkLocked()
}

func (c *Calculator) checkLocked() error {
	used := make(map[string]Resources, len(c.nodes))
	allocated := make(map[string]Resources, len(c.nodes))
	reserved := make(map[string]Resources, len(c.nodes))
	for id := range c.nodes {
		used[id] = Resources{}
		allocated[id] = Resources{}
		reserved[id] = Resources{}
	}

	for _, entry := range c.holds {
		if entry.granted == nil {
			return fmt.Errorf("invariant: hold %q has nil grant", entry.id)
		}
		for resource, amount := range entry.granted {
			if amount < 0 {
				return fmt.Errorf("invariant: hold %q resource %q has negative grant %d", entry.id, resource, amount)
			}
			if amount > entry.requested[resource] {
				return fmt.Errorf("invariant: hold %q resource %q grant %d exceeds request %d",
					entry.id, resource, amount, entry.requested[resource])
			}
			for current := entry.node; current != nil; current = current.parent {
				used[current.id][resource] += amount
				switch entry.state {
				case Allocated:
					allocated[current.id][resource] += amount
				case Reserved:
					reserved[current.id][resource] += amount
				default:
					return fmt.Errorf("invariant: hold %q has unknown state %q", entry.id, entry.state)
				}
			}
		}
	}

	for id, node := range c.nodes {
		for resource, limit := range node.limit {
			if used[id][resource] > limit {
				return fmt.Errorf("invariant: node %q resource %q used %d exceeds limit %d",
					id, resource, used[id][resource], limit)
			}
			if used[id][resource] < 0 {
				return fmt.Errorf("invariant: node %q resource %q has negative used %d", id, resource, used[id][resource])
			}
			if used[id][resource] != c.used[id][resource] {
				return fmt.Errorf("invariant: node %q resource %q used total %d, recomputed %d",
					id, resource, c.used[id][resource], used[id][resource])
			}
		}
		for resource := range c.used[id] {
			if c.used[id][resource] != used[id][resource] {
				return fmt.Errorf("invariant: node %q resource %q used total %d, recomputed %d",
					id, resource, c.used[id][resource], used[id][resource])
			}
		}
		for resource, amount := range used[id] {
			if amount != allocated[id][resource]+reserved[id][resource] {
				return fmt.Errorf("invariant: node %q resource %q used %d != allocated %d + reserved %d",
					id, resource, amount, allocated[id][resource], reserved[id][resource])
			}
		}
		if !resourcesEqual(allocated[id], c.allocated[id]) {
			return fmt.Errorf("invariant: node %q allocated total mismatch", id)
		}
		if !resourcesEqual(reserved[id], c.reserved[id]) {
			return fmt.Errorf("invariant: node %q reserved total mismatch", id)
		}
	}
	return nil
}
