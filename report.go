package formal

import (
	"fmt"
	"math"
	"sort"
)

// Allocation is one recipient's part of a charge.
type Allocation struct {
	Entity      string
	Weight      int64
	Amount      Money
	Unallocated bool
}

// ChargeAllocation is the auditable, per-charge result. Effective is signed:
// a saving has a negative Effective. The Amount values in Allocations always
// sum exactly to Effective.
type ChargeAllocation struct {
	ChargeID   string
	ResourceID string
	Kind       Kind
	TagKey     string
	Requested  Money
	Effective  Money
	// TotalWeight is the sum of public weights supplied for this charge.
	TotalWeight int64
	Allocations []Allocation
}

// EntityTotal is the net cost assigned to one entity. Savings is a positive
// quantity; Total is Direct + Shared - Savings.
type EntityTotal struct {
	Entity  string
	Direct  Money
	Shared  Money
	Savings Money
	Total   Money
	// Unallocated is true only for the configured missing-tag bucket.
	Unallocated bool
}

// Totals summarizes the whole bill. Unallocated is included in Net.
type Totals struct {
	Direct Money
	Shared Money
	// Savings is a positive saving amount, already subtracted from Net.
	Savings     Money
	Net         Money
	Unallocated Money
	Charges     int
}

// Report is an immutable allocation result. The caller may retain a Report
// while the Allocator's tags or charges change; later allocations never mutate
// earlier reports and never accumulate into them.
type Report struct {
	// Revision is the allocator revision captured by this report; it is zero
	// for the standalone Allocate function.
	Revision          uint64
	EntityTag         string
	UnallocatedEntity string
	Totals            Totals
	// Entities is sorted by entity ID, with the unallocated bucket last.
	Entities []EntityTotal
	// Charges preserves the input charge order.
	Charges []ChargeAllocation
}

// AmountFor returns the net amount assigned to entity, or zero if absent.
func (r Report) AmountFor(entity string) Money {
	for i := range r.Entities {
		if r.Entities[i].Entity == entity {
			return r.Entities[i].Total
		}
	}
	return 0
}

// EntityFor returns the entity total for entity and whether it was present.
func (r Report) EntityFor(entity string) (EntityTotal, bool) {
	for i := range r.Entities {
		if r.Entities[i].Entity == entity {
			return r.Entities[i], true
		}
	}
	return EntityTotal{}, false
}

// GrandTotal returns the signed net total of the report.
func (r Report) GrandTotal() Money { return r.Totals.Net }

// Check verifies the report's internal invariants: every charge is conserved,
// entity totals add up, and report totals agree with both.
func (r Report) Check() error {
	var direct, shared, savings, net totalAccumulator
	var unallocated totalAccumulator
	seenEntities := make(map[string]struct{}, len(r.Entities))
	byEntity := make(map[string]EntityTotal, len(r.Entities))

	for _, entity := range r.Entities {
		if _, ok := seenEntities[entity.Entity]; ok {
			return fmt.Errorf("formal: duplicate entity %q in report", entity.Entity)
		}
		seenEntities[entity.Entity] = struct{}{}
		byEntity[entity.Entity] = entity

		expected, err := combine(entity.Direct, entity.Shared, entity.Savings)
		if err != nil {
			return fmt.Errorf("formal: entity %q total: %w", entity.Entity, err)
		}
		if entity.Total != expected {
			return fmt.Errorf("formal: entity %q total is %s, want %s", entity.Entity, entity.Total, expected)
		}
		if entity.Unallocated != (entity.Entity == r.UnallocatedEntity) {
			return fmt.Errorf("formal: entity %q has inconsistent unallocated flag", entity.Entity)
		}
		if err := direct.add(entity.Direct); err != nil {
			return err
		}
		if err := shared.add(entity.Shared); err != nil {
			return err
		}
		if err := savings.add(entity.Savings); err != nil {
			return err
		}
		if err := net.add(entity.Total); err != nil {
			return err
		}
		if entity.Unallocated {
			if err := unallocated.add(entity.Total); err != nil {
				return err
			}
		}
	}

	if direct.value != r.Totals.Direct || shared.value != r.Totals.Shared ||
		savings.value != r.Totals.Savings || net.value != r.Totals.Net ||
		unallocated.value != r.Totals.Unallocated {
		return fmt.Errorf("formal: report totals do not match entity totals")
	}

	fromCharges := make(map[string]*EntityTotal)
	var fromChargeTotal totalAccumulator
	seenCharges := make(map[string]struct{}, len(r.Charges))
	for _, charge := range r.Charges {
		if _, ok := seenCharges[charge.ChargeID]; ok {
			return fmt.Errorf("formal: duplicate charge %q in report", charge.ChargeID)
		}
		seenCharges[charge.ChargeID] = struct{}{}
		switch charge.Kind {
		case KindDirect, KindShared, KindSaving:
		default:
			return fmt.Errorf("formal: charge %q has unknown kind %q", charge.ChargeID, charge.Kind)
		}
		if len(charge.Allocations) == 0 {
			return fmt.Errorf("formal: charge %q has no allocations", charge.ChargeID)
		}
		if charge.Kind == KindDirect {
			if len(charge.Allocations) != 1 || charge.Allocations[0].Weight != 1 {
				return fmt.Errorf("formal: direct charge %q must have one unit-weight allocation", charge.ChargeID)
			}
		}

		if charge.Kind == KindSaving {
			if charge.Requested < 0 {
				return fmt.Errorf("formal: saving charge %q has negative requested amount", charge.ChargeID)
			}
			expectedEffective, err := negateMoney(charge.Requested)
			if err != nil {
				return fmt.Errorf("formal: charge %q: %w", charge.ChargeID, err)
			}
			if charge.Effective != expectedEffective {
				return fmt.Errorf("formal: saving charge %q effective is %s, want %s",
					charge.ChargeID, charge.Effective, expectedEffective)
			}
		} else if charge.Effective != charge.Requested {
			return fmt.Errorf("formal: charge %q effective is %s, want %s",
				charge.ChargeID, charge.Effective, charge.Requested)
		}

		var chargeSum totalAccumulator
		weightSum := int64(0)
		for _, allocation := range charge.Allocations {
			if err := chargeSum.add(allocation.Amount); err != nil {
				return err
			}
			if allocation.Weight < 0 || allocation.Weight > math.MaxInt64-weightSum {
				return fmt.Errorf("formal: charge %q has invalid weight", charge.ChargeID)
			}
			weightSum += allocation.Weight
			if allocation.Unallocated != (allocation.Entity == r.UnallocatedEntity) {
				return fmt.Errorf("formal: charge %q has inconsistent unallocated flag", charge.ChargeID)
			}
			if allocation.Amount == 0 {
				continue
			}
			entity := fromCharges[allocation.Entity]
			if entity == nil {
				entity = &EntityTotal{
					Entity:      allocation.Entity,
					Unallocated: allocation.Unallocated,
				}
				fromCharges[allocation.Entity] = entity
			}
			var err error
			switch charge.Kind {
			case KindDirect:
				entity.Direct, err = addMoney(entity.Direct, allocation.Amount)
			case KindShared:
				entity.Shared, err = addMoney(entity.Shared, allocation.Amount)
			case KindSaving:
				var saving Money
				saving, err = negateMoney(allocation.Amount)
				if err == nil {
					entity.Savings, err = addMoney(entity.Savings, saving)
				}
			default:
				return fmt.Errorf("formal: charge %q has unknown kind %q", charge.ChargeID, charge.Kind)
			}
			if err != nil {
				return err
			}
			entity.Total, err = addMoney(entity.Total, allocation.Amount)
			if err != nil {
				return err
			}
		}
		if weightSum != charge.TotalWeight {
			return fmt.Errorf("formal: charge %q weights total %d, want %d",
				charge.ChargeID, weightSum, charge.TotalWeight)
		}
		if chargeSum.value != charge.Effective {
			return fmt.Errorf("formal: charge %q allocations total %s, want %s",
				charge.ChargeID, chargeSum.value, charge.Effective)
		}
		if err := fromChargeTotal.add(charge.Effective); err != nil {
			return err
		}
	}
	if fromChargeTotal.value != r.Totals.Net {
		return fmt.Errorf("formal: charge effective total %s does not match report net %s",
			fromChargeTotal.value, r.Totals.Net)
	}

	if len(byEntity) != len(fromCharges) {
		return fmt.Errorf("formal: report has %d entities but charge allocations have %d",
			len(byEntity), len(fromCharges))
	}
	for name, fromCharge := range fromCharges {
		fromReport, ok := byEntity[name]
		if !ok {
			return fmt.Errorf("formal: entity %q has charge allocations but no report total", name)
		}
		if fromReport.Direct != fromCharge.Direct ||
			fromReport.Shared != fromCharge.Shared ||
			fromReport.Savings != fromCharge.Savings ||
			fromReport.Total != fromCharge.Total ||
			fromReport.Unallocated != fromCharge.Unallocated {
			return fmt.Errorf("formal: entity %q totals do not match its charge allocations", name)
		}
	}
	if r.Totals.Charges != len(r.Charges) {
		return fmt.Errorf("formal: charge count is %d, want %d", r.Totals.Charges, len(r.Charges))
	}
	return nil
}

type totalAccumulator struct {
	value Money
}

func (a *totalAccumulator) add(amount Money) error {
	next, err := addMoney(a.value, amount)
	if err != nil {
		return err
	}
	a.value = next
	return nil
}

func combine(direct, shared, savings Money) (Money, error) {
	net, err := addMoney(direct, shared)
	if err != nil {
		return 0, err
	}
	negativeSavings, err := negateMoney(savings)
	if err != nil {
		return 0, err
	}
	return addMoney(net, negativeSavings)
}

func sortEntityTotals(entities []EntityTotal, unallocated string) {
	sort.SliceStable(entities, func(i, j int) bool {
		leftUnallocated := entities[i].Entity == unallocated
		rightUnallocated := entities[j].Entity == unallocated
		if leftUnallocated != rightUnallocated {
			return !leftUnallocated
		}
		return entities[i].Entity < entities[j].Entity
	})
}
