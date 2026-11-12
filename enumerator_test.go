package dataeng

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

func txn(id, weight uint64, items ...string) Transaction {
	return Transaction{ID: id, Weight: weight, Items: items}
}

func collect(t *testing.T, e *Enumerator) []Itemset {
	t.Helper()
	var result []Itemset
	for {
		item, ok := e.Next()
		if !ok {
			break
		}
		result = append(result, item)
	}
	return result
}

func maskOf(indices []int) uint64 {
	var mask uint64
	for _, index := range indices {
		mask |= uint64(1) << uint(index)
	}
	return mask
}

func assertItemset(t *testing.T, got Itemset, wantMask uint64, wantSupport uint64, dictionary []string) {
	t.Helper()
	if got.Support != wantSupport {
		t.Fatalf("support = %d, want %d for mask %#x", got.Support, wantSupport, wantMask)
	}
	if mask := maskOf(got.Indices); mask != wantMask {
		t.Fatalf("indices mask = %#x, want %#x", mask, wantMask)
	}
	wantItems := make([]string, 0)
	for i := 0; i < len(dictionary); i++ {
		if wantMask&(uint64(1)<<uint(i)) != 0 {
			wantItems = append(wantItems, dictionary[i])
		}
	}
	if !reflect.DeepEqual(got.Items, wantItems) {
		t.Fatalf("items = %#v, want %#v", got.Items, wantItems)
	}
}

type refData struct {
	dictionary   []string
	transactions []refTransaction
	itemCount    int
	fullItems    uint64
}

type refTransaction struct {
	weight uint64
	items  uint64
}

func buildReference(dictionary []string, transactions []Transaction) refData {
	itemIndex := make(map[string]int, len(dictionary))
	for i, item := range dictionary {
		itemIndex[item] = i
	}
	result := refData{
		dictionary: dictionary,
		itemCount:  len(dictionary),
		fullItems:  (uint64(1) << uint(len(dictionary))) - 1,
	}
	for _, transaction := range transactions {
		var mask uint64
		for _, item := range transaction.Items {
			mask |= uint64(1) << uint(itemIndex[item])
		}
		result.transactions = append(result.transactions, refTransaction{
			weight: transaction.Weight,
			items:  mask,
		})
	}
	return result
}

func (r refData) coverage(mask uint64) uint64 {
	var cover uint64
	for i, transaction := range r.transactions {
		if transaction.items&mask == mask {
			cover |= uint64(1) << uint(i)
		}
	}
	return cover
}

func (r refData) supportOfCover(cover uint64) uint64 {
	var support uint64
	for cover != 0 {
		i := 0
		for cover&(uint64(1)<<uint(i)) == 0 {
			i++
		}
		support += r.transactions[i].weight
		cover &= cover - 1
	}
	return support
}

func (r refData) support(mask uint64) uint64 {
	return r.supportOfCover(r.coverage(mask))
}

func (r refData) closure(mask uint64) uint64 {
	cover := r.coverage(mask)
	if cover == 0 {
		return r.fullItems
	}
	closure := r.fullItems
	for i, transaction := range r.transactions {
		if cover&(uint64(1)<<uint(i)) != 0 {
			closure &= transaction.items
		}
	}
	return closure
}

func (r refData) exhaustive(minSupport uint64) map[uint64]uint64 {
	expected := make(map[uint64]uint64)
	limit := uint64(1) << uint(r.itemCount)
	for mask := uint64(0); mask < limit; mask++ {
		support := r.support(mask)
		if support >= minSupport && r.closure(mask) == mask {
			expected[mask] = support
		}
	}
	return expected
}

type refResult struct {
	mask    uint64
	support uint64
}

type refWork struct {
	attempts  uint64
	coverAnds uint64
}

func (r refData) ordered(minSupport uint64) ([]refResult, refWork) {
	var results []refResult
	var work refWork

	root := r.closure(0)
	if r.support(root) >= minSupport {
		results = append(results, refResult{mask: root, support: r.support(root)})
	}

	var walk func(current uint64, start int)
	walk = func(current uint64, start int) {
		for extension := start; extension < r.itemCount; extension++ {
			bit := uint64(1) << uint(extension)
			if current&bit != 0 {
				continue
			}
			work.attempts++
			work.coverAnds++

			closure := r.closure(current | bit)
			support := r.support(current | bit)
			if support < minSupport {
				continue
			}
			for item := 0; item < extension; item++ {
				itemBit := uint64(1) << uint(item)
				if closure&itemBit != 0 && current&itemBit == 0 {
					goto nextExtension
				}
			}
			results = append(results, refResult{mask: closure, support: support})
			walk(closure, extension+1)
		nextExtension:
		}
	}
	walk(root, 0)
	return results, work
}

func compareExhaustive(t *testing.T, got []Itemset, expected map[uint64]uint64, dictionary []string) {
	t.Helper()
	gotByMask := make(map[uint64]uint64, len(got))
	for _, item := range got {
		mask := maskOf(item.Indices)
		if _, duplicate := gotByMask[mask]; duplicate {
			t.Fatalf("duplicate result for mask %#x", mask)
		}
		gotByMask[mask] = item.Support
		items := make([]string, 0, len(item.Indices))
		for _, index := range item.Indices {
			items = append(items, dictionary[index])
		}
		if !reflect.DeepEqual(items, item.Items) {
			t.Fatalf("items and indices disagree for mask %#x: %#v vs %#v", mask, item.Items, items)
		}
	}
	if !reflect.DeepEqual(gotByMask, expected) {
		t.Fatalf("result set mismatch\n got: %#v\nwant: %#v", gotByMask, expected)
	}
}

func compareOrdered(t *testing.T, got []Itemset, want []refResult) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("sequence length = %d, want %d\ngot: %#v\nwant: %#v", len(got), len(want), got, want)
	}
	for i := range want {
		if mask := maskOf(got[i].Indices); mask != want[i].mask {
			t.Fatalf("result %d mask = %#x, want %#x", i, mask, want[i].mask)
		}
		if got[i].Support != want[i].support {
			t.Fatalf("result %d support = %d, want %d", i, got[i].Support, want[i].support)
		}
	}
}

func randomDatabase(rng *rand.Rand) ([]string, []Transaction, uint64) {
	itemCount := rng.Intn(13)
	dictionary := make([]string, itemCount)
	for i := range dictionary {
		dictionary[i] = fmt.Sprintf("item-%d", i)
	}

	transactionCount := rng.Intn(12)
	transactions := make([]Transaction, 0, transactionCount)
	var total uint64
	for i := 0; i < transactionCount; i++ {
		weight := uint64(rng.Intn(9) + 1)
		total += weight
		var items []string
		for item := 0; item < itemCount; item++ {
			if rng.Intn(100) < 55 {
				items = append(items, dictionary[item])
				if rng.Intn(100) < 10 {
					items = append(items, dictionary[item])
				}
			}
		}
		transactions = append(transactions, Transaction{
			ID:     uint64(i*37 + rng.Intn(37)),
			Weight: weight,
			Items:  items,
		})
	}
	// IDs from the expression above can collide for adjacent i. Make them
	// unique without changing any other property under test.
	seen := make(map[uint64]struct{}, len(transactions))
	for i := range transactions {
		for {
			if _, exists := seen[transactions[i].ID]; !exists {
				break
			}
			transactions[i].ID++
		}
		seen[transactions[i].ID] = struct{}{}
	}

	minimum := uint64(rng.Intn(int(total)+4) + 1)
	return dictionary, transactions, minimum
}

func TestRandomAgainstExhaustiveAndOrderedReferences(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for iteration := 0; iteration < 250; iteration++ {
		dictionary, transactions, minimum := randomDatabase(rng)
		reference := buildReference(dictionary, transactions)

		e, err := NewEnumerator(dictionary, transactions, minimum)
		if err != nil {
			t.Fatalf("iteration %d: NewEnumerator: %v", iteration, err)
		}
		got := collect(t, e)
		compareExhaustive(t, got, reference.exhaustive(minimum), dictionary)

		ordered, work := reference.ordered(minimum)
		compareOrdered(t, got, ordered)

		stats := e.Stats()
		if stats.ExtensionAttempts != work.attempts {
			t.Fatalf("iteration %d: extension attempts = %d, want %d", iteration, stats.ExtensionAttempts, work.attempts)
		}
		if stats.CoverIntersections != work.coverAnds {
			t.Fatalf("iteration %d: cover intersections = %d, want %d", iteration, stats.CoverIntersections, work.coverAnds)
		}
		if stats.StackDepth != 0 {
			t.Fatalf("iteration %d: stack depth after exhaustion = %d", iteration, stats.StackDepth)
		}
	}
}

func TestTwelveItemExhaustiveReference(t *testing.T) {
	dictionary := []string{"i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7", "i8", "i9", "i10", "i11"}
	transactions := []Transaction{
		{ID: 1, Weight: 4, Items: []string{"i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"}},
		{ID: 2, Weight: 3, Items: []string{"i0", "i1", "i2", "i3", "i4", "i5", "i8"}},
		{ID: 3, Weight: 6, Items: []string{"i2", "i3", "i4", "i6", "i7"}},
		{ID: 4, Weight: 1, Items: dictionary},
		{ID: 5, Weight: 2, Items: []string{"i8", "i9", "i10"}},
	}
	const minimum = 5
	reference := buildReference(dictionary, transactions)
	e, err := NewEnumerator(dictionary, transactions, minimum)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	compareExhaustive(t, got, reference.exhaustive(minimum), dictionary)
	ordered, work := reference.ordered(minimum)
	compareOrdered(t, got, ordered)
	stats := e.Stats()
	if stats.ExtensionAttempts != work.attempts || stats.CoverIntersections != work.coverAnds {
		t.Fatalf("counters = %#v, want attempts=%d intersections=%d", stats, work.attempts, work.coverAnds)
	}
}

func TestWeightedSupportNotTransactionCount(t *testing.T) {
	dictionary := []string{"a", "b", "c"}
	transactions := []Transaction{
		txn(1, 5, "a", "b"),
		txn(2, 1, "a", "b"),
		txn(3, 1, "a", "c"),
	}
	e, err := NewEnumerator(dictionary, transactions, 6)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	want := map[uint64]uint64{
		0b001: 7, // {a}
		0b011: 6, // {a,b}
	}
	compareExhaustive(t, got, want, dictionary)
	for _, item := range got {
		if maskOf(item.Indices) == 0b011 && item.Support == 6 {
			return
		}
	}
	t.Fatal("weighted {a,b} result was not delivered")
}

func TestSameSupportDifferentCoverage(t *testing.T) {
	dictionary := []string{"a", "b", "c"}
	transactions := []Transaction{
		txn(1, 2, "a"),
		txn(2, 2, "b"),
		txn(3, 4, "a", "b"),
	}
	e, err := NewEnumerator(dictionary, transactions, 2)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	reference := buildReference(dictionary, transactions)
	compareExhaustive(t, got, reference.exhaustive(2), dictionary)
	compareOrdered(t, got, mustReferenceOrder(t, reference, 2))

	var sawA, sawB bool
	for _, item := range got {
		switch maskOf(item.Indices) {
		case 0b001:
			sawA = true
			if item.Support != 6 {
				t.Fatalf("support({a}) = %d, want 6", item.Support)
			}
		case 0b010:
			sawB = true
			if item.Support != 6 {
				t.Fatalf("support({b}) = %d, want 6", item.Support)
			}
		}
	}
	if !sawA || !sawB {
		t.Fatal("same-support sets with different coverage were not both delivered")
	}
}

func mustReferenceOrder(t *testing.T, reference refData, minimum uint64) []refResult {
	t.Helper()
	ordered, _ := reference.ordered(minimum)
	return ordered
}

func TestEmptyTransactionsAndEmptySet(t *testing.T) {
	t.Run("only empty transaction", func(t *testing.T) {
		dictionary := []string{"a", "b"}
		e, err := NewEnumerator(dictionary, []Transaction{txn(1, 7)}, 1)
		if err != nil {
			t.Fatal(err)
		}
		got := collect(t, e)
		if len(got) != 1 {
			t.Fatalf("got %d results, want 1: %#v", len(got), got)
		}
		assertItemset(t, got[0], 0, 7, dictionary)
		if got[0].Items == nil || got[0].Indices == nil {
			t.Fatal("empty result should have non-nil empty slices")
		}
	})

	t.Run("empty plus populated transactions", func(t *testing.T) {
		dictionary := []string{"a", "b"}
		transactions := []Transaction{
			txn(1, 2),
			txn(2, 3, "a", "b"),
		}
		e, err := NewEnumerator(dictionary, transactions, 2)
		if err != nil {
			t.Fatal(err)
		}
		got := collect(t, e)
		reference := buildReference(dictionary, transactions)
		compareExhaustive(t, got, reference.exhaustive(2), dictionary)
		compareOrdered(t, got, mustReferenceOrder(t, reference, 2))
	})
}

func TestMinimumAboveTotalWeight(t *testing.T) {
	dictionary := []string{"a", "b"}
	e, err := NewEnumerator(dictionary, []Transaction{txn(7, 2, "a")}, 3)
	if err != nil {
		t.Fatal(err)
	}
	if got := collect(t, e); len(got) != 0 {
		t.Fatalf("got %d results, want none", len(got))
	}
	if e.ExtensionAttempts() >= (uint64(1) << uint(len(dictionary))) {
		t.Fatalf("enumerated too many candidates: %d", e.ExtensionAttempts())
	}
}

func TestNeverSeenItem(t *testing.T) {
	dictionary := []string{"a", "b", "ghost"}
	transactions := []Transaction{txn(11, 9, "a", "b")}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	reference := buildReference(dictionary, transactions)
	compareExhaustive(t, got, reference.exhaustive(1), dictionary)
	for _, item := range got {
		if maskOf(item.Indices)&0b100 != 0 {
			t.Fatalf("never-seen item was reported in %#v", item)
		}
	}
}

func TestAllTransactionsShareAnItem(t *testing.T) {
	dictionary := []string{"common", "a", "b", "c"}
	transactions := []Transaction{
		txn(1, 3, "common", "a", "b"),
		txn(2, 2, "common", "b", "c"),
		txn(3, 4, "common", "a", "c"),
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	reference := buildReference(dictionary, transactions)
	compareExhaustive(t, got, reference.exhaustive(1), dictionary)
	compareOrdered(t, got, mustReferenceOrder(t, reference, 1))
	if len(got) == 0 || maskOf(got[0].Indices)&0b0001 == 0 {
		t.Fatalf("root closure did not contain the common item: %#v", got)
	}
	for _, item := range got {
		if maskOf(item.Indices)&0b0001 == 0 {
			t.Fatalf("result omits the common item: %#v", item)
		}
	}
}

func TestPauseAtMultiItemClosureThenCancel(t *testing.T) {
	dictionary := []string{"a", "b", "c"}
	transactions := []Transaction{
		txn(1, 3, "a", "b", "c"),
		txn(2, 2, "a", "b", "c"),
		txn(3, 1, "a"),
	}
	e, err := NewEnumerator(dictionary, transactions, 5)
	if err != nil {
		t.Fatal(err)
	}

	first, ok := e.Next()
	if !ok {
		t.Fatal("missing root result")
	}
	assertItemset(t, first, 0b001, 6, dictionary)
	if e.StackDepth() != 1 {
		t.Fatalf("stack depth after root = %d, want 1", e.StackDepth())
	}

	// This is the pause point: no Next call between these two reads.
	e.Pause()
	stats := e.Stats()
	if stats.StackDepth != 1 || stats.ExtensionAttempts != 0 {
		t.Fatalf("unexpected stats while paused: %#v", stats)
	}

	second, ok := e.Next()
	if !ok {
		t.Fatal("missing closure-heavy child")
	}
	assertItemset(t, second, 0b111, 5, dictionary)
	if e.StackDepth() != 2 {
		t.Fatalf("stack depth at multi-item closure = %d, want 2", e.StackDepth())
	}
	if e.ExtensionAttempts() != 1 || e.CoverIntersections() != 1 {
		t.Fatalf("unexpected counters at child: %#v", e.Stats())
	}

	e.Cancel()
	if !e.Cancelled() || !e.Exhausted() {
		t.Fatal("cancel did not enter terminal state")
	}
	if e.StackDepth() != 0 {
		t.Fatalf("stack depth after cancel = %d", e.StackDepth())
	}
	afterCancel := e.Stats()
	if afterCancel.ExtensionAttempts != 1 || afterCancel.CoverIntersections != 1 {
		t.Fatalf("cancel lost counters: %#v", afterCancel)
	}
	if e.itemBits != nil || e.weights != nil || e.allTransactions != nil {
		t.Fatal("cancel did not release bitmaps and transaction data")
	}
	if _, ok := e.Next(); ok {
		t.Fatal("Next succeeded after cancel")
	}
	if got := e.Prefix(10); len(got) != 0 {
		t.Fatalf("Prefix after cancel returned %d results", len(got))
	}
}

func TestPrefixOnlyAdvancesOneResult(t *testing.T) {
	dictionary := make([]string, MaxItems)
	for i := range dictionary {
		dictionary[i] = fmt.Sprintf("item-%02d", i)
	}
	// The root closure is the singleton item-17, so more than 2^47 candidate
	// extensions remain possible. Prefix(1) must not evaluate them.
	var lower, upper []string
	for i := 0; i < MaxItems; i++ {
		switch {
		case i < 17:
			lower = append(lower, dictionary[i])
		case i > 17:
			upper = append(upper, dictionary[i])
		}
	}
	transactions := []Transaction{
		{ID: 1, Weight: 1, Items: append([]string{dictionary[17]}, lower...)},
		{ID: 2, Weight: 1, Items: append([]string{dictionary[17]}, upper...)},
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	prefix := e.Prefix(1)
	if len(prefix) != 1 || maskOf(prefix[0].Indices) != (uint64(1)<<17) {
		t.Fatalf("unexpected first result: %#v", prefix)
	}
	if e.ExtensionAttempts() != 0 || e.CoverIntersections() != 0 {
		t.Fatalf("Prefix(1) advanced beyond the first result: %#v", e.Stats())
	}
	if e.StackDepth() != 1 {
		t.Fatalf("stack depth after Prefix(1) = %d, want 1", e.StackDepth())
	}
}

func TestLargeIdenticalClosure(t *testing.T) {
	dictionary := make([]string, MaxItems)
	for i := range dictionary {
		dictionary[i] = fmt.Sprintf("item-%02d", i)
	}
	allItems := append([]string(nil), dictionary...)
	transactions := []Transaction{
		{ID: 1, Weight: 2, Items: allItems},
		{ID: 2, Weight: 3, Items: allItems},
		{ID: 3, Weight: 5, Items: allItems},
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	if len(got) != 1 {
		t.Fatalf("got %d results, want exactly one", len(got))
	}
	assertItemset(t, got[0], (uint64(1)<<MaxItems)-1, 10, dictionary)
	if e.ExtensionAttempts() != 0 || e.CoverIntersections() != 0 {
		t.Fatalf("large closure caused extension work: %#v", e.Stats())
	}
}

func TestPrefixConsumesFromCurrentPosition(t *testing.T) {
	dictionary := []string{"a", "b", "c"}
	transactions := []Transaction{
		txn(1, 3, "a", "b", "c"),
		txn(2, 2, "a", "b", "c"),
		txn(3, 1, "a"),
	}
	e, err := NewEnumerator(dictionary, transactions, 5)
	if err != nil {
		t.Fatal(err)
	}
	prefix := e.Prefix(1)
	if len(prefix) != 1 || maskOf(prefix[0].Indices) != 0b001 {
		t.Fatalf("first prefix = %#v", prefix)
	}
	rest := e.Prefix(10)
	if len(rest) != 1 || maskOf(rest[0].Indices) != 0b111 {
		t.Fatalf("second prefix = %#v", rest)
	}
	if more := e.Prefix(1); len(more) != 0 {
		t.Fatalf("prefix after exhaustion = %#v", more)
	}
	if negative, err := e.PrefixWithError(-1); err == nil || negative != nil {
		t.Fatalf("negative prefix = %#v, %v", negative, err)
	}
}

func TestEmptyInputHasNoResults(t *testing.T) {
	e, err := NewEnumerator([]string{"a", "b"}, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := collect(t, e); len(got) != 0 {
		t.Fatalf("got %#v, want no results", got)
	}

	empty, err := NewEnumerator(nil, nil, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got := collect(t, empty); len(got) != 0 {
		t.Fatalf("got %#v, want no results", got)
	}
}

func TestTransactionItemsAreDeduplicated(t *testing.T) {
	dictionary := []string{"a", "b"}
	transactions := []Transaction{
		{ID: 1, Weight: 4, Items: []string{"a", "a", "b", "a"}},
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	if len(got) != 1 {
		t.Fatalf("got %d results: %#v", len(got), got)
	}
	assertItemset(t, got[0], 0b11, 4, dictionary)
}

func TestInputIsBoundImmutably(t *testing.T) {
	dictionary := []string{"a", "b"}
	transactions := []Transaction{
		{ID: 1, Weight: 5, Items: []string{"a", "b"}},
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	dictionary[0] = "changed"
	dictionary[1] = "also-changed"
	transactions[0].ID = 99
	transactions[0].Weight = 1
	transactions[0].Items[0] = "changed"
	transactions[0].Items[1] = "also-changed"

	got := collect(t, e)
	if len(got) != 1 {
		t.Fatalf("got %d results", len(got))
	}
	assertItemset(t, got[0], 0b11, 5, []string{"a", "b"})
}

func TestValidationErrors(t *testing.T) {
	fortyNine := make([]string, 49)
	for i := range fortyNine {
		fortyNine[i] = fmt.Sprintf("i%d", i)
	}

	tests := []struct {
		name       string
		dictionary []string
		txns       []Transaction
		minSupport uint64
		want       error
	}{
		{
			name:       "too many dictionary items",
			dictionary: fortyNine,
			minSupport: 1,
			want:       ErrDictionaryTooLarge,
		},
		{
			name:       "duplicate dictionary item",
			dictionary: []string{"a", "a"},
			minSupport: 1,
			want:       ErrDuplicateItem,
		},
		{
			name:       "unknown item",
			dictionary: []string{"a"},
			txns:       []Transaction{txn(1, 1, "missing")},
			minSupport: 1,
			want:       ErrUnknownItem,
		},
		{
			name:       "duplicate transaction ID",
			dictionary: []string{"a"},
			txns:       []Transaction{txn(1, 1, "a"), txn(1, 2, "a")},
			minSupport: 1,
			want:       ErrDuplicateTransaction,
		},
		{
			name:       "zero weight",
			dictionary: []string{"a"},
			txns:       []Transaction{txn(1, 0, "a")},
			minSupport: 1,
			want:       ErrZeroWeight,
		},
		{
			name:       "weight overflow",
			dictionary: []string{"a"},
			txns:       []Transaction{txn(1, math.MaxUint64, "a"), txn(2, 1, "a")},
			minSupport: 1,
			want:       ErrWeightOverflow,
		},
		{
			name:       "zero minimum support",
			dictionary: []string{"a"},
			minSupport: 0,
			want:       ErrInvalidMinimumSupport,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			enumerator, err := NewEnumerator(test.dictionary, test.txns, test.minSupport)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !errors.Is(err, test.want) {
				t.Fatalf("error = %v, want errors.Is(%v)", err, test.want)
			}
			if enumerator != nil {
				t.Fatal("enumerator should be nil on validation failure")
			}
		})
	}
}

func TestDictionaryOrderControlsIndicesAndExtensions(t *testing.T) {
	dictionary := []string{"z", "a", "m"}
	transactions := []Transaction{
		txn(1, 1, "a", "m", "z"),
		txn(2, 1, "a", "m"),
	}
	e, err := NewEnumerator(dictionary, transactions, 1)
	if err != nil {
		t.Fatal(err)
	}
	got := collect(t, e)
	reference := buildReference(dictionary, transactions)
	compareExhaustive(t, got, reference.exhaustive(1), dictionary)
	compareOrdered(t, got, mustReferenceOrder(t, reference, 1))
	for _, item := range got {
		for i, index := range item.Indices {
			if item.Items[i] != dictionary[index] {
				t.Fatalf("item %q does not match dictionary index %d (%q)", item.Items[i], index, dictionary[index])
			}
		}
	}
}

func TestErrorsHaveUsefulText(t *testing.T) {
	_, err := NewEnumerator([]string{"x"}, []Transaction{txn(42, 1, "y")}, 1)
	if err == nil || !strings.Contains(err.Error(), "42") || !strings.Contains(err.Error(), "y") {
		t.Fatalf("unexpected error text: %v", err)
	}
}
