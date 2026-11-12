package dataeng

import (
	"container/heap"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
)

// Hit is one exact search result.
type Hit struct {
	DocumentID uint64
	Score      *big.Rat
}

// SkipReason identifies the safe-pruning rule used for a skipped interval.
type SkipReason string

const (
	SkipReasonBelowThreshold           SkipReason = "bound-below-kth-score"
	SkipReasonEqualThresholdNoBetterID SkipReason = "bound-equal-kth-score-no-better-id"
)

// TermSkipBound records the contribution bound a query term used over a
// skipped interval.  BlockIndex is -1 when the term has no block in the
// interval (unknown term, exhausted postings, or an inter-block gap).
type TermSkipBound struct {
	Term                   string
	Weight                 *big.Rat
	ContributionUpperBound *big.Rat
	ScoreUpperBound        *big.Rat
	BlockIndex             int
	BlockMinDocumentID     uint64
	BlockMaxDocumentID     uint64
}

// SkipRecord is a machine-checkable pruning receipt.  MinDocumentID and
// MaxDocumentID are a closed ID interval.  The term bounds, total bound, and
// the kth score/ID are exactly the values that justified skipping it.
type SkipRecord struct {
	MinDocumentID   uint64
	MaxDocumentID   uint64
	TermBounds      []TermSkipBound
	ScoreUpperBound *big.Rat
	KthScore        *big.Rat
	KthDocumentID   uint64
	Reason          SkipReason
}

// SearchStats exposes observable work performed by one search.
type SearchStats struct {
	BlockReads       int
	DocumentsScored  int
	SkippedIntervals int
	SkippedDocuments int
}

// SearchResult contains the exact top-k hits and every pruning receipt.
type SearchResult struct {
	Hits  []Hit
	Skips []SkipRecord
	Stats SearchStats
}

// Searcher owns only the immutable directory, block metadata, and a block
// reader.  It never retains posting payloads between searches.
type Searcher struct {
	documents []uint64
	terms     map[string]TermMetadata
	reader    BlockReader
}

// NewSearcher validates and privately copies the metadata.  The resulting
// object holds no posting payload.
func NewSearcher(metadata *IndexMetadata, reader BlockReader) (*Searcher, error) {
	if reader == nil {
		return nil, errors.New("nil block reader")
	}
	cloned, err := cloneMetadata(metadata)
	if err != nil {
		return nil, err
	}
	return &Searcher{
		documents: cloned.Documents,
		terms:     cloned.Terms,
		reader:    reader,
	}, nil
}

// Query is an alias for Search.
func (s *Searcher) Query(weights map[string]*big.Rat, excluded map[uint64]struct{}, k int) (*SearchResult, error) {
	return s.Search(weights, excluded, k)
}

// Search returns at most k non-excluded directory documents, ordered by exact
// score descending and document ID ascending.  All directory documents are
// candidates, including zero-score documents that contain no query term.
func (s *Searcher) Search(weights map[string]*big.Rat, excluded map[uint64]struct{}, k int) (*SearchResult, error) {
	if s == nil {
		return nil, errors.New("nil searcher")
	}
	if k < 0 {
		return nil, fmt.Errorf("k must be non-negative, got %d", k)
	}
	if k == 0 || len(s.documents) == 0 {
		return &SearchResult{}, nil
	}

	queryWeights := make(map[string]*big.Rat, len(weights))
	termNames := make([]string, 0, len(weights))
	for term, weight := range weights {
		if err := validateNonNegativeRat(fmt.Sprintf("query weight for term %q", term), weight); err != nil {
			return nil, err
		}
		queryWeights[term] = cloneRat(weight)
		termNames = append(termNames, term)
	}
	sort.Strings(termNames)

	excludedCopy := make(map[uint64]struct{}, len(excluded))
	for id := range excluded {
		excludedCopy[id] = struct{}{}
	}

	states := make([]*queryTermState, 0, len(termNames))
	for _, term := range termNames {
		termMeta := s.terms[term]
		states = append(states, &queryTermState{
			term:   term,
			weight: queryWeights[term],
			blocks: termMeta.Blocks,
			index:  0,
		})
	}

	result := &SearchResult{}
	best := &candidateHeap{limit: k}
	heap.Init(best)

	readBlocks := make(map[blockKey]struct{})
	nextEligible := s.eligibleIndexAtLeast(0, excludedCopy)
	if nextEligible >= len(s.documents) {
		return result, nil
	}

	directoryMax := s.documents[len(s.documents)-1]
	current := s.documents[nextEligible]

	for {
		eligibleIndex := s.eligibleIndexAtLeast(current, excludedCopy)
		if eligibleIndex >= len(s.documents) {
			break
		}
		current = s.documents[eligibleIndex]

		for _, state := range states {
			state.locate(current)
		}

		windowEnd := directoryMax
		for _, state := range states {
			if state.index >= len(state.blocks) {
				continue
			}
			block := state.blocks[state.index]
			eventEnd := block.MaxDocumentID
			if current < block.MinDocumentID {
				eventEnd = block.MinDocumentID - 1
			}
			if eventEnd < windowEnd {
				windowEnd = eventEnd
			}
		}
		if windowEnd > directoryMax {
			windowEnd = directoryMax
		}

		lastEligible := s.lastEligibleIndexAtMost(windowEnd, excludedCopy)
		if lastEligible < eligibleIndex {
			if windowEnd == math.MaxUint64 {
				break
			}
			current = windowEnd + 1
			continue
		}

		upperBound, termBounds, err := termBoundsForWindow(states, current, windowEnd)
		if err != nil {
			return nil, err
		}

		if best.Len() == k {
			kthScore, kthID := best.Worst()
			reason, skip := safeToSkip(upperBound, current, kthScore, kthID)
			if skip {
				skippedDocs := lastEligible - eligibleIndex + 1
				result.Skips = append(result.Skips, SkipRecord{
					MinDocumentID:   current,
					MaxDocumentID:   windowEnd,
					TermBounds:      termBounds,
					ScoreUpperBound: cloneRat(upperBound),
					KthScore:        cloneRat(kthScore),
					KthDocumentID:   kthID,
					Reason:          reason,
				})
				result.Stats.SkippedIntervals++
				result.Stats.SkippedDocuments += skippedDocs

				if windowEnd == math.MaxUint64 {
					break
				}
				current = windowEnd + 1
				continue
			}
		}

		scores, err := s.scoreWindow(states, current, windowEnd, excludedCopy, readBlocks, &result.Stats)
		if err != nil {
			return nil, err
		}

		for i := eligibleIndex; i <= lastEligible; i++ {
			id := s.documents[i]
			if _, skip := excludedCopy[id]; skip {
				continue
			}
			score := scores[id]
			if score == nil {
				score = zeroRat()
			} else {
				score = cloneRat(score)
			}
			bestOffer(best, Hit{DocumentID: id, Score: score})
			result.Stats.DocumentsScored++
		}

		if windowEnd == math.MaxUint64 {
			break
		}
		current = windowEnd + 1
	}

	result.Hits = best.SortedHits()
	return result, nil
}

type queryTermState struct {
	term     string
	weight   *big.Rat
	blocks   []BlockMetadata
	index    int
	loaded   []Posting
	covering bool
}

// locate makes index the first block whose MaxDocumentID is at least current.
// A loaded payload is discarded as soon as its block is left.  Thus each term
// keeps at most one block payload alive at a time.
func (state *queryTermState) locate(current uint64) {
	for state.index < len(state.blocks) && state.blocks[state.index].MaxDocumentID < current {
		state.index++
		state.loaded = nil
	}
	state.covering = false
	if state.index >= len(state.blocks) {
		return
	}
	block := state.blocks[state.index]
	state.covering = current >= block.MinDocumentID && current <= block.MaxDocumentID
}

func (state *queryTermState) load(reader BlockReader, readBlocks map[blockKey]struct{}, stats *SearchStats) error {
	if !state.covering {
		return nil
	}
	if state.weight.Sign() == 0 {
		// A zero weight cannot affect any score, so its payload is not needed.
		return nil
	}
	if state.loaded != nil {
		return nil
	}
	block := state.blocks[state.index]
	key := blockKey{term: state.term, index: block.Index}
	if _, alreadyRead := readBlocks[key]; alreadyRead {
		return fmt.Errorf("internal error: term %q block %d read twice in one search", state.term, block.Index)
	}
	postings, err := reader.ReadBlock(state.term, block.Index)
	if err != nil {
		return fmt.Errorf("read term %q block %d: %w", state.term, block.Index, err)
	}
	if err := validateBlockPayload(state.term, block, postings); err != nil {
		return err
	}
	readBlocks[key] = struct{}{}
	stats.BlockReads++
	state.loaded = postings
	return nil
}

func validateBlockPayload(term string, block BlockMetadata, postings []Posting) error {
	if len(postings) != block.PostingCount {
		return fmt.Errorf("term %q block %d: store returned %d postings, metadata says %d", term, block.Index, len(postings), block.PostingCount)
	}
	if len(postings) == 0 {
		return fmt.Errorf("term %q block %d: empty payload", term, block.Index)
	}
	maxContribution := cloneRat(postings[0].Contribution)
	for i, posting := range postings {
		if err := validateNonNegativeRat(fmt.Sprintf("read term %q block %d posting %d contribution", term, block.Index, i), posting.Contribution); err != nil {
			return err
		}
		if i > 0 && posting.DocumentID <= postings[i-1].DocumentID {
			return fmt.Errorf("term %q block %d: postings are not strictly increasing at index %d", term, block.Index, i)
		}
		if posting.DocumentID < block.MinDocumentID || posting.DocumentID > block.MaxDocumentID {
			return fmt.Errorf("term %q block %d: posting ID %d is outside metadata range [%d,%d]", term, block.Index, posting.DocumentID, block.MinDocumentID, block.MaxDocumentID)
		}
		if posting.Contribution.Cmp(maxContribution) > 0 {
			maxContribution = cloneRat(posting.Contribution)
		}
	}
	if postings[0].DocumentID != block.MinDocumentID {
		return fmt.Errorf("term %q block %d: first posting ID %d does not match minimum %d", term, block.Index, postings[0].DocumentID, block.MinDocumentID)
	}
	if postings[len(postings)-1].DocumentID != block.MaxDocumentID {
		return fmt.Errorf("term %q block %d: last posting ID %d does not match maximum %d", term, block.Index, postings[len(postings)-1].DocumentID, block.MaxDocumentID)
	}
	if maxContribution.Cmp(block.MaxContribution) != 0 {
		return fmt.Errorf("term %q block %d: stored maximum contribution %s does not match metadata %s", term, block.Index, maxContribution.RatString(), block.MaxContribution.RatString())
	}
	return nil
}

func termBoundsForWindow(states []*queryTermState, current, end uint64) (*big.Rat, []TermSkipBound, error) {
	total := zeroRat()
	bounds := make([]TermSkipBound, 0, len(states))
	for _, state := range states {
		contributionBound := zeroRat()
		blockIndex := -1
		var blockMin, blockMax uint64
		if state.index < len(state.blocks) {
			block := state.blocks[state.index]
			if current >= block.MinDocumentID && current <= block.MaxDocumentID {
				if end > block.MaxDocumentID {
					return nil, nil, fmt.Errorf("internal error: term %q block %d [%d,%d] does not cover window [%d,%d]", state.term, block.Index, block.MinDocumentID, block.MaxDocumentID, current, end)
				}
				contributionBound = cloneRat(block.MaxContribution)
				blockIndex = block.Index
				blockMin = block.MinDocumentID
				blockMax = block.MaxDocumentID
			} else if block.MinDocumentID <= end {
				return nil, nil, fmt.Errorf("internal error: term %q block %d [%d,%d] intersects uncovered window [%d,%d]", state.term, block.Index, block.MinDocumentID, block.MaxDocumentID, current, end)
			}
		}
		scoreBound := mulRat(state.weight, contributionBound)
		if scoreBound.Sign() < 0 {
			return nil, nil, fmt.Errorf("internal error: negative score bound for term %q", state.term)
		}
		bounds = append(bounds, TermSkipBound{
			Term:                   state.term,
			Weight:                 cloneRat(state.weight),
			ContributionUpperBound: cloneRat(contributionBound),
			ScoreUpperBound:        cloneRat(scoreBound),
			BlockIndex:             blockIndex,
			BlockMinDocumentID:     blockMin,
			BlockMaxDocumentID:     blockMax,
		})
		total = addRat(total, scoreBound)
	}
	return total, bounds, nil
}

func safeToSkip(upperBound *big.Rat, intervalMin uint64, kthScore *big.Rat, kthID uint64) (SkipReason, bool) {
	switch upperBound.Cmp(kthScore) {
	case -1:
		return SkipReasonBelowThreshold, true
	case 1:
		return "", false
	default:
		// Equal scores are ordered by ID.  Every possible ID in the interval
		// is at least intervalMin, so the interval is safe only when that
		// minimum cannot beat the current kth ID.
		if intervalMin >= kthID {
			return SkipReasonEqualThresholdNoBetterID, true
		}
		return "", false
	}
}

func (s *Searcher) scoreWindow(states []*queryTermState, start, end uint64, excluded map[uint64]struct{}, readBlocks map[blockKey]struct{}, stats *SearchStats) (map[uint64]*big.Rat, error) {
	scores := make(map[uint64]*big.Rat)
	for _, state := range states {
		if !state.covering {
			continue
		}
		if err := state.load(s.reader, readBlocks, stats); err != nil {
			return nil, err
		}
		if state.weight.Sign() == 0 {
			continue
		}
		postings := state.loaded
		first := sort.Search(len(postings), func(i int) bool {
			return postings[i].DocumentID >= start
		})
		for i := first; i < len(postings); i++ {
			posting := postings[i]
			if posting.DocumentID > end {
				break
			}
			if _, skip := excluded[posting.DocumentID]; skip {
				continue
			}
			weighted := mulRat(state.weight, posting.Contribution)
			if existing, ok := scores[posting.DocumentID]; ok {
				scores[posting.DocumentID] = addRat(existing, weighted)
			} else {
				scores[posting.DocumentID] = weighted
			}
		}
	}
	return scores, nil
}

func (s *Searcher) eligibleIndexAtLeast(id uint64, excluded map[uint64]struct{}) int {
	index := sort.Search(len(s.documents), func(i int) bool {
		return s.documents[i] >= id
	})
	for index < len(s.documents) {
		if _, skip := excluded[s.documents[index]]; !skip {
			break
		}
		index++
	}
	return index
}

func (s *Searcher) lastEligibleIndexAtMost(id uint64, excluded map[uint64]struct{}) int {
	index := sort.Search(len(s.documents), func(i int) bool {
		return s.documents[i] > id
	}) - 1
	for index >= 0 {
		if _, skip := excluded[s.documents[index]]; !skip {
			break
		}
		index--
	}
	return index
}

type candidateHeap struct {
	items []Hit
	limit int
}

func (h *candidateHeap) Len() int { return len(h.items) }

func (h *candidateHeap) Less(i, j int) bool {
	cmp := h.items[i].Score.Cmp(h.items[j].Score)
	if cmp != 0 {
		return cmp < 0
	}
	return h.items[i].DocumentID > h.items[j].DocumentID
}

func (h *candidateHeap) Swap(i, j int) { h.items[i], h.items[j] = h.items[j], h.items[i] }

func (h *candidateHeap) Push(x any) {
	h.items = append(h.items, x.(Hit))
}

func (h *candidateHeap) Pop() any {
	old := h.items
	n := len(old)
	item := old[n-1]
	h.items = old[:n-1]
	return item
}

func (h *candidateHeap) Worst() (*big.Rat, uint64) {
	if len(h.items) == 0 {
		return nil, 0
	}
	return h.items[0].Score, h.items[0].DocumentID
}

func (h *candidateHeap) SortedHits() []Hit {
	hits := append([]Hit(nil), h.items...)
	sort.Slice(hits, func(i, j int) bool {
		cmp := hits[i].Score.Cmp(hits[j].Score)
		if cmp != 0 {
			return cmp > 0
		}
		return hits[i].DocumentID < hits[j].DocumentID
	})
	return hits
}

func bestOffer(h *candidateHeap, candidate Hit) {
	if h.limit <= 0 {
		return
	}
	if len(h.items) < h.limit {
		heap.Push(h, candidate)
		return
	}
	worst := h.items[0]
	cmp := candidate.Score.Cmp(worst.Score)
	if cmp > 0 || (cmp == 0 && candidate.DocumentID < worst.DocumentID) {
		heap.Pop(h)
		heap.Push(h, candidate)
	}
}
