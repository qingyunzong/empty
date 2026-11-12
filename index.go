package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
	"sync"
)

// Posting is one term/document contribution.  Contributions are non-negative
// and exact.  Posting lists are strictly increasing by DocumentID.
type Posting struct {
	DocumentID   uint64
	Contribution *big.Rat
}

// BlockMetadata is the metadata retained for one block.  MaxContribution is
// computed by BuildIndex from the postings in the block; it is never copied
// from an input-supplied maximum.
type BlockMetadata struct {
	Index           int
	MinDocumentID   uint64
	MaxDocumentID   uint64
	PostingCount    int
	MaxContribution *big.Rat
}

// TermMetadata describes the blocks of one term.  Blocks are in posting order
// and are created independently for every term.
type TermMetadata struct {
	Term          string
	DocumentCount int
	Blocks        []BlockMetadata
}

// IndexMetadata contains only the immutable directory and block metadata.  It
// deliberately contains no posting payload.
type IndexMetadata struct {
	Documents []uint64
	Terms     map[string]TermMetadata
	BlockSize int
}

// BlockWriter is the write-only store injected into BuildIndex.  The postings
// slice is a complete, private copy of that block's payload.  Implementations
// may retain it, but must not expect the caller to mutate it later.
type BlockWriter interface {
	WriteBlock(term string, blockIndex int, postings []Posting) error
}

// BlockReader is the read interface injected into a Searcher.  ReadBlock must
// return a complete private copy of the requested block.  The Searcher calls
// ReadBlock at most once for any (term, blockIndex) during one search.
type BlockReader interface {
	ReadBlock(term string, blockIndex int) ([]Posting, error)
}

// BuildIndex validates the immutable directory and per-term posting lists,
// partitions each term independently into blocks of blockSize postings,
// computes each block's actual maximum contribution, and writes every block's
// complete payload to writer.
func BuildIndex(documents []uint64, terms map[string][]Posting, blockSize int, writer BlockWriter) (*IndexMetadata, error) {
	if blockSize <= 0 {
		return nil, fmt.Errorf("blockSize must be positive, got %d", blockSize)
	}
	if writer == nil {
		return nil, errors.New("nil block writer")
	}

	docs := append([]uint64(nil), documents...)
	sort.Slice(docs, func(i, j int) bool { return docs[i] < docs[j] })
	docSet := make(map[uint64]struct{}, len(docs))
	for i, id := range docs {
		if i > 0 && docs[i-1] == id {
			return nil, fmt.Errorf("duplicate document ID %d", id)
		}
		docSet[id] = struct{}{}
	}

	termNames := make([]string, 0, len(terms))
	for term := range terms {
		termNames = append(termNames, term)
	}
	sort.Strings(termNames)

	// Validate everything before writing anything, so a rejected input does
	// not leave a partially written store.
	validated := make(map[string][]Posting, len(terms))
	for _, term := range termNames {
		input := terms[term]
		copied := make([]Posting, len(input))
		for i, posting := range input {
			if err := validateNonNegativeRat(fmt.Sprintf("term %q posting %d contribution", term, i), posting.Contribution); err != nil {
				return nil, err
			}
			if _, ok := docSet[posting.DocumentID]; !ok {
				return nil, fmt.Errorf("term %q posting %d: document ID %d is outside the directory", term, i, posting.DocumentID)
			}
			if i > 0 && posting.DocumentID <= input[i-1].DocumentID {
				return nil, fmt.Errorf("term %q postings are not strictly increasing at index %d", term, i)
			}
			copied[i] = Posting{
				DocumentID:   posting.DocumentID,
				Contribution: cloneRat(posting.Contribution),
			}
		}
		validated[term] = copied
	}

	metadata := &IndexMetadata{
		Documents: docs,
		Terms:     make(map[string]TermMetadata, len(validated)),
		BlockSize: blockSize,
	}

	for _, term := range termNames {
		postings := validated[term]
		termMeta := TermMetadata{
			Term:          term,
			DocumentCount: len(postings),
		}
		for start := 0; start < len(postings); start += blockSize {
			end := start + blockSize
			if end > len(postings) {
				end = len(postings)
			}
			payload := copyPostings(postings[start:end])
			block := BlockMetadata{
				Index:           len(termMeta.Blocks),
				MinDocumentID:   payload[0].DocumentID,
				MaxDocumentID:   payload[0].DocumentID,
				PostingCount:    len(payload),
				MaxContribution: cloneRat(payload[0].Contribution),
			}
			for _, posting := range payload[1:] {
				if posting.DocumentID < block.MinDocumentID {
					block.MinDocumentID = posting.DocumentID
				}
				if posting.DocumentID > block.MaxDocumentID {
					block.MaxDocumentID = posting.DocumentID
				}
				if posting.Contribution.Cmp(block.MaxContribution) > 0 {
					block.MaxContribution = cloneRat(posting.Contribution)
				}
			}
			termMeta.Blocks = append(termMeta.Blocks, block)
			if err := writer.WriteBlock(term, block.Index, payload); err != nil {
				return nil, fmt.Errorf("write term %q block %d: %w", term, block.Index, err)
			}
		}
		metadata.Terms[term] = termMeta
	}

	return metadata, nil
}

func copyPostings(src []Posting) []Posting {
	dst := make([]Posting, len(src))
	for i, posting := range src {
		dst[i] = Posting{
			DocumentID:   posting.DocumentID,
			Contribution: cloneRat(posting.Contribution),
		}
	}
	return dst
}

func cloneMetadata(meta *IndexMetadata) (*IndexMetadata, error) {
	if meta == nil {
		return nil, errors.New("nil index metadata")
	}
	if meta.BlockSize <= 0 {
		return nil, fmt.Errorf("invalid block size %d", meta.BlockSize)
	}
	docs := append([]uint64(nil), meta.Documents...)
	for i, id := range docs {
		if i > 0 && docs[i-1] >= id {
			return nil, fmt.Errorf("directory is not strictly increasing at index %d", i)
		}
	}
	cloned := &IndexMetadata{
		Documents: docs,
		Terms:     make(map[string]TermMetadata, len(meta.Terms)),
		BlockSize: meta.BlockSize,
	}
	for term, termMeta := range meta.Terms {
		if termMeta.Term != term {
			return nil, fmt.Errorf("term metadata key %q has term %q", term, termMeta.Term)
		}
		if termMeta.DocumentCount < 0 {
			return nil, fmt.Errorf("term %q has negative document count", term)
		}
		out := TermMetadata{
			Term:          term,
			DocumentCount: termMeta.DocumentCount,
			Blocks:        make([]BlockMetadata, len(termMeta.Blocks)),
		}
		lastMax := uint64(0)
		haveLast := false
		total := 0
		for i, block := range termMeta.Blocks {
			if block.Index != i {
				return nil, fmt.Errorf("term %q block at position %d has index %d", term, i, block.Index)
			}
			if block.PostingCount <= 0 {
				return nil, fmt.Errorf("term %q block %d has non-positive count", term, i)
			}
			if err := validateNonNegativeRat(fmt.Sprintf("term %q block %d maximum contribution", term, i), block.MaxContribution); err != nil {
				return nil, err
			}
			if block.MinDocumentID > block.MaxDocumentID {
				return nil, fmt.Errorf("term %q block %d has inverted document range", term, i)
			}
			if haveLast && block.MinDocumentID <= lastMax {
				return nil, fmt.Errorf("term %q block %d overlaps or precedes the previous block", term, i)
			}
			lastMax = block.MaxDocumentID
			haveLast = true
			total += block.PostingCount
			out.Blocks[i] = BlockMetadata{
				Index:           block.Index,
				MinDocumentID:   block.MinDocumentID,
				MaxDocumentID:   block.MaxDocumentID,
				PostingCount:    block.PostingCount,
				MaxContribution: cloneRat(block.MaxContribution),
			}
		}
		if total != termMeta.DocumentCount {
			return nil, fmt.Errorf("term %q block counts total %d but metadata says %d", term, total, termMeta.DocumentCount)
		}
		cloned.Terms[term] = out
	}
	return cloned, nil
}

// MemoryStore is a reference BlockWriter/BlockReader.  It stores complete
// payloads and returns a deep copy on every read.  ReadCount makes the
// single-read property observable in examples and tests.
type MemoryStore struct {
	mu     sync.RWMutex
	blocks map[blockKey][]Posting
	reads  map[blockKey]int
}

type blockKey struct {
	term  string
	index int
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		blocks: make(map[blockKey][]Posting),
		reads:  make(map[blockKey]int),
	}
}

func (s *MemoryStore) WriteBlock(term string, blockIndex int, postings []Posting) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := blockKey{term: term, index: blockIndex}
	if _, exists := s.blocks[key]; exists {
		return fmt.Errorf("term %q block %d already written", term, blockIndex)
	}
	s.blocks[key] = copyPostings(postings)
	return nil
}

func (s *MemoryStore) ReadBlock(term string, blockIndex int) ([]Posting, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := blockKey{term: term, index: blockIndex}
	postings, ok := s.blocks[key]
	if !ok {
		return nil, fmt.Errorf("term %q block %d is not stored", term, blockIndex)
	}
	s.reads[key]++
	return copyPostings(postings), nil
}

func (s *MemoryStore) ReadCount(term string, blockIndex int) int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.reads[blockKey{term: term, index: blockIndex}]
}

func (s *MemoryStore) TotalReads() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	total := 0
	for _, count := range s.reads {
		total += count
	}
	return total
}

func (s *MemoryStore) BlockCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.blocks)
}
