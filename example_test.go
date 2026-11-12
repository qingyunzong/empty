package dataeng

import (
	"fmt"
	"math/big"
)

// This example shows the two host-side calls: BuildIndex with a write-only
// store, then NewSearcher/Search with the metadata and the same store's read
// interface.  The final counter demonstrates that block loads are observable.
func ExampleBuildIndex_and_search() {
	documents := []uint64{4, 2, 1, 3}
	terms := map[string][]Posting{
		"go": {
			{DocumentID: 1, Contribution: big.NewRat(3, 2)},
			{DocumentID: 2, Contribution: big.NewRat(1, 2)},
			{DocumentID: 3, Contribution: big.NewRat(2, 1)},
			{DocumentID: 4, Contribution: big.NewRat(1, 4)},
		},
		"lang": {
			{DocumentID: 1, Contribution: big.NewRat(1, 3)},
			{DocumentID: 3, Contribution: big.NewRat(5, 4)},
			{DocumentID: 4, Contribution: big.NewRat(1, 5)},
		},
	}
	store := NewMemoryStore()
	metadata, err := BuildIndex(documents, terms, 2, store)
	if err != nil {
		panic(err)
	}
	searcher, err := NewSearcher(metadata, store)
	if err != nil {
		panic(err)
	}
	result, err := searcher.Search(map[string]*big.Rat{
		"go":   big.NewRat(2, 3),
		"lang": big.NewRat(4, 5),
	}, nil, 2)
	if err != nil {
		panic(err)
	}
	for _, hit := range result.Hits {
		fmt.Printf("%d %s\n", hit.DocumentID, hit.Score.RatString())
	}
	fmt.Printf("block reads: %d\n", result.Stats.BlockReads)
	fmt.Printf("store reads: %d\n", store.TotalReads())

	// Output:
	// 3 7/3
	// 1 19/15
	// block reads: 4
	// store reads: 4
}
