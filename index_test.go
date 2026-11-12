package dataeng

import "testing"

func TestBuildRejectsInvalidInputs(t *testing.T) {
	validDocs := []uint64{1, 2, 3}
	validPostings := []Posting{
		{DocumentID: 1, Contribution: r(1, 1)},
		{DocumentID: 2, Contribution: r(1, 1)},
		{DocumentID: 3, Contribution: r(1, 1)},
	}
	store := NewMemoryStore()

	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "zero block size",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": validPostings}, 0, store)
				return err
			},
		},
		{
			name: "negative block size",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": validPostings}, -1, store)
				return err
			},
		},
		{
			name: "nil writer",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": validPostings}, 2, nil)
				return err
			},
		},
		{
			name: "duplicate document ID",
			run: func() error {
				_, err := BuildIndex([]uint64{1, 1, 2}, nil, 1, NewMemoryStore())
				return err
			},
		},
		{
			name: "posting outside directory",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": {{DocumentID: 7, Contribution: r(1, 1)}}}, 1, NewMemoryStore())
				return err
			},
		},
		{
			name: "duplicate posting ID",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": {{DocumentID: 1, Contribution: r(1, 1)}, {DocumentID: 1, Contribution: r(2, 1)}}}, 1, NewMemoryStore())
				return err
			},
		},
		{
			name: "descending posting IDs",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": {{DocumentID: 2, Contribution: r(1, 1)}, {DocumentID: 1, Contribution: r(2, 1)}}}, 1, NewMemoryStore())
				return err
			},
		},
		{
			name: "negative contribution",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": {{DocumentID: 1, Contribution: r(-1, 1)}}}, 1, NewMemoryStore())
				return err
			},
		},
		{
			name: "nil contribution",
			run: func() error {
				_, err := BuildIndex(validDocs, map[string][]Posting{"t": {{DocumentID: 1, Contribution: nil}}}, 1, NewMemoryStore())
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); err == nil {
				t.Fatalf("BuildIndex accepted invalid input")
			}
		})
	}
}

func TestBuildComputesActualMaximumContribution(t *testing.T) {
	documents := []uint64{1, 2, 3, 4, 5, 6}
	postings := []Posting{
		{1, r(1, 3)},
		{2, r(5, 7)},
		{3, r(2, 5)},
		{4, r(9, 8)},
		{5, r(1, 9)},
		{6, r(3, 11)},
	}
	metadata, store := buildForTest(t, documents, postingsMap(postings), 3)
	termMeta := metadata.Terms["t"]
	if len(termMeta.Blocks) != 2 {
		t.Fatalf("block count = %d, want 2", len(termMeta.Blocks))
	}
	if termMeta.Blocks[0].MinDocumentID != 1 || termMeta.Blocks[0].MaxDocumentID != 3 || termMeta.Blocks[0].PostingCount != 3 {
		t.Fatalf("unexpected first block metadata: %+v", termMeta.Blocks[0])
	}
	if termMeta.Blocks[0].MaxContribution.Cmp(r(5, 7)) != 0 {
		t.Fatalf("first block max = %s, want 5/7", termMeta.Blocks[0].MaxContribution.RatString())
	}
	if termMeta.Blocks[1].MinDocumentID != 4 || termMeta.Blocks[1].MaxDocumentID != 6 || termMeta.Blocks[1].PostingCount != 3 {
		t.Fatalf("unexpected second block metadata: %+v", termMeta.Blocks[1])
	}
	if termMeta.Blocks[1].MaxContribution.Cmp(r(9, 8)) != 0 {
		t.Fatalf("second block max = %s, want 9/8", termMeta.Blocks[1].MaxContribution.RatString())
	}
	if store.BlockCount() != 2 {
		t.Fatalf("stored block count = %d, want 2", store.BlockCount())
	}
	for blockIndex := 0; blockIndex < 2; blockIndex++ {
		got, err := store.ReadBlock("t", blockIndex)
		if err != nil {
			t.Fatalf("read block %d: %v", blockIndex, err)
		}
		start := blockIndex * 3
		for i := range got {
			if got[i].DocumentID != postings[start+i].DocumentID {
				t.Fatalf("block %d posting %d ID = %d, want %d", blockIndex, i, got[i].DocumentID, postings[start+i].DocumentID)
			}
			if got[i].Contribution.Cmp(postings[start+i].Contribution) != 0 {
				t.Fatalf("block %d posting %d contribution mismatch", blockIndex, i)
			}
		}
	}
}

func TestBuildSortsDirectoryCopyAndAcceptsEmptyTerms(t *testing.T) {
	documents := []uint64{5, 1, 3}
	terms := map[string][]Posting{
		"empty": {},
		"t":     {{DocumentID: 1, Contribution: r(2, 3)}, {DocumentID: 5, Contribution: r(4, 9)}},
	}
	metadata, store := buildForTest(t, documents, terms, 2)
	if documents[0] != 5 || documents[1] != 1 || documents[2] != 3 {
		t.Fatalf("BuildIndex mutated the caller's directory: %v", documents)
	}
	if want := []uint64{1, 3, 5}; len(metadata.Documents) != len(want) || metadata.Documents[0] != 1 || metadata.Documents[1] != 3 || metadata.Documents[2] != 5 {
		t.Fatalf("directory = %v, want %v", metadata.Documents, want)
	}
	if len(metadata.Terms["empty"].Blocks) != 0 {
		t.Fatalf("empty term acquired blocks")
	}
	if len(metadata.Terms["t"].Blocks) != 1 {
		t.Fatalf("t acquired %d blocks, want 1", len(metadata.Terms["t"].Blocks))
	}
	if store.BlockCount() != 1 {
		t.Fatalf("store block count = %d, want 1", store.BlockCount())
	}
}

func TestMemoryStoreReadsAreIndependentCopies(t *testing.T) {
	store := NewMemoryStore()
	postings := []Posting{{DocumentID: 1, Contribution: r(2, 3)}}
	if err := store.WriteBlock("t", 0, postings); err != nil {
		t.Fatalf("WriteBlock: %v", err)
	}
	postings[0].DocumentID = 99

	first, err := store.ReadBlock("t", 0)
	if err != nil {
		t.Fatalf("ReadBlock: %v", err)
	}
	if first[0].DocumentID != 1 || first[0].Contribution.Cmp(r(2, 3)) != 0 {
		t.Fatalf("store did not retain its own copy: %+v", first)
	}
	first[0].Contribution.Set(r(7, 1))
	second, err := store.ReadBlock("t", 0)
	if err != nil {
		t.Fatalf("second ReadBlock: %v", err)
	}
	if second[0].Contribution.Cmp(r(2, 3)) != 0 {
		t.Fatalf("mutating a returned payload changed stored data")
	}
}

func postingsMap(postings []Posting) map[string][]Posting {
	return map[string][]Posting{"t": postings}
}
