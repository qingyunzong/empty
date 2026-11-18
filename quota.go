package formal

import (
	"fmt"
	"math"
	"sort"
	"sync"
)

// Node describes one quota node. Nodes form a tree: a request at a node
// consumes capacity at that node and at every ancestor, which models
// overlapping namespace and priority quotas.
//
// Limit contains hard caps per resource. A resource omitted from Limit is not
// capped at this node; a resource present with value zero is a hard zero.
// Priority orders nodes and holds during preemption: larger values are more
// important.
type Node struct {
	ID       string
	Parent   string
	Limit    Resources
	Priority int64
}

// Config is the immutable topology used to build a Calculator.
type Config struct {
	Nodes []Node
}

// Demand is a request for resources at one node. Several demands for the same
// node are aggregated.
type Demand struct {
	Node      string
	Resources Resources
}

// Calculator is a concurrency-safe hierarchical quota allocator. It owns a
// quota tree and the set of active reservations and allocations. All methods
// are safe for concurrent use.
type Calculator struct {
	mu sync.RWMutex

	nodes map[string]*quotaNode
	root  *quotaNode

	holds map[string]*hold
	seq   uint64

	// used includes reservations and allocations at or below a node.
	used map[string]Resources
	// allocated and reserved are also subtree totals.
	allocated map[string]Resources
	reserved  map[string]Resources
}

type quotaNode struct {
	id       string
	parent   *quotaNode
	children []*quotaNode
	limit    Resources
	priority int64
}

// NewCalculator validates cfg and builds an immutable quota tree.
func NewCalculator(cfg Config) (*Calculator, error) {
	if len(cfg.Nodes) == 0 {
		return nil, fmt.Errorf("%w: no nodes", ErrInvalidConfig)
	}

	nodes := make(map[string]*quotaNode, len(cfg.Nodes))
	for _, spec := range cfg.Nodes {
		if spec.ID == "" {
			return nil, fmt.Errorf("%w: node with empty id", ErrInvalidConfig)
		}
		if _, exists := nodes[spec.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate node %q", ErrInvalidConfig, spec.ID)
		}
		if spec.Limit == nil {
			spec.Limit = Resources{}
		}
		if err := spec.Limit.Validate(); err != nil {
			return nil, fmt.Errorf("%w: node %q: %v", ErrInvalidConfig, spec.ID, err)
		}
		nodes[spec.ID] = &quotaNode{
			id:       spec.ID,
			limit:    spec.Limit.Clone(),
			priority: spec.Priority,
		}
	}

	var root *quotaNode
	for _, spec := range cfg.Nodes {
		node := nodes[spec.ID]
		if spec.Parent == "" {
			if root != nil {
				return nil, fmt.Errorf("%w: multiple roots %q and %q", ErrInvalidConfig, root.id, node.id)
			}
			root = node
			continue
		}
		parent, exists := nodes[spec.Parent]
		if !exists {
			return nil, fmt.Errorf("%w: node %q has unknown parent %q", ErrInvalidConfig, spec.ID, spec.Parent)
		}
		node.parent = parent
		parent.children = append(parent.children, node)
	}
	if root == nil {
		return nil, fmt.Errorf("%w: no root node", ErrInvalidConfig)
	}

	// Sort siblings deterministically. Priority only breaks ties for rounding;
	// topology order must not depend on map iteration.
	for _, node := range nodes {
		sort.SliceStable(node.children, func(i, j int) bool {
			left, right := node.children[i], node.children[j]
			if left.priority != right.priority {
				return left.priority > right.priority
			}
			return left.id < right.id
		})
	}

	// Detect cycles and disconnected nodes by walking down from the root.
	seen := make(map[string]bool, len(nodes))
	var walk func(*quotaNode) error
	walk = func(node *quotaNode) error {
		if seen[node.id] {
			return fmt.Errorf("%w: cycle at node %q", ErrInvalidConfig, node.id)
		}
		seen[node.id] = true
		for _, child := range node.children {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	if len(seen) != len(nodes) {
		for id := range nodes {
			if !seen[id] {
				return nil, fmt.Errorf("%w: node %q is not reachable from root", ErrInvalidConfig, id)
			}
		}
	}

	calculator := &Calculator{
		nodes:     nodes,
		root:      root,
		holds:     make(map[string]*hold),
		used:      make(map[string]Resources, len(nodes)),
		allocated: make(map[string]Resources, len(nodes)),
		reserved:  make(map[string]Resources, len(nodes)),
	}
	for id := range nodes {
		calculator.used[id] = Resources{}
		calculator.allocated[id] = Resources{}
		calculator.reserved[id] = Resources{}
	}
	return calculator, nil
}

// Allocate is a stateless convenience wrapper that builds a calculator from
// nodes and computes a fresh hierarchical fair share. It is equivalent to
// NewCalculator followed by FairShareFresh.
func Allocate(nodes []Node, demands []Demand) (map[string]Resources, error) {
	calc, err := NewCalculator(Config{Nodes: nodes})
	if err != nil {
		return nil, err
	}
	return calc.FairShareFresh(demands)
}

// Root returns the id of the quota tree root.
func (c *Calculator) Root() string {
	return c.root.id
}

// Nodes returns every node id in lexicographic order.
func (c *Calculator) Nodes() []string {
	ids := make([]string, 0, len(c.nodes))
	for id := range c.nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Limits returns a deep copy of every node's configured hard limits.
func (c *Calculator) Limits() map[string]Resources {
	c.mu.RLock()
	defer c.mu.RUnlock()
	limits := make(map[string]Resources, len(c.nodes))
	for id, node := range c.nodes {
		limits[id] = node.limit.Clone()
	}
	return limits
}

// FairShare computes a deterministic hierarchical fair allocation of the
// capacity that is still free (hard limit minus allocations and
// reservations). It does not mutate the calculator.
//
// Allocations are proportional to demand at each node, capped by every
// node's configured hard limit and by the capacity granted by its parent.
// Integer remainders use largest-remainder rounding; equal remainders are
// broken by higher priority and then node id. The result contains, for every
// node, the total new grant consumed at or below that node.
func (c *Calculator) FairShare(demands []Demand) (map[string]Resources, error) {
	return c.fairShare(demands, false)
}

// FairShareFresh is like FairShare but ignores existing reservations and
// allocations. It is useful for planning a batch from the configured limits.
func (c *Calculator) FairShareFresh(demands []Demand) (map[string]Resources, error) {
	return c.fairShare(demands, true)
}

// Compute is an alias for FairShare.
func (c *Calculator) Compute(demands []Demand) (map[string]Resources, error) {
	return c.FairShare(demands)
}

func (c *Calculator) fairShare(demands []Demand, fresh bool) (map[string]Resources, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	direct := make(map[string]Resources, len(demands))
	for _, demand := range demands {
		node, exists := c.nodes[demand.Node]
		if !exists {
			return nil, fmt.Errorf("%w: %q", ErrUnknownNode, demand.Node)
		}
		if demand.Resources == nil {
			continue
		}
		if err := demand.Resources.Validate(); err != nil {
			return nil, fmt.Errorf("node %q: %w", node.id, err)
		}
		if direct[node.id] == nil {
			direct[node.id] = Resources{}
		}
		if err := addResources(direct[node.id], demand.Resources); err != nil {
			return nil, fmt.Errorf("node %q: %w", node.id, err)
		}
	}

	resources := make(map[Resource]struct{})
	for _, vector := range direct {
		for name, amount := range vector {
			if amount != 0 {
				resources[name] = struct{}{}
			}
		}
	}
	names := make([]string, 0, len(resources))
	for name := range resources {
		names = append(names, name)
	}
	sort.Strings(names)

	result := make(map[string]Resources, len(c.nodes))
	for id := range c.nodes {
		result[id] = Resources{}
	}
	for _, name := range names {
		grants := c.fairResource(name, direct, fresh)
		for id, amount := range grants {
			if amount != 0 {
				result[id][name] = amount
			}
		}
	}
	return result, nil
}

// fairResource runs one resource through the hierarchy. The caller holds at
// least a read lock.
func (c *Calculator) fairResource(resource Resource, direct map[string]Resources, fresh bool) map[string]int64 {
	totalDemand := make(map[string]int64, len(c.nodes))
	usable := make(map[string]int64, len(c.nodes))
	var accumulate func(*quotaNode) (int64, int64)
	accumulate = func(node *quotaNode) (int64, int64) {
		demand := direct[node.id][resource]
		total := demand
		available := demand
		for _, child := range node.children {
			childTotal, childUsable := accumulate(child)
			total = saturatingAdd(total, childTotal)
			available = saturatingAdd(available, childUsable)
		}

		limit := int64(math.MaxInt64)
		if configured, ok := node.limit[resource]; ok {
			limit = configured
		}
		if !fresh {
			if free := c.freeLocked(node, resource); free < limit {
				limit = free
			}
		}
		if available > limit {
			available = limit
		}
		if available < 0 {
			available = 0
		}
		totalDemand[node.id] = total
		usable[node.id] = available
		return total, available
	}
	accumulate(c.root)

	grants := make(map[string]int64, len(c.nodes))
	var place func(*quotaNode, int64) int64
	place = func(node *quotaNode, capacity int64) int64 {
		if capacity <= 0 {
			return 0
		}
		items := make([]apportionItem, 0, len(node.children)+1)
		keys := make([]string, 0, len(node.children)+1)

		if demand := direct[node.id][resource]; demand > 0 {
			keys = append(keys, node.id)
			items = append(items, apportionItem{
				demand:   demand,
				max:      demand,
				priority: node.priority,
				order:    node.id,
			})
		}
		for _, child := range node.children {
			demand := totalDemand[child.id]
			if demand <= 0 || usable[child.id] <= 0 {
				continue
			}
			keys = append(keys, child.id)
			items = append(items, apportionItem{
				demand:   demand,
				max:      usable[child.id],
				priority: child.priority,
				order:    child.id,
			})
		}
		if len(items) == 0 {
			return 0
		}
		if capacity > usable[node.id] {
			capacity = usable[node.id]
		}
		shares := apportion(capacity, items)

		total := int64(0)
		for i, key := range keys {
			if shares[i] == 0 {
				continue
			}
			if key == node.id {
				total += shares[i]
				continue
			}
			total += place(c.nodes[key], shares[i])
		}
		grants[node.id] = total
		return total
	}
	place(c.root, usable[c.root.id])
	return grants
}

// freeLocked returns the free capacity at node for resource. The caller holds
// at least a read lock.
func (c *Calculator) freeLocked(node *quotaNode, resource Resource) int64 {
	limit, ok := node.limit[resource]
	if !ok {
		return math.MaxInt64
	}
	free := limit - c.used[node.id][resource]
	if free < 0 {
		return 0
	}
	return free
}

// addUsageLocked updates subtree usage and reservation/allocation counters on
// node and every ancestor.
func (c *Calculator) addUsageLocked(node *quotaNode, resource Resource, allocatedDelta, reservedDelta int64) {
	for current := node; current != nil; current = current.parent {
		if allocatedDelta != 0 {
			c.used[current.id][resource] += allocatedDelta
			c.allocated[current.id][resource] += allocatedDelta
			c.compactLocked(current.id, resource)
		}
		if reservedDelta != 0 {
			c.used[current.id][resource] += reservedDelta
			c.reserved[current.id][resource] += reservedDelta
			c.compactLocked(current.id, resource)
		}
	}
}

func (c *Calculator) compactLocked(node string, resource Resource) {
	if c.used[node][resource] == 0 {
		delete(c.used[node], resource)
	}
	if c.allocated[node][resource] == 0 {
		delete(c.allocated[node], resource)
	}
	if c.reserved[node][resource] == 0 {
		delete(c.reserved[node], resource)
	}
}

func (c *Calculator) isDescendantOrSelf(node, ancestor *quotaNode) bool {
	for current := node; current != nil; current = current.parent {
		if current == ancestor {
			return true
		}
	}
	return false
}
