package formal

import (
	"fmt"
	"strings"
)

// Tags is a set of label values attached to a resource. Empty values are
// treated as missing; they do not shadow a value inherited from a parent.
type Tags map[string]string

// Resource is one node in the resource hierarchy. Parent may be empty for a
// root. Tags are inherited from the nearest ancestor that has a non-empty
// value for a key.
type Resource struct {
	ID     string
	Parent string
	Tags   Tags
}

// Kind describes how a charge is assigned.
type Kind string

const (
	// KindDirect assigns the whole charge to the entity owning ResourceID.
	KindDirect Kind = "direct"
	// KindShared splits the charge using Shares or Weights.
	KindShared Kind = "shared"
	// KindSaving is a positive saving amount that is subtracted from cost.
	// It can be split by explicit weights or, when no weights are supplied,
	// assigned directly to the owning entity of ResourceID.
	KindSaving Kind = "saving"
)

// Share is one public weight in a shared or weighted-saving charge. Exactly
// one of Entity and ResourceID should normally be set:
//
//   - Entity names the recipient allocation entity directly.
//   - ResourceID resolves the recipient through the resource hierarchy and
//     inherited tags.
//
// If neither is set, the weight is assigned to the controlled unallocated
// entity. Both being set is rejected as ambiguous.
type Share struct {
	Entity     string
	ResourceID string
	Weight     int64
}

// EntityShare creates a share addressed directly by allocation entity.
func EntityShare(entity string, weight int64) Share {
	return Share{Entity: entity, Weight: weight}
}

// ResourceShare creates a share whose recipient is resolved from the
// resource's inherited entity tag.
func ResourceShare(resourceID string, weight int64) Share {
	return Share{ResourceID: resourceID, Weight: weight}
}

// Charge is a bill line. Amount is exact Money; it is signed for direct and
// shared charges, while KindSaving requires a non-negative amount.
//
// TagKey optionally overrides Options.EntityTag for this charge. Weights is a
// convenience form of Shares keyed by explicit entity. Shares and Weights are
// mutually exclusive.
type Charge struct {
	ID         string
	ResourceID string
	Amount     Money
	Kind       Kind
	TagKey     string
	Shares     []Share
	Weights    map[string]int64
}

// Bill is an immutable input to Allocate. Resource order does not matter;
// charge order is preserved in the report for auditability.
type Bill struct {
	Resources []Resource
	Charges   []Charge
}

// Options controls entity resolution and the controlled unallocated bucket.
// The zero value is valid and uses DefaultEntityTag and
// DefaultUnallocatedEntity.
type Options struct {
	EntityTag string
	// UnallocatedEntity is reserved for missing-tag costs; do not use it as a
	// real entity name. It defaults to DefaultUnallocatedEntity.
	UnallocatedEntity string
}

const (
	// DefaultEntityTag is the tag key used when Options.EntityTag is empty.
	DefaultEntityTag = "entity"
	// DefaultUnallocatedEntity receives charges whose entity tag is missing.
	DefaultUnallocatedEntity = "unallocated"
)

// DefaultOptions returns the zero-configuration allocation options.
func DefaultOptions() Options {
	return Options{
		EntityTag:         DefaultEntityTag,
		UnallocatedEntity: DefaultUnallocatedEntity,
	}
}

func normalizeOptions(options Options) (Options, error) {
	if options.EntityTag == "" {
		options.EntityTag = DefaultEntityTag
	}
	if options.UnallocatedEntity == "" {
		options.UnallocatedEntity = DefaultUnallocatedEntity
	}
	if strings.TrimSpace(options.EntityTag) == "" {
		return Options{}, fmt.Errorf("formal: entity tag must not be blank")
	}
	if strings.TrimSpace(options.UnallocatedEntity) == "" {
		return Options{}, fmt.Errorf("formal: unallocated entity must not be blank")
	}
	return options, nil
}

// DirectCharge constructs a direct charge for a resource.
func DirectCharge(id, resourceID string, amount Money) Charge {
	return Charge{ID: id, ResourceID: resourceID, Amount: amount, Kind: KindDirect}
}

// SharedCharge constructs a shared charge with public weights keyed by
// explicit entity.
func SharedCharge(id, resourceID string, amount Money, weights map[string]int64) Charge {
	copied := make(map[string]int64, len(weights))
	for entity, weight := range weights {
		copied[entity] = weight
	}
	return Charge{
		ID:         id,
		ResourceID: resourceID,
		Amount:     amount,
		Kind:       KindShared,
		Weights:    copied,
	}
}

// SavingCharge constructs a saving. The amount is positive and will be
// subtracted from recipients' costs; empty weights assign it directly to the
// owner of resourceID.
func SavingCharge(id, resourceID string, amount Money, weights map[string]int64) Charge {
	charge := SharedCharge(id, resourceID, amount, weights)
	charge.Kind = KindSaving
	return charge
}
