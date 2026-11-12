package dataeng

import (
	"errors"
	"fmt"
	"math/bits"
	"sort"
)

// MaxItems is the largest supported dictionary size.
const MaxItems = 48

var (
	ErrDictionaryTooLarge    = errors.New("dictionary contains more than 48 items")
	ErrDuplicateItem         = errors.New("dictionary contains a duplicate item")
	ErrDuplicateTransaction  = errors.New("duplicate transaction ID")
	ErrZeroWeight            = errors.New("transaction weight must be positive")
	ErrWeightOverflow        = errors.New("total transaction weight overflows uint64")
	ErrUnknownItem           = errors.New("transaction contains an item outside the dictionary")
	ErrInvalidMinimumSupport = errors.New("minimum support must be positive")

	// Common spelling variants are aliases with identical identity.
	ErrDuplicateDictionaryItem = ErrDuplicateItem
	ErrDuplicateTransactionID  = ErrDuplicateTransaction
	ErrTotalWeightOverflow     = ErrWeightOverflow
	ErrNonPositiveMinSupport   = ErrInvalidMinimumSupport
)

// Transaction is one weighted transaction. Items are treated as a set, so
// repetitions inside Items have no effect.
type Transaction struct {
	ID     uint64
	Weight uint64
	Items  []string
}

// Itemset is one closed frequent set. Indices refers to the caller's dictionary
// order, and Items is the corresponding list of strings. Both are sorted by
// increasing dictionary index.
type Itemset struct {
	Items   []string
	Indices []int
	Support uint64
}

// ClosedSet, Set, ClosedItemset, and FrequentSet are aliases kept for hosts
// that prefer those names.
type ClosedSet = Itemset
type Set = Itemset
type ClosedItemset = Itemset
type FrequentSet = Itemset

// Stats is a snapshot of the enumerator's real work counters. StackDepth is
// zero before enumeration starts, after exhaustion, and after cancellation.
type Stats struct {
	ExtensionAttempts     uint64
	CoverIntersections    uint64
	CoverageIntersections uint64
	StackDepth            int
}

type bitset []uint64

type transactionData struct {
	id     uint64
	weight uint64
	mask   uint64
}

type frame struct {
	set     uint64
	cover   bitset
	support uint64
	next    int
	emitted bool
	scratch bitset
}

// Enumerator lazily enumerates the closed frequent itemsets of an immutable
// weighted transaction database.
//
// Enumeration is a depth-first traversal. Calling Next again after a pause
// resumes from the existing stack. Cancel makes the enumerator permanently
// terminal and releases its transaction bitmaps; a new enumeration requires a
// new Enumerator.
type Enumerator struct {
	dictionary      []string
	weights         []uint64
	itemBits        []bitset
	allTransactions bitset
	fullItems       uint64
	minSupport      uint64
	words           int
	itemCount       int

	frames    []frame
	started   bool
	done      bool
	cancelled bool

	extensionAttempts  uint64
	coverIntersections uint64
}

// NewEnumerator validates the input, binds a private immutable copy of it, and
// returns a lazy enumerator. The input slices and transaction item slices are
// not retained.
func NewEnumerator(dictionary []string, transactions []Transaction, minSupport uint64) (*Enumerator, error) {
	if minSupport == 0 {
		return nil, ErrInvalidMinimumSupport
	}
	if len(dictionary) > MaxItems {
		return nil, fmt.Errorf("%w: got %d", ErrDictionaryTooLarge, len(dictionary))
	}

	itemIndex := make(map[string]int, len(dictionary))
	for i, item := range dictionary {
		if _, exists := itemIndex[item]; exists {
			return nil, fmt.Errorf("%w: %q", ErrDuplicateItem, item)
		}
		itemIndex[item] = i
	}

	items := make([]transactionData, 0, len(transactions))
	seenIDs := make(map[uint64]struct{}, len(transactions))
	var totalWeight uint64
	for _, transaction := range transactions {
		if transaction.Weight == 0 {
			return nil, fmt.Errorf("%w: transaction %d", ErrZeroWeight, transaction.ID)
		}
		if _, exists := seenIDs[transaction.ID]; exists {
			return nil, fmt.Errorf("%w: %d", ErrDuplicateTransaction, transaction.ID)
		}
		seenIDs[transaction.ID] = struct{}{}
		if ^uint64(0)-totalWeight < transaction.Weight {
			return nil, ErrWeightOverflow
		}
		totalWeight += transaction.Weight

		var mask uint64
		for _, item := range transaction.Items {
			index, exists := itemIndex[item]
			if !exists {
				return nil, fmt.Errorf("%w: %q in transaction %d", ErrUnknownItem, item, transaction.ID)
			}
			mask |= uint64(1) << uint(index)
		}
		items = append(items, transactionData{
			id:     transaction.ID,
			weight: transaction.Weight,
			mask:   mask,
		})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].id < items[j].id })

	itemCount := len(dictionary)
	transactionCount := len(items)
	words := (transactionCount + 63) / 64

	e := &Enumerator{
		dictionary:      append([]string(nil), dictionary...),
		weights:         make([]uint64, transactionCount),
		itemBits:        make([]bitset, itemCount),
		fullItems:       (uint64(1) << uint(itemCount)) - 1,
		minSupport:      minSupport,
		words:           words,
		itemCount:       itemCount,
		allTransactions: make(bitset, words),
	}
	for i := range e.itemBits {
		e.itemBits[i] = make(bitset, words)
	}
	for i := range e.weights {
		e.weights[i] = items[i].weight
	}

	for index := 0; index < transactionCount; index++ {
		transaction := items[index]
		for mask := transaction.mask; mask != 0; mask &= mask - 1 {
			item := bits.TrailingZeros64(mask)
			e.itemBits[item][index/64] |= uint64(1) << uint(index%64)
		}
	}

	for i := range e.allTransactions {
		e.allTransactions[i] = ^uint64(0)
	}
	if transactionCount%64 != 0 {
		e.allTransactions[len(e.allTransactions)-1] =
			(uint64(1) << uint(transactionCount%64)) - 1
	}

	return e, nil
}

// New is an alias for NewEnumerator.
func New(dictionary []string, transactions []Transaction, minSupport uint64) (*Enumerator, error) {
	return NewEnumerator(dictionary, transactions, minSupport)
}

// NewClosedEnumerator is an alias for NewEnumerator.
func NewClosedEnumerator(dictionary []string, transactions []Transaction, minSupport uint64) (*Enumerator, error) {
	return NewEnumerator(dictionary, transactions, minSupport)
}

// Next returns the next closed frequent set in the fixed depth-first order. It
// returns false when the enumeration is exhausted or has been cancelled.
func (e *Enumerator) Next() (Itemset, bool) {
	if e == nil || e.done || e.cancelled {
		return Itemset{}, false
	}
	if !e.started {
		e.start()
	}

	for len(e.frames) > 0 {
		top := &e.frames[len(e.frames)-1]

		if !top.emitted {
			top.emitted = true
			if top.support >= e.minSupport {
				return e.makeItemset(top.set, top.support), true
			}
			// Only the root can be infrequent here. Continue with the
			// prescribed extension scan; every child will fail support.
		}

		childEntered := false
		for top.next < e.itemCount {
			extension := top.next
			top.next++
			if top.set&(uint64(1)<<uint(extension)) != 0 {
				continue
			}

			if top.scratch == nil {
				top.scratch = make(bitset, e.words)
			}
			e.extensionAttempts++
			bitsetAnd(top.scratch, top.cover, e.itemBits[extension])
			e.coverIntersections++

			support := e.supportOf(top.scratch)
			if support < e.minSupport {
				continue
			}

			closure := e.closureOf(top.scratch)
			if !e.isCanonicalExtension(top.set, closure, extension) {
				continue
			}

			cover := append(bitset(nil), top.scratch...)
			e.frames = append(e.frames, frame{
				set:     closure,
				cover:   cover,
				support: support,
				next:    extension + 1,
				scratch: make(bitset, e.words),
			})
			childEntered = true
			break
		}
		if childEntered {
			continue
		}
		e.frames = e.popFrame()
	}

	e.done = true
	return Itemset{}, false
}

// Prefix consumes at most limit results from the current position. It is a
// convenience for hosts that want a bounded batch and does not reorder or
// materialize the underlying enumeration.
func (e *Enumerator) Prefix(limit int) []Itemset {
	if limit <= 0 {
		return []Itemset{}
	}
	capacity := limit
	if capacity > 1024 {
		capacity = 1024
	}
	result := make([]Itemset, 0, capacity)
	for len(result) < limit {
		item, ok := e.Next()
		if !ok {
			break
		}
		result = append(result, item)
	}
	return result
}

// PrefixWithError is Prefix with an error slot for callers that prefer an
// explicit error return. Construction errors are not deferred, so this is
// always nil for a successfully constructed enumerator.
func (e *Enumerator) PrefixWithError(limit int) ([]Itemset, error) {
	if limit < 0 {
		return nil, errors.New("prefix limit must not be negative")
	}
	return e.Prefix(limit), nil
}

// Take is an alias for Prefix.
func (e *Enumerator) Take(limit int) []Itemset {
	return e.Prefix(limit)
}

// Pause exists to make the pull-based contract explicit. Enumeration is
// already paused whenever Next is not being called; this method changes no
// state, and the next Next resumes from the same stack.
func (e *Enumerator) Pause() {}

// Resume is an alias for the natural continuation performed by Next. It
// changes no state; call Next to advance the existing depth-first stack.
func (e *Enumerator) Resume() {}

// Cancel releases the transaction bitmaps and makes the enumerator permanently
// terminal. Counters remain readable. The enumerator cannot be restarted;
// construct a new one to enumerate again.
func (e *Enumerator) Cancel() {
	if e == nil || e.cancelled {
		return
	}
	e.cancelled = true
	e.done = true
	e.frames = nil
	e.itemBits = nil
	e.weights = nil
	e.allTransactions = nil
	e.dictionary = nil
}

// Cancelled reports whether Cancel has been called.
func (e *Enumerator) Cancelled() bool {
	return e != nil && e.cancelled
}

// IsCancelled is an alias for Cancelled.
func (e *Enumerator) IsCancelled() bool {
	return e.Cancelled()
}

// Exhausted reports whether enumeration has delivered its last result.
func (e *Enumerator) Exhausted() bool {
	return e != nil && e.done
}

// IsExhausted is an alias for Exhausted.
func (e *Enumerator) IsExhausted() bool {
	return e.Exhausted()
}

// Stats returns a read-only snapshot of the actual work counters.
func (e *Enumerator) Stats() Stats {
	if e == nil {
		return Stats{}
	}
	return Stats{
		ExtensionAttempts:     e.extensionAttempts,
		CoverIntersections:    e.coverIntersections,
		CoverageIntersections: e.coverIntersections,
		StackDepth:            len(e.frames),
	}
}

// ExtensionAttempts returns the number of extension candidates actually
// processed.
func (e *Enumerator) ExtensionAttempts() uint64 {
	if e == nil {
		return 0
	}
	return e.extensionAttempts
}

// CoverIntersections returns the number of coverage-bitmap intersections
// actually performed while extending a node.
func (e *Enumerator) CoverIntersections() uint64 {
	if e == nil {
		return 0
	}
	return e.coverIntersections
}

// CoverageIntersections is an alias for CoverIntersections.
func (e *Enumerator) CoverageIntersections() uint64 {
	return e.CoverIntersections()
}

// StackDepth returns the current number of active depth-first frames.
func (e *Enumerator) StackDepth() int {
	if e == nil {
		return 0
	}
	return len(e.frames)
}

func (e *Enumerator) start() {
	e.started = true
	rootSet := e.closureOf(e.allTransactions)
	rootSupport := e.supportOf(e.allTransactions)
	e.frames = append(e.frames, frame{
		set:     rootSet,
		cover:   e.allTransactions,
		support: rootSupport,
		next:    0,
		scratch: make(bitset, e.words),
	})
}

func (e *Enumerator) popFrame() []frame {
	if len(e.frames) == 0 {
		return nil
	}
	return e.frames[:len(e.frames)-1]
}

func (e *Enumerator) closureOf(cover bitset) uint64 {
	if bitsetEmpty(cover) {
		return e.fullItems
	}
	var mask uint64
	for item := 0; item < e.itemCount; item++ {
		if bitsetSubset(cover, e.itemBits[item]) {
			mask |= uint64(1) << uint(item)
		}
	}
	return mask
}

func (e *Enumerator) supportOf(cover bitset) uint64 {
	var support uint64
	for wordIndex, word := range cover {
		for word != 0 {
			bit := bits.TrailingZeros64(word)
			index := wordIndex*64 + bit
			support += e.weights[index]
			word &= word - 1
		}
	}
	return support
}

func (e *Enumerator) isCanonicalExtension(current, closure uint64, extension int) bool {
	for item := 0; item < extension; item++ {
		itemBit := uint64(1) << uint(item)
		if closure&itemBit != 0 && current&itemBit == 0 {
			return false
		}
	}
	return true
}

func (e *Enumerator) makeItemset(mask uint64, support uint64) Itemset {
	count := bits.OnesCount64(mask)
	items := make([]string, 0, count)
	indices := make([]int, 0, count)
	for item := 0; item < e.itemCount; item++ {
		if mask&(uint64(1)<<uint(item)) != 0 {
			items = append(items, e.dictionary[item])
			indices = append(indices, item)
		}
	}
	return Itemset{Items: items, Indices: indices, Support: support}
}

func bitsetEmpty(set bitset) bool {
	for _, word := range set {
		if word != 0 {
			return false
		}
	}
	return true
}

func bitsetSubset(subset, superset bitset) bool {
	for i := range subset {
		if subset[i]&^superset[i] != 0 {
			return false
		}
	}
	return true
}

func bitsetAnd(destination, left, right bitset) {
	for i := range destination {
		destination[i] = left[i] & right[i]
	}
}
