package formal_test

import (
	"context"
	"fmt"

	formal "example.org/dlks/formal/q10186"
)

func ExampleCoordinator() {
	ctx := context.Background()
	store := formal.NewMemStore(0)

	const step, generation, ranks = 1, 1, 3
	for rank := 0; rank < ranks; rank++ {
		uploader := &formal.Uploader{
			Store:      store,
			Step:       step,
			Generation: generation,
			Rank:       rank,
		}
		payload := []byte(fmt.Sprintf("rank-%d checkpoint bytes", rank))
		if _, err := uploader.Upload(ctx, payload); err != nil {
			fmt.Println("upload:", err)
			return
		}
	}

	result, err := (&formal.Coordinator{
		Store:      store,
		Step:       step,
		Generation: generation,
		Ranks:      ranks,
	}).Commit(ctx)
	if err != nil {
		fmt.Println("commit:", err)
		return
	}
	fmt.Println(result.Created, result.Manifest.RankCount)
	// Output: true 3
}
