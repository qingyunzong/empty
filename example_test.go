package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0163"
)

func ExamplePlanBlocks() {
	samples := []int64{10, 12, 14, 16}
	plan := dataeng.PlanBlocks(samples)

	for _, block := range plan.Blocks {
		fmt.Printf("block [%d,%d) width=%d cost=%d\n",
			block.Start, block.End, block.Width, block.Cost)
	}
	cert := plan.Certificate()
	fmt.Printf("blocks=%d total=%d\n", cert.BlockCount, cert.TotalBytes)

	encoded, err := dataeng.EncodePlan(samples, plan)
	if err != nil {
		panic(err)
	}
	decoded, err := dataeng.Decode(encoded)
	if err != nil {
		panic(err)
	}
	fmt.Printf("round trip=%v\n", decoded)
	// Output:
	// block [0,4) width=3 cost=12
	// blocks=1 total=12
	// round trip=[10 12 14 16]
}
