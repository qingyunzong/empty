package rebucket_test

import (
	"fmt"
	"math/big"

	"example.org/dataeng/q0110/rebucket"
)

// Two consecutive re-bucketings through a coarser intermediate grid do
// not, in general, reproduce the direct projection: merging buckets
// homogenizes their mass, and the information about the original
// distribution inside the merged bucket is lost.
func ExampleRebucket() {
	bounds := func(vals ...int64) []*big.Rat {
		out := make([]*big.Rat, len(vals))
		for i, v := range vals {
			out[i] = big.NewRat(v, 1)
		}
		return out
	}
	show := func(res *rebucket.Result) string {
		s := ""
		for i, m := range res.Masses {
			if i > 0 {
				s += " "
			}
			s += m.RatString()
		}
		return fmt.Sprintf("[%s] left=%s right=%s",
			s, res.LeftOverflow.RatString(), res.RightOverflow.RatString())
	}

	old := []rebucket.Bucket{
		rebucket.NewBucket(big.NewRat(0, 1), big.NewRat(1, 1), 1),
		rebucket.NewBucket(big.NewRat(1, 1), big.NewRat(2, 1), 3),
	}

	direct, _ := rebucket.Rebucket(old, bounds(0, 1, 2))
	coarse, _ := rebucket.Rebucket(old, bounds(0, 2))
	twice, _ := rebucket.Rebucket(coarse.Buckets(bounds(0, 2)), bounds(0, 1, 2))

	fmt.Println("direct:", show(direct))
	fmt.Println("coarse:", show(coarse))
	fmt.Println("twice: ", show(twice))
	// Output:
	// direct: [1 3] left=0 right=0
	// coarse: [4] left=0 right=0
	// twice:  [2 2] left=0 right=0
}
