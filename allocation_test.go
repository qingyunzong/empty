package formal

import (
	"fmt"
	"math"
	"reflect"
	"sort"
	"sync"
	"testing"
)

func TestHierarchicalInheritanceSharedWeightsAndUnallocated(t *testing.T) {
	t.Parallel()

	resources := []Resource{
		{ID: "org", Tags: Tags{"team": "platform"}},
		{ID: "a", Parent: "org", Tags: Tags{"team": "alpha"}},
		{ID: "b", Parent: "org", Tags: Tags{"team": "beta"}},
		{ID: "c", Parent: "org", Tags: Tags{"team": ""}},
		{ID: "d", Parent: "org"},
	}
	charges := []Charge{
		DirectCharge("direct-a", "a", 10_000_000),
		DirectCharge("direct-b", "b", 4_000_000),
		DirectCharge("direct-c", "c", 2_000_000),
		DirectCharge("direct-d", "d", 3_000_000),
		{
			ID:         "shared",
			ResourceID: "org",
			Amount:     6_000_000,
			Kind:       KindShared,
			Shares: []Share{
				ResourceShare("a", 1),
				ResourceShare("b", 2),
				ResourceShare("c", 3),
			},
		},
		{
			ID:     "saving",
			Amount: 6_000_000,
			Kind:   KindSaving,
			Shares: []Share{
				ResourceShare("a", 1),
				ResourceShare("b", 2),
				ResourceShare("c", 3),
			},
		},
		{
			ID:     "unknown-share",
			Amount: 1_000_000,
			Kind:   KindShared,
			Shares: []Share{
				EntityShare("alpha", 1),
				{Weight: 1},
			},
		},
	}

	report, err := Allocate(Bill{Resources: resources, Charges: charges}, Options{EntityTag: "team"})
	if err != nil {
		t.Fatal(err)
	}
	if err := report.Check(); err != nil {
		t.Fatal(err)
	}

	want := map[string]Money{
		"alpha":       10_000_000 + 1_000_000 - 1_000_000 + 500_000,
		"beta":        4_000_000 + 2_000_000 - 2_000_000,
		"platform":    2_000_000 + 3_000_000 + 3_000_000 - 3_000_000,
		"unallocated": 500_000,
	}
	for entity, amount := range want {
		if got := report.AmountFor(entity); got != amount {
			t.Errorf("AmountFor(%q) = %s, want %s", entity, got, amount)
		}
	}
	if got, ok := report.EntityFor("platform"); !ok || got.Savings != 3_000_000 {
		t.Fatalf("platform savings = %v, %v", got.Savings, ok)
	}
	if report.Totals.Unallocated != 500_000 {
		t.Fatalf("unallocated total = %s", report.Totals.Unallocated)
	}
	if report.Totals.Net != 20_000_000 {
		t.Fatalf("net = %s, want 20.00", report.Totals.Net)
	}
	if report.Totals.Direct != 19_000_000 || report.Totals.Shared != 7_000_000 || report.Totals.Savings != 6_000_000 {
		t.Fatalf("totals = %+v", report.Totals)
	}
}

func TestLargestRemainderIsExactAndDeterministic(t *testing.T) {
	t.Parallel()

	resources := []Resource{{ID: "r", Tags: Tags{"entity": "root"}}}
	charge := Charge{
		ID:     "tiny",
		Amount: 10,
		Kind:   KindShared,
		Shares: []Share{
			EntityShare("c", 1),
			EntityShare("a", 1),
			EntityShare("b", 1),
		},
	}
	report, err := Allocate(Bill{Resources: resources, Charges: []Charge{charge}})
	if err != nil {
		t.Fatal(err)
	}

	want := map[string]Money{"a": 4, "b": 3, "c": 3}
	for entity, amount := range want {
		if got := report.AmountFor(entity); got != amount {
			t.Errorf("%s = %d, want %d", entity, got, amount)
		}
	}
	if report.GrandTotal() != 10 {
		t.Fatalf("total = %d", report.GrandTotal())
	}

	// Input order must not decide who receives the remainder.
	charge.Shares = []Share{
		EntityShare("b", 1),
		EntityShare("c", 1),
		EntityShare("a", 1),
	}
	again, err := Allocate(Bill{Resources: resources, Charges: []Charge{charge}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(report.Entities, again.Entities) {
		t.Fatalf("allocation depends on share order: %#v vs %#v", report.Entities, again.Entities)
	}
}

func TestSavingCanBeDirectOrWeighted(t *testing.T) {
	t.Parallel()

	resources := []Resource{
		{ID: "root", Tags: Tags{"entity": "platform"}},
		{ID: "a", Parent: "root", Tags: Tags{"entity": "alpha"}},
		{ID: "b", Parent: "root", Tags: Tags{"entity": "beta"}},
	}
	report, err := Allocate(Bill{
		Resources: resources,
		Charges: []Charge{
			{ID: "weighted", Kind: KindSaving, Amount: 1, Shares: []Share{
				EntityShare("alpha", 1),
				EntityShare("beta", 1),
			}},
			{ID: "direct", Kind: KindSaving, ResourceID: "b", Amount: 2},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := report.AmountFor("alpha"); got != -1 {
		t.Fatalf("alpha = %d, want -1", got)
	}
	if got := report.AmountFor("beta"); got != -2 {
		t.Fatalf("beta = %d, want -2", got)
	}
	if report.Totals.Savings != 3 || report.Totals.Net != -3 {
		t.Fatalf("totals = %+v", report.Totals)
	}
}

type naiveEntity struct {
	direct, shared, savings, total Money
	unallocated                    bool
}

type naiveCharge struct {
	effective   Money
	totalWeight int64
	weights     map[string]int64
	allocations map[string]Money
}

type naiveResult struct {
	entities map[string]naiveEntity
	charges  map[string]naiveCharge
	totals   Totals
}

func naiveAllocate(t *testing.T, resources []Resource, charges []Charge, options Options) naiveResult {
	t.Helper()
	options, err := normalizeOptions(options)
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]Resource, len(resources))
	for _, resource := range resources {
		byID[resource.ID] = resource
	}
	resolve := func(resourceID, key string) string {
		seen := map[string]bool{}
		for resourceID != "" {
			if seen[resourceID] {
				t.Fatalf("cycle at %s", resourceID)
			}
			seen[resourceID] = true
			resource := byID[resourceID]
			if value := resource.Tags[key]; value != "" {
				return value
			}
			resourceID = resource.Parent
		}
		return ""
	}

	result := naiveResult{
		entities: map[string]naiveEntity{},
		charges:  map[string]naiveCharge{},
	}
	result.totals.Charges = len(charges)
	addEntity := func(kind Kind, entity string, amount Money) {
		if entity == "" {
			entity = options.UnallocatedEntity
		}
		if amount == 0 {
			return
		}
		entry := result.entities[entity]
		entry.unallocated = entity == options.UnallocatedEntity
		switch kind {
		case KindDirect:
			entry.direct += amount
		case KindShared:
			entry.shared += amount
		case KindSaving:
			entry.savings -= amount
		}
		entry.total += amount
		result.entities[entity] = entry
	}

	for _, charge := range charges {
		shares := append([]Share(nil), charge.Shares...)
		if len(charge.Weights) > 0 {
			entities := make([]string, 0, len(charge.Weights))
			for entity := range charge.Weights {
				entities = append(entities, entity)
			}
			sort.Strings(entities)
			for _, entity := range entities {
				shares = append(shares, EntityShare(entity, charge.Weights[entity]))
			}
		}
		kind := charge.Kind
		if kind == "" {
			if len(shares) > 0 {
				kind = KindShared
			} else {
				kind = KindDirect
			}
		}
		tagKey := options.EntityTag
		if charge.TagKey != "" {
			tagKey = charge.TagKey
		}

		resultCharge := naiveCharge{
			weights:     map[string]int64{},
			allocations: map[string]Money{},
		}
		if kind == KindDirect || (kind == KindSaving && len(shares) == 0) {
			entity := resolve(charge.ResourceID, tagKey)
			if entity == "" {
				entity = options.UnallocatedEntity
			}
			effective := charge.Amount
			if kind == KindSaving {
				effective = -charge.Amount
			}
			addEntity(kind, entity, effective)
			resultCharge.effective = effective
			resultCharge.totalWeight = 1
			resultCharge.weights[entity] = 1
			resultCharge.allocations[entity] = effective
			if kind == KindSaving {
				result.totals.Savings += charge.Amount
			} else {
				result.totals.Direct += charge.Amount
			}
			result.totals.Net += effective
			if entity == options.UnallocatedEntity {
				result.totals.Unallocated += effective
			}
		} else {
			for _, share := range shares {
				entity := share.Entity
				if share.ResourceID != "" {
					entity = resolve(share.ResourceID, tagKey)
				}
				if entity == "" {
					entity = options.UnallocatedEntity
				}
				resultCharge.weights[entity] += share.Weight
			}
			entities := make([]string, 0, len(resultCharge.weights))
			for entity := range resultCharge.weights {
				entities = append(entities, entity)
				resultCharge.totalWeight += resultCharge.weights[entity]
			}
			sort.Strings(entities)
			effective := charge.Amount
			if kind == KindSaving {
				effective = -charge.Amount
			}
			parts := naiveSplit(t, effective, entities, resultCharge.weights)
			for _, entity := range entities {
				resultCharge.allocations[entity] = parts[entity]
				addEntity(kind, entity, parts[entity])
			}
			resultCharge.effective = effective
			if kind == KindSaving {
				result.totals.Savings += charge.Amount
			} else {
				result.totals.Shared += charge.Amount
			}
			result.totals.Net += effective
			if amount, ok := parts[options.UnallocatedEntity]; ok {
				result.totals.Unallocated += amount
			}
		}
		result.charges[charge.ID] = resultCharge
	}
	return result
}

func naiveSplit(t *testing.T, amount Money, entities []string, weights map[string]int64) map[string]Money {
	t.Helper()
	total := int64(0)
	for _, entity := range entities {
		total += weights[entity]
	}
	if total <= 0 {
		t.Fatalf("invalid total weight %d", total)
	}

	negative := amount < 0
	absolute := amount
	if negative {
		absolute = -absolute
	}
	parts := make(map[string]Money, len(entities))
	remainders := make(map[string]int64, len(entities))
	sum := Money(0)
	for _, entity := range entities {
		numerator := int64(absolute) * weights[entity]
		parts[entity] = Money(numerator / total)
		remainders[entity] = numerator % total
		sum += parts[entity]
	}
	remaining := absolute - sum
	order := append([]string(nil), entities...)
	sort.SliceStable(order, func(i, j int) bool {
		if remainders[order[i]] != remainders[order[j]] {
			return remainders[order[i]] > remainders[order[j]]
		}
		return order[i] < order[j]
	})
	for i := 0; i < int(remaining); i++ {
		parts[order[i]]++
	}
	if negative {
		for entity := range parts {
			parts[entity] = -parts[entity]
		}
	}
	return parts
}

func TestExhaustiveSmallBillsAgainstNaiveRecompute(t *testing.T) {
	t.Parallel()

	baseResources := []Resource{
		{ID: "root"},
		{ID: "a", Parent: "root"},
		{ID: "b", Parent: "root"},
		{ID: "c", Parent: "root"},
		{ID: "shared", Parent: "root"},
	}
	tagVariants := [][]Tags{
		{
			{"entity": "root-team"},
			nil,
			{"entity": "beta"},
			{},
			nil,
		},
		{
			nil,
			{"entity": "alpha"},
			{"entity": "beta"},
			{"entity": "gamma"},
			nil,
		},
		{
			{"entity": "platform"},
			{"entity": "alpha"},
			{"entity": "beta"},
			{"entity": "gamma"},
			{"entity": "platform"},
		},
		{
			{},
			{},
			{},
			{},
			{},
		},
	}
	weightSets := [][]Share{
		{EntityShare("alpha", 1), EntityShare("beta", 2), EntityShare("gamma", 1)},
		{EntityShare("alpha", 1), EntityShare("beta", 1), EntityShare("gamma", 1)},
		{EntityShare("root-team", 1)},
		{ResourceShare("a", 1), ResourceShare("b", 2), ResourceShare("c", 3)},
		{ResourceShare("a", 1), EntityShare("beta", 2), {Weight: 1}},
		{EntityShare("unallocated", 2), EntityShare("alpha", 3)},
	}
	directAmounts := []Money{0, 1, 7, -3}
	sharedAmounts := []Money{0, 1, 7, -4, 10}
	savingAmounts := []Money{0, 1, 6}

	cases := 0
	for variantIndex, variant := range tagVariants {
		resources := make([]Resource, len(baseResources))
		copy(resources, baseResources)
		for i := range resources {
			resources[i].Tags = variant[i]
		}

		for _, directResource := range []string{"root", "a", "b", "c"} {
			for _, directAmount := range directAmounts {
				for weightIndex, shares := range weightSets {
					for _, sharedAmount := range sharedAmounts {
						for savingVariant := 0; savingVariant < 4; savingVariant++ {
							for _, savingAmount := range savingAmounts {
								charges := []Charge{
									DirectCharge("direct", directResource, directAmount),
									{
										ID:         "shared",
										ResourceID: "shared",
										Amount:     sharedAmount,
										Kind:       KindShared,
										Shares:     append([]Share(nil), shares...),
									},
								}
								switch savingVariant {
								case 0:
								case 1:
									charges = append(charges, Charge{
										ID:     "saving",
										Amount: savingAmount,
										Kind:   KindSaving,
										Shares: append([]Share(nil), shares...),
									})
								case 2:
									charges = append(charges, Charge{
										ID:         "saving",
										ResourceID: "b",
										Amount:     savingAmount,
										Kind:       KindSaving,
									})
								case 3:
									charges = append(charges, Charge{
										ID:     "saving",
										Amount: savingAmount,
										Kind:   KindSaving,
										Shares: []Share{
											ResourceShare("a", 1),
											ResourceShare("b", 1),
											ResourceShare("c", 1),
										},
									})
								}

								name := fmt.Sprintf("variant=%d/direct=%s:%d/weights=%d/shared=%d/saving=%d:%d",
									variantIndex, directResource, directAmount, weightIndex, sharedAmount,
									savingVariant, savingAmount)
								report, err := Allocate(Bill{Resources: resources, Charges: charges})
								if err != nil {
									t.Fatalf("%s: %v", name, err)
								}
								expected := naiveAllocate(t, resources, charges, Options{})
								compareReports(t, name, report, expected)
								cases++
							}
						}
					}
				}
			}
		}
	}
	if cases < 10_000 {
		t.Fatalf("expected broad exhaustive coverage, ran only %d cases", cases)
	}
}

func compareReports(t *testing.T, name string, report Report, expected naiveResult) {
	t.Helper()
	if err := report.Check(); err != nil {
		t.Fatalf("%s: report invariant: %v", name, err)
	}
	if report.Totals.Charges != expected.totals.Charges ||
		report.Totals.Direct != expected.totals.Direct ||
		report.Totals.Shared != expected.totals.Shared ||
		report.Totals.Savings != expected.totals.Savings ||
		report.Totals.Net != expected.totals.Net ||
		report.Totals.Unallocated != expected.totals.Unallocated {
		t.Fatalf("%s: totals = %+v, want %+v", name, report.Totals, expected.totals)
	}

	seen := map[string]bool{}
	for _, entity := range report.Entities {
		seen[entity.Entity] = true
		want, ok := expected.entities[entity.Entity]
		if !ok {
			t.Fatalf("%s: unexpected entity %q", name, entity.Entity)
		}
		got := naiveEntity{
			direct: entity.Direct, shared: entity.Shared, savings: entity.Savings,
			total: entity.Total, unallocated: entity.Unallocated,
		}
		if got != want {
			t.Fatalf("%s: entity %q = %+v, want %+v", name, entity.Entity, got, want)
		}
	}
	for entity := range expected.entities {
		if !seen[entity] {
			t.Fatalf("%s: missing entity %q", name, entity)
		}
	}

	if len(report.Charges) != len(expected.charges) {
		t.Fatalf("%s: charge count = %d, want %d", name, len(report.Charges), len(expected.charges))
	}
	for _, charge := range report.Charges {
		want := expected.charges[charge.ChargeID]
		if charge.Effective != want.effective {
			t.Fatalf("%s: charge %q effective = %s, want %s",
				name, charge.ChargeID, charge.Effective, want.effective)
		}
		if charge.TotalWeight != want.totalWeight {
			t.Fatalf("%s: charge %q weight = %d, want %d",
				name, charge.ChargeID, charge.TotalWeight, want.totalWeight)
		}
		gotAllocations := map[string]Money{}
		gotWeights := map[string]int64{}
		for _, allocation := range charge.Allocations {
			gotAllocations[allocation.Entity] = allocation.Amount
			gotWeights[allocation.Entity] = allocation.Weight
		}
		if !reflect.DeepEqual(gotAllocations, want.allocations) {
			t.Fatalf("%s: charge %q allocations = %v, want %v",
				name, charge.ChargeID, gotAllocations, want.allocations)
		}
		if !reflect.DeepEqual(gotWeights, want.weights) {
			t.Fatalf("%s: charge %q weights = %v, want %v",
				name, charge.ChargeID, gotWeights, want.weights)
		}
	}
}

func TestTagUpdatesAndAllocationsInterleaveWithoutDoubleCounting(t *testing.T) {
	t.Parallel()

	allocator := NewAllocator(Options{EntityTag: "team"})
	mustAddResource := func(resource Resource) {
		t.Helper()
		if err := allocator.AddResource(resource); err != nil {
			t.Fatal(err)
		}
	}
	mustAddResource(Resource{ID: "root", Tags: Tags{"team": "platform"}})
	mustAddResource(Resource{ID: "a", Parent: "root"})
	mustAddResource(Resource{ID: "b", Parent: "root", Tags: Tags{"team": "beta"}})
	mustAddResource(Resource{ID: "c", Parent: "root"})

	for _, charge := range []Charge{
		DirectCharge("direct-a", "a", 7),
		DirectCharge("direct-b", "b", 11),
		{
			ID: "shared", ResourceID: "root", Amount: 13, Kind: KindShared,
			Shares: []Share{ResourceShare("a", 1), ResourceShare("b", 2), ResourceShare("c", 1)},
		},
		{
			ID: "saving", Amount: 5, Kind: KindSaving,
			Shares: []Share{ResourceShare("a", 1), ResourceShare("b", 1), ResourceShare("c", 1)},
		},
	} {
		if err := allocator.AddCharge(charge); err != nil {
			t.Fatal(err)
		}
	}

	expectedNet := Money(7 + 11 + 13 - 5)
	first, err := allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	firstEntity, _ := first.EntityFor("platform")
	firstRevision := first.Revision

	updates := []string{"alpha", "beta", "platform", ""}
	var previous *Report
	for i := 0; i < 40; i++ {
		if err := allocator.SetTag("a", "team", updates[i%len(updates)]); err != nil {
			t.Fatal(err)
		}
		report, err := allocator.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		if report.Totals.Net != expectedNet {
			t.Fatalf("iteration %d: net = %s, want %s", i, report.Totals.Net, expectedNet)
		}
		if err := report.Check(); err != nil {
			t.Fatalf("iteration %d: %v", i, err)
		}

		again, err := allocator.Allocate()
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(report, again) {
			t.Fatalf("iteration %d: repeated allocation changed the report", i)
		}
		if previous != nil && report.Totals.Net != previous.Totals.Net {
			t.Fatalf("iteration %d: interleaved allocation changed net", i)
		}
		previous = &report
	}

	afterFirst, ok := first.EntityFor("platform")
	if !ok || afterFirst != firstEntity {
		t.Fatalf("historical report was mutated: %+v -> %+v", firstEntity, afterFirst)
	}
	if first.Revision != firstRevision {
		t.Fatalf("historical report revision changed")
	}
	if allocator.Revision() <= firstRevision {
		t.Fatal("tag updates did not advance revision")
	}
}

func TestConcurrentAllocationAndTagUpdates(t *testing.T) {
	allocator := NewAllocator()
	if err := allocator.AddResource(Resource{ID: "root", Tags: Tags{"entity": "root"}}); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddResource(Resource{ID: "leaf", Parent: "root"}); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddCharge(DirectCharge("direct", "leaf", 17)); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddCharge(Charge{
		ID: "shared", Amount: 9, Kind: KindShared,
		Shares: []Share{ResourceShare("leaf", 1), EntityShare("other", 2)},
	}); err != nil {
		t.Fatal(err)
	}

	var wait sync.WaitGroup
	errors := make(chan error, 16)
	for worker := 0; worker < 8; worker++ {
		wait.Add(1)
		go func(worker int) {
			defer wait.Done()
			for i := 0; i < 100; i++ {
				if err := allocator.SetTag("leaf", "entity", fmt.Sprintf("team-%d", (worker+i)%3)); err != nil {
					errors <- err
					return
				}
				report, err := allocator.Allocate()
				if err != nil {
					errors <- err
					return
				}
				if report.Totals.Net != 26 {
					errors <- fmt.Errorf("net = %d, want 26", report.Totals.Net)
					return
				}
			}
		}(worker)
	}
	wait.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
}

func TestValidation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		resources []Resource
		charges   []Charge
	}{
		{
			name:      "duplicate resource",
			resources: []Resource{{ID: "x"}, {ID: "x"}},
		},
		{
			name:      "unknown parent",
			resources: []Resource{{ID: "x", Parent: "missing"}},
		},
		{
			name:      "cycle",
			resources: []Resource{{ID: "x", Parent: "y"}, {ID: "y", Parent: "x"}},
		},
		{
			name: "unknown charge resource",
			charges: []Charge{
				{ID: "c", ResourceID: "missing", Amount: 1, Kind: KindDirect},
			},
		},
		{
			name:    "direct without resource",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindDirect}},
		},
		{
			name:    "shared without weights",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindShared}},
		},
		{
			name:    "negative weight",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindShared, Shares: []Share{EntityShare("x", -1)}}},
		},
		{
			name:    "zero total weight",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindShared, Shares: []Share{EntityShare("x", 0)}}},
		},
		{
			name:    "ambiguous share",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindShared, Shares: []Share{{Entity: "x", ResourceID: "r", Weight: 1}}}},
		},
		{
			name:    "shared and weights",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindShared, Shares: []Share{EntityShare("x", 1)}, Weights: map[string]int64{"x": 1}}},
		},
		{
			name:    "negative saving",
			charges: []Charge{{ID: "c", Amount: -1, Kind: KindSaving, Shares: []Share{EntityShare("x", 1)}}},
		},
		{
			name:    "saving without target",
			charges: []Charge{{ID: "c", Amount: 1, Kind: KindSaving}},
		},
		{
			name:    "unknown kind",
			charges: []Charge{{ID: "c", Amount: 1, Kind: "mystery"}},
		},
		{
			name: "duplicate charge",
			charges: []Charge{
				{ID: "c", Kind: KindShared, Amount: 1, Shares: []Share{EntityShare("x", 1)}},
				{ID: "c", Kind: KindShared, Amount: 2, Shares: []Share{EntityShare("x", 1)}},
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Allocate(Bill{Resources: test.resources, Charges: test.charges}); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestMissingTagGoesToUnallocated(t *testing.T) {
	t.Parallel()

	report, err := Allocate(Bill{
		Resources: []Resource{{ID: "leaf"}},
		Charges: []Charge{
			DirectCharge("direct", "leaf", 5),
			{
				ID: "shared", Amount: 3, Kind: KindShared,
				Shares: []Share{ResourceShare("leaf", 2), EntityShare("known", 1)},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("unallocated") != 7 {
		t.Fatalf("unallocated = %d", report.AmountFor("unallocated"))
	}
	if entity, ok := report.EntityFor("unallocated"); !ok || !entity.Unallocated {
		t.Fatalf("missing controlled unallocated entry: %+v, %v", entity, ok)
	}
	if report.AmountFor("known") != 1 {
		t.Fatalf("known = %d", report.AmountFor("known"))
	}
}

func TestWeightsConvenienceChargeTagKeyAndCustomUnallocated(t *testing.T) {
	t.Parallel()

	resources := []Resource{
		{ID: "root", Tags: Tags{"cost_center": "shared-owner"}},
		{ID: "a", Parent: "root", Tags: Tags{"cost_center": "alpha"}},
		{ID: "b", Parent: "root"},
	}
	report, err := Allocate(Bill{
		Resources: resources,
		Charges: []Charge{
			{
				ID:         "direct",
				ResourceID: "b",
				Amount:     4,
				TagKey:     "entity",
			},
			SharedCharge("shared", "root", 6, map[string]int64{
				"alpha": 1,
				"beta":  2,
				"":      1,
			}),
			SavingCharge("saving", "a", 3, map[string]int64{
				"alpha": 2,
				"beta":  1,
			}),
		},
	}, Options{EntityTag: "cost_center", UnallocatedEntity: "MISSING"})
	if err != nil {
		t.Fatal(err)
	}

	// The direct charge uses Charge.TagKey, which overrides the global tag key.
	if got := report.AmountFor("MISSING"); got != 4+2 {
		t.Fatalf("MISSING = %d, want 6", got)
	}
	if got := report.AmountFor("alpha"); got != -1 {
		t.Fatalf("alpha = %d, want -1", got)
	}
	if got := report.AmountFor("beta"); got != 2 {
		t.Fatalf("beta = %d, want 2", got)
	}
	if entity, ok := report.EntityFor("MISSING"); !ok || !entity.Unallocated {
		t.Fatalf("custom unallocated entity = %+v, %v", entity, ok)
	}
	if report.Totals.Net != 7 || report.Totals.Unallocated != 6 {
		t.Fatalf("totals = %+v", report.Totals)
	}
}

func TestAllocatorSnapshotsAndTagMutationMethods(t *testing.T) {
	t.Parallel()

	allocator := NewAllocator()
	if err := allocator.AddResource(Resource{ID: "root", Tags: Tags{"entity": "root-team"}}); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddResource(Resource{ID: "leaf", Parent: "root"}); err != nil {
		t.Fatal(err)
	}
	weights := map[string]int64{"alpha": 1, "beta": 1}
	if err := allocator.AddCharge(Charge{
		ID:      "shared",
		Amount:  5,
		Kind:    KindShared,
		Weights: weights,
	}); err != nil {
		t.Fatal(err)
	}
	weights["alpha"] = 100

	resources := allocator.Resources()
	resources[1].Tags["entity"] = "tampered"
	charges := allocator.Charges()
	charges[0].Weights["alpha"] = 100
	bill := allocator.Bill()
	bill.Resources[0].Tags["entity"] = "also-tampered"

	report, err := allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("alpha") != 3 || report.AmountFor("beta") != 2 {
		t.Fatalf("internal state was mutated through a snapshot: %+v", report.Entities)
	}

	if err := allocator.SetTags("leaf", Tags{"entity": "alpha"}); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddCharge(DirectCharge("direct", "leaf", 4)); err != nil {
		t.Fatal(err)
	}
	report, err = allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("alpha") != 7 {
		t.Fatalf("alpha after SetTags = %d, want 7", report.AmountFor("alpha"))
	}

	revision := allocator.Revision()
	if err := allocator.DeleteTag("leaf", "entity"); err != nil {
		t.Fatal(err)
	}
	if allocator.Revision() != revision+1 {
		t.Fatal("DeleteTag did not bump revision")
	}
	revision++
	if err := allocator.UpdateTags("leaf", Tags{"entity": ""}); err != nil {
		t.Fatal(err)
	}
	if allocator.Revision() != revision {
		t.Fatal("no-op tag update bumped revision")
	}

	report, err = allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("root-team") != 4 {
		t.Fatalf("leaf did not fall back to inherited tag: %+v", report.Entities)
	}
	if err := allocator.SetTag("leaf", "team", "alpha"); err != nil {
		t.Fatal(err)
	}
	report, err = allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("root-team") != 4 {
		t.Fatalf("unrelated tag changed entity: %+v", report.Entities)
	}
}

func TestOptionValidationAndReportTamperDetection(t *testing.T) {
	t.Parallel()

	if _, err := Allocate(Bill{}, Options{}, Options{}); err == nil {
		t.Fatal("expected multiple options error")
	}
	if _, err := Allocate(Bill{}, Options{EntityTag: " "}); err == nil {
		t.Fatal("expected blank entity tag error")
	}
	if _, err := Allocate(Bill{}, Options{UnallocatedEntity: "\t"}); err == nil {
		t.Fatal("expected blank unallocated entity error")
	}
	allocator := NewAllocator(Options{}, Options{})
	if _, err := allocator.Allocate(); err == nil {
		t.Fatal("expected allocator init error")
	}

	report, err := Allocate(Bill{
		Resources: []Resource{{ID: "r", Tags: Tags{"entity": "x"}}},
		Charges:   []Charge{DirectCharge("c", "r", 3)},
	})
	if err != nil {
		t.Fatal(err)
	}
	report.Entities[0].Total++
	if err := report.Check(); err == nil {
		t.Fatal("expected tampered report to fail Check")
	}
}

func TestZeroValueAllocator(t *testing.T) {
	t.Parallel()

	var allocator Allocator
	if err := allocator.AddResource(Resource{ID: "r", Tags: Tags{"entity": "x"}}); err != nil {
		t.Fatal(err)
	}
	if err := allocator.AddCharge(DirectCharge("c", "r", 1)); err != nil {
		t.Fatal(err)
	}
	report, err := allocator.Allocate()
	if err != nil {
		t.Fatal(err)
	}
	if report.AmountFor("x") != 1 {
		t.Fatalf("zero-value allocator report = %+v", report)
	}
}

func TestOverflowGuards(t *testing.T) {
	t.Parallel()

	resources := []Resource{{ID: "r", Tags: Tags{"entity": "x"}}}
	if _, err := Allocate(Bill{
		Resources: resources,
		Charges: []Charge{
			DirectCharge("a", "r", Money(math.MaxInt64)),
			DirectCharge("b", "r", 1),
		},
	}); err == nil {
		t.Fatal("expected total overflow")
	}
	if _, err := Allocate(Bill{Charges: []Charge{{
		ID: "w", Amount: 1, Kind: KindShared,
		Shares: []Share{EntityShare("x", math.MaxInt64), EntityShare("y", 1)},
	}}}); err == nil {
		t.Fatal("expected weight overflow")
	}
	if _, err := Allocate(Bill{Charges: []Charge{{
		ID: "m", Amount: Money(math.MinInt64), Kind: KindShared,
		Shares: []Share{EntityShare("x", 1)},
	}}}); err == nil {
		t.Fatal("expected unsupported minimum amount")
	}
}
