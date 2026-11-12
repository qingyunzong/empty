package dataeng

import (
	"math/big"
	"testing"
)

func TestNewSearcherValidatesAndSnapshotsMetadata(t *testing.T) {
	if _, err := NewSearcher(nil, NewMemoryStore()); err == nil {
		t.Fatalf("nil metadata accepted")
	}
	documents := []uint64{1, 2, 3}
	metadata, store := buildForTest(t, documents, map[string][]Posting{
		"t": {{1, r(1, 1)}, {2, r(2, 1)}, {3, r(3, 1)}},
	}, 3)
	if _, err := NewSearcher(metadata, nil); err == nil {
		t.Fatalf("nil reader accepted")
	}
	searcher := newSearcherForTest(t, metadata, store)

	// Mutating the returned metadata after construction must not change the
	// searcher's snapshot.
	metadata.Documents[0] = 99
	termMeta := metadata.Terms["t"]
	termMeta.Blocks[0].MaxContribution = r(100, 1)
	metadata.Terms["t"] = termMeta

	result, err := searcher.Search(map[string]*big.Rat{"t": r(1, 1)}, nil, 2)
	if err != nil {
		t.Fatalf("Search after metadata mutation: %v", err)
	}
	assertHitsEqual(t, result.Hits, []Hit{{3, r(3, 1)}, {2, r(2, 1)}})
}

func TestSearchRejectsInvalidQueryInputs(t *testing.T) {
	documents := []uint64{1}
	metadata, store := buildForTest(t, documents, map[string][]Posting{
		"t": {{1, r(1, 1)}},
	}, 1)
	searcher := newSearcherForTest(t, metadata, store)

	if _, err := searcher.Search(nil, nil, -1); err == nil {
		t.Fatalf("negative k accepted")
	}
	if _, err := searcher.Search(map[string]*big.Rat{"t": nil}, nil, 1); err == nil {
		t.Fatalf("nil weight accepted")
	}
	if _, err := searcher.Search(map[string]*big.Rat{"t": r(-1, 2)}, nil, 1); err == nil {
		t.Fatalf("negative weight accepted")
	}
}

func TestCorruptBlockPayloadIsRejected(t *testing.T) {
	documents := []uint64{1, 2, 3}
	metadata, store := buildForTest(t, documents, map[string][]Posting{
		"t": {{1, r(1, 1)}, {2, r(2, 1)}, {3, r(3, 1)}},
	}, 3)
	reader := &corruptingReader{source: store}
	searcher, err := NewSearcher(metadata, reader)
	if err != nil {
		t.Fatalf("NewSearcher: %v", err)
	}
	if _, err := searcher.Search(map[string]*big.Rat{"t": r(1, 1)}, nil, 1); err == nil {
		t.Fatalf("Search accepted a corrupt block payload")
	}
}

type corruptingReader struct {
	source BlockReader
}

func (r *corruptingReader) ReadBlock(term string, blockIndex int) ([]Posting, error) {
	postings, err := r.source.ReadBlock(term, blockIndex)
	if err != nil {
		return nil, err
	}
	if len(postings) > 0 {
		postings[0].Contribution = big.NewRat(100, 1)
	}
	return postings, nil
}
