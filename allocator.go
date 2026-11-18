package formal

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
)

// Allocate computes a report from an immutable bill. Supplying more than one
// Options value is rejected.
func Allocate(bill Bill, options ...Options) (Report, error) {
	var opts Options
	switch len(options) {
	case 0:
		opts = DefaultOptions()
	case 1:
		opts = options[0]
	default:
		return Report{}, fmt.Errorf("formal: at most one Options value is allowed")
	}
	return allocateBill(bill.Resources, bill.Charges, opts, 0)
}

// Allocator is a reusable, concurrency-safe allocation engine for a billing
// pipeline. Its zero value is ready to use with default Options. Mutating
// methods bump Revision. Allocate is a pure snapshot of the current resources,
// tags, and charges, so allocation and tag updates may be interleaved without
// accumulating or double-counting costs.
//
// An Allocator must not be copied after first use.
type Allocator struct {
	mu        sync.RWMutex
	options   Options
	resources map[string]Resource
	order     []string
	charges   []Charge
	chargeIDs map[string]struct{}
	revision  uint64
	initErr   error
}

// NewAllocator creates an allocator. The zero Options value is valid.
func NewAllocator(options ...Options) *Allocator {
	var opts Options
	var initErr error
	switch len(options) {
	case 0:
		opts = DefaultOptions()
	case 1:
		opts = options[0]
	default:
		initErr = fmt.Errorf("formal: at most one Options value is allowed")
	}
	if normalized, err := normalizeOptions(opts); err != nil {
		if initErr == nil {
			initErr = err
		}
	} else {
		opts = normalized
	}
	return &Allocator{
		options:   opts,
		resources: make(map[string]Resource),
		chargeIDs: make(map[string]struct{}),
		initErr:   initErr,
	}
}

// New is an alias for NewAllocator.
func New(options ...Options) *Allocator { return NewAllocator(options...) }

// Revision returns the current revision. Allocate itself does not change it.
func (a *Allocator) Revision() uint64 {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.revision
}

// AddResource adds a hierarchy node. Parents may be added later.
func (a *Allocator) AddResource(resource Resource) error {
	if strings.TrimSpace(resource.ID) == "" {
		return fmt.Errorf("formal: resource ID must not be empty")
	}
	resource.Tags = copyTags(resource.Tags)

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.resources == nil {
		a.resources = make(map[string]Resource)
	}
	if _, exists := a.resources[resource.ID]; exists {
		return fmt.Errorf("formal: duplicate resource %q", resource.ID)
	}
	a.resources[resource.ID] = resource
	a.order = append(a.order, resource.ID)
	a.revision++
	return nil
}

// AddCharge adds a charge. Charge IDs must be unique.
func (a *Allocator) AddCharge(charge Charge) error {
	if strings.TrimSpace(charge.ID) == "" {
		return fmt.Errorf("formal: charge ID must not be empty")
	}
	charge = copyCharge(charge)

	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chargeIDs == nil {
		a.chargeIDs = make(map[string]struct{})
	}
	if _, exists := a.chargeIDs[charge.ID]; exists {
		return fmt.Errorf("formal: duplicate charge %q", charge.ID)
	}
	a.charges = append(a.charges, charge)
	a.chargeIDs[charge.ID] = struct{}{}
	a.revision++
	return nil
}

// SetTag sets one inherited tag value. An empty value removes the explicit tag
// and therefore exposes the parent's value.
func (a *Allocator) SetTag(resourceID, key, value string) error {
	if key == "" {
		return fmt.Errorf("formal: tag key must not be empty")
	}
	return a.UpdateTags(resourceID, Tags{key: value})
}

// UpdateTags merges tag updates into a resource. Empty values delete the
// explicit tag. It returns an error for an unknown resource. A no-op update
// does not bump Revision.
func (a *Allocator) UpdateTags(resourceID string, updates Tags) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	resource, ok := a.resources[resourceID]
	if !ok {
		return fmt.Errorf("formal: unknown resource %q", resourceID)
	}

	changed := false
	next := copyTags(resource.Tags)
	for key, value := range updates {
		if key == "" {
			return fmt.Errorf("formal: tag key must not be empty")
		}
		if value == "" {
			if _, exists := next[key]; exists {
				delete(next, key)
				changed = true
			}
			continue
		}
		if next[key] != value {
			next[key] = value
			changed = true
		}
	}
	if !changed {
		return nil
	}
	resource.Tags = next
	a.resources[resourceID] = resource
	a.revision++
	return nil
}

// SetTags replaces all explicit tags on a resource. Empty values are omitted.
func (a *Allocator) SetTags(resourceID string, tags Tags) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	resource, ok := a.resources[resourceID]
	if !ok {
		return fmt.Errorf("formal: unknown resource %q", resourceID)
	}
	resource.Tags = copyTags(tags)
	a.resources[resourceID] = resource
	a.revision++
	return nil
}

// DeleteTag removes an explicit tag, allowing inheritance from the parent.
func (a *Allocator) DeleteTag(resourceID, key string) error {
	return a.UpdateTags(resourceID, Tags{key: ""})
}

// Resources returns a copy of the current resources in insertion order.
func (a *Allocator) Resources() []Resource {
	a.mu.RLock()
	defer a.mu.RUnlock()
	resources := make([]Resource, 0, len(a.order))
	for _, id := range a.order {
		resource := a.resources[id]
		resource.Tags = copyTags(resource.Tags)
		resources = append(resources, resource)
	}
	return resources
}

// Charges returns a deep copy of the current charges in insertion order.
func (a *Allocator) Charges() []Charge {
	a.mu.RLock()
	defer a.mu.RUnlock()
	charges := make([]Charge, len(a.charges))
	for i, charge := range a.charges {
		charges[i] = copyCharge(charge)
	}
	return charges
}

// Bill returns an immutable snapshot of the allocator's current input.
func (a *Allocator) Bill() Bill {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.billLocked()
}

// Allocate returns a fresh report for the current state. It never modifies the
// allocator or previously returned reports.
func (a *Allocator) Allocate() (Report, error) {
	a.mu.RLock()
	if a.initErr != nil {
		err := a.initErr
		a.mu.RUnlock()
		return Report{}, err
	}
	options := a.options
	revision := a.revision
	bill := a.billLocked()
	a.mu.RUnlock()

	return allocateBill(bill.Resources, bill.Charges, options, revision)
}

func (a *Allocator) billLocked() Bill {
	resources := make([]Resource, 0, len(a.order))
	for _, id := range a.order {
		resource := a.resources[id]
		resource.Tags = copyTags(resource.Tags)
		resources = append(resources, resource)
	}
	charges := make([]Charge, len(a.charges))
	for i, charge := range a.charges {
		charges[i] = copyCharge(charge)
	}
	return Bill{Resources: resources, Charges: charges}
}

func allocateBill(resources []Resource, charges []Charge, options Options, revision uint64) (Report, error) {
	options, err := normalizeOptions(options)
	if err != nil {
		return Report{}, err
	}

	resourceByID, err := indexResources(resources)
	if err != nil {
		return Report{}, err
	}
	if err := validateHierarchy(resourceByID); err != nil {
		return Report{}, err
	}

	resolver := &entityResolver{
		resources: resourceByID,
		cache:     make(map[resolverKey]string),
	}
	report := Report{
		Revision:          revision,
		EntityTag:         options.EntityTag,
		UnallocatedEntity: options.UnallocatedEntity,
	}
	entityAccumulators := make(map[string]*EntityTotal)
	chargeIDs := make(map[string]struct{}, len(charges))

	for _, rawCharge := range charges {
		charge, shares, err := normalizeCharge(rawCharge, resourceByID)
		if err != nil {
			return Report{}, err
		}
		if _, exists := chargeIDs[charge.ID]; exists {
			return Report{}, fmt.Errorf("formal: duplicate charge %q", charge.ID)
		}
		chargeIDs[charge.ID] = struct{}{}

		tagKey := options.EntityTag
		if charge.TagKey != "" {
			tagKey = charge.TagKey
		}

		chargeResult := ChargeAllocation{
			ChargeID:   charge.ID,
			ResourceID: charge.ResourceID,
			Kind:       charge.Kind,
			TagKey:     tagKey,
			Requested:  charge.Amount,
		}

		switch {
		case charge.Kind == KindDirect, charge.Kind == KindSaving && len(shares) == 0:
			entity, err := resolver.resolve(charge.ResourceID, tagKey)
			if err != nil {
				return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
			}
			if entity == "" {
				entity = options.UnallocatedEntity
			}
			effective := charge.Amount
			if charge.Kind == KindSaving {
				effective, err = negateMoney(charge.Amount)
				if err != nil {
					return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
				}
			}
			chargeResult.Effective = effective
			chargeResult.TotalWeight = 1
			chargeResult.Allocations = []Allocation{{
				Entity:      entity,
				Weight:      1,
				Amount:      effective,
				Unallocated: entity == options.UnallocatedEntity,
			}}
			if err := applyAllocation(&report, entityAccumulators, options, charge, effective, entity); err != nil {
				return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
			}

		case charge.Kind == KindShared, charge.Kind == KindSaving:
			recipients, totalWeight, err := resolveShares(shares, resolver, tagKey, options.UnallocatedEntity)
			if err != nil {
				return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
			}
			effective := charge.Amount
			if charge.Kind == KindSaving {
				effective, err = negateMoney(charge.Amount)
				if err != nil {
					return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
				}
			}
			parts, err := splitWeighted(effective, recipients)
			if err != nil {
				return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
			}
			chargeResult.Effective = effective
			chargeResult.TotalWeight = totalWeight
			for i, recipient := range recipients {
				amount := Money(parts[i])
				chargeResult.Allocations = append(chargeResult.Allocations, Allocation{
					Entity:      recipient.entity,
					Weight:      recipient.weight,
					Amount:      amount,
					Unallocated: recipient.entity == options.UnallocatedEntity,
				})
				if err := applyAllocation(&report, entityAccumulators, options, charge, amount, recipient.entity); err != nil {
					return Report{}, fmt.Errorf("formal: charge %q: %w", charge.ID, err)
				}
			}

		default:
			return Report{}, fmt.Errorf("formal: unknown kind %q for charge %q", charge.Kind, charge.ID)
		}

		report.Charges = append(report.Charges, chargeResult)
	}

	report.Totals.Charges = len(report.Charges)
	report.Entities = make([]EntityTotal, 0, len(entityAccumulators))
	for _, entity := range entityAccumulators {
		report.Entities = append(report.Entities, *entity)
	}
	sortEntityTotals(report.Entities, options.UnallocatedEntity)

	if err := report.Check(); err != nil {
		return Report{}, err
	}
	return report, nil
}

func applyAllocation(
	report *Report,
	accumulators map[string]*EntityTotal,
	options Options,
	charge Charge,
	amount Money,
	entity string,
) error {
	unallocated := entity == options.UnallocatedEntity
	if amount != 0 {
		accumulator := accumulators[entity]
		if accumulator == nil {
			accumulator = &EntityTotal{
				Entity:      entity,
				Unallocated: unallocated,
			}
			accumulators[entity] = accumulator
		}
		var err error
		switch charge.Kind {
		case KindDirect:
			accumulator.Direct, err = addMoney(accumulator.Direct, amount)
		case KindShared:
			accumulator.Shared, err = addMoney(accumulator.Shared, amount)
		case KindSaving:
			saving, negErr := negateMoney(amount)
			if negErr != nil {
				return negErr
			}
			accumulator.Savings, err = addMoney(accumulator.Savings, saving)
		default:
			return fmt.Errorf("formal: unknown kind %q", charge.Kind)
		}
		if err != nil {
			return err
		}
		accumulator.Total, err = addMoney(accumulator.Total, amount)
		if err != nil {
			return err
		}
	}

	var err error
	switch charge.Kind {
	case KindDirect:
		report.Totals.Direct, err = addMoney(report.Totals.Direct, amount)
		if err != nil {
			return err
		}
	case KindShared:
		report.Totals.Shared, err = addMoney(report.Totals.Shared, amount)
		if err != nil {
			return err
		}
	case KindSaving:
		var saving Money
		saving, err = negateMoney(amount)
		if err != nil {
			return err
		}
		report.Totals.Savings, err = addMoney(report.Totals.Savings, saving)
		if err != nil {
			return err
		}
	}
	report.Totals.Net, err = addMoney(report.Totals.Net, amount)
	if err != nil {
		return err
	}
	if unallocated {
		report.Totals.Unallocated, err = addMoney(report.Totals.Unallocated, amount)
		if err != nil {
			return err
		}
	}
	return nil
}

func normalizeCharge(charge Charge, resources map[string]Resource) (Charge, []Share, error) {
	if strings.TrimSpace(charge.ID) == "" {
		return Charge{}, nil, fmt.Errorf("formal: charge ID must not be empty")
	}
	if charge.Amount == Money(-1<<63) {
		return Charge{}, nil, fmt.Errorf("formal: charge %q amount is out of range", charge.ID)
	}
	if charge.ResourceID != "" {
		if _, ok := resources[charge.ResourceID]; !ok {
			return Charge{}, nil, fmt.Errorf("formal: charge %q references unknown resource %q", charge.ID, charge.ResourceID)
		}
	}
	if charge.TagKey != "" && strings.TrimSpace(charge.TagKey) == "" {
		return Charge{}, nil, fmt.Errorf("formal: charge %q has a blank tag key", charge.ID)
	}
	if len(charge.Shares) > 0 && len(charge.Weights) > 0 {
		return Charge{}, nil, fmt.Errorf("formal: charge %q sets both Shares and Weights", charge.ID)
	}

	shares := make([]Share, 0, len(charge.Shares)+len(charge.Weights))
	shares = append(shares, charge.Shares...)
	if len(charge.Weights) > 0 {
		entities := make([]string, 0, len(charge.Weights))
		for entity := range charge.Weights {
			entities = append(entities, entity)
		}
		sort.Strings(entities)
		for _, entity := range entities {
			shares = append(shares, Share{Entity: entity, Weight: charge.Weights[entity]})
		}
	}
	charge.Shares = nil
	charge.Weights = nil

	kind := charge.Kind
	switch kind {
	case "":
		if len(shares) > 0 {
			kind = KindShared
		} else {
			kind = KindDirect
		}
	case KindDirect, KindShared, KindSaving:
	default:
		return Charge{}, nil, fmt.Errorf("formal: charge %q has unknown kind %q", charge.ID, charge.Kind)
	}
	charge.Kind = kind

	switch kind {
	case KindDirect:
		if charge.ResourceID == "" {
			return Charge{}, nil, fmt.Errorf("formal: direct charge %q requires ResourceID", charge.ID)
		}
		if len(shares) > 0 {
			return Charge{}, nil, fmt.Errorf("formal: direct charge %q must not have weights", charge.ID)
		}
	case KindShared:
		if len(shares) == 0 {
			return Charge{}, nil, fmt.Errorf("formal: shared charge %q requires explicit weights", charge.ID)
		}
	case KindSaving:
		if charge.Amount < 0 {
			return Charge{}, nil, fmt.Errorf("formal: saving charge %q amount must not be negative", charge.ID)
		}
		if len(shares) == 0 && charge.ResourceID == "" {
			return Charge{}, nil, fmt.Errorf("formal: saving charge %q requires weights or ResourceID", charge.ID)
		}
	}
	return charge, shares, nil
}

func resolveShares(
	shares []Share,
	resolver *entityResolver,
	tagKey string,
	unallocated string,
) ([]weightedEntity, int64, error) {
	weights := make(map[string]int64, len(shares))
	for _, share := range shares {
		if share.Weight < 0 {
			return nil, 0, fmt.Errorf("negative weight")
		}
		if share.Entity != "" && share.ResourceID != "" {
			return nil, 0, fmt.Errorf("share for entity %q and resource %q is ambiguous", share.Entity, share.ResourceID)
		}

		entity := share.Entity
		if share.ResourceID != "" {
			resolved, err := resolver.resolve(share.ResourceID, tagKey)
			if err != nil {
				return nil, 0, err
			}
			entity = resolved
		}
		if entity == "" {
			entity = unallocated
		}

		current, exists := weights[entity]
		if !exists {
			current = 0
		}
		if share.Weight > math.MaxInt64-current {
			return nil, 0, fmt.Errorf("weight total overflow")
		}
		weights[entity] = current + share.Weight
	}

	entities := make([]string, 0, len(weights))
	totalWeight := int64(0)
	for entity, weight := range weights {
		entities = append(entities, entity)
		if weight > math.MaxInt64-totalWeight {
			return nil, 0, fmt.Errorf("weight total overflow")
		}
		totalWeight += weight
	}
	if totalWeight <= 0 {
		return nil, 0, fmt.Errorf("total weight must be positive")
	}
	sort.Strings(entities)

	recipients := make([]weightedEntity, 0, len(entities))
	for _, entity := range entities {
		recipients = append(recipients, weightedEntity{entity: entity, weight: weights[entity]})
	}
	return recipients, totalWeight, nil
}

type resolverKey struct {
	resourceID string
	tagKey     string
}

type entityResolver struct {
	resources map[string]Resource
	cache     map[resolverKey]string
}

func (r *entityResolver) resolve(resourceID, tagKey string) (string, error) {
	key := resolverKey{resourceID: resourceID, tagKey: tagKey}
	if cached, ok := r.cache[key]; ok {
		return cached, nil
	}

	path := make([]string, 0, 4)
	for current := resourceID; current != ""; {
		resource, ok := r.resources[current]
		if !ok {
			return "", fmt.Errorf("unknown resource %q", current)
		}
		path = append(path, current)
		if value, exists := resource.Tags[tagKey]; exists && strings.TrimSpace(value) != "" {
			for _, id := range path {
				r.cache[resolverKey{resourceID: id, tagKey: tagKey}] = value
			}
			return value, nil
		}
		current = resource.Parent
	}

	for _, id := range path {
		r.cache[resolverKey{resourceID: id, tagKey: tagKey}] = ""
	}
	return "", nil
}

func indexResources(resources []Resource) (map[string]Resource, error) {
	index := make(map[string]Resource, len(resources))
	for _, resource := range resources {
		if strings.TrimSpace(resource.ID) == "" {
			return nil, fmt.Errorf("formal: resource ID must not be empty")
		}
		if _, exists := index[resource.ID]; exists {
			return nil, fmt.Errorf("formal: duplicate resource %q", resource.ID)
		}
		copied := resource
		copied.Tags = copyTags(resource.Tags)
		index[resource.ID] = copied
	}
	return index, nil
}

func validateHierarchy(resources map[string]Resource) error {
	const (
		unvisited = 0
		visiting  = 1
		done      = 2
	)
	state := make(map[string]int, len(resources))
	var visit func(string) error
	visit = func(id string) error {
		switch state[id] {
		case visiting:
			return fmt.Errorf("formal: resource hierarchy cycle at %q", id)
		case done:
			return nil
		}
		state[id] = visiting
		resource, ok := resources[id]
		if !ok {
			return fmt.Errorf("formal: unknown resource %q", id)
		}
		if resource.Parent != "" {
			if _, ok := resources[resource.Parent]; !ok {
				return fmt.Errorf("formal: resource %q has unknown parent %q", id, resource.Parent)
			}
			if err := visit(resource.Parent); err != nil {
				return err
			}
		}
		state[id] = done
		return nil
	}
	for id := range resources {
		if err := visit(id); err != nil {
			return err
		}
	}
	return nil
}

func copyTags(tags Tags) Tags {
	copied := make(Tags, len(tags))
	for key, value := range tags {
		if value == "" {
			continue
		}
		copied[key] = value
	}
	return copied
}

func copyCharge(charge Charge) Charge {
	charge.Shares = append([]Share(nil), charge.Shares...)
	if charge.Weights != nil {
		weights := make(map[string]int64, len(charge.Weights))
		for entity, weight := range charge.Weights {
			weights[entity] = weight
		}
		charge.Weights = weights
	}
	return charge
}
