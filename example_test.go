package dataeng_test

import (
	"fmt"
	"slices"

	dataeng "example.org/dataeng/q0280"
)

func Example() {
	// This is a host-owned deterministic mapping. The production host must
	// provide its own scheme and keep the same SchemeID bound to that contract.
	hash := func(id uint64, seeds []uint64, cells int) ([]int, uint64) {
		indices := make([]int, 0, len(seeds))
		used := make(map[int]struct{}, len(seeds))
		for _, seed := range seeds {
			index := int(mix64(id^seed) % uint64(cells))
			for {
				if _, exists := used[index]; !exists {
					break
				}
				index = (index + 1) % cells
			}
			used[index] = struct{}{}
			indices = append(indices, index)
		}
		return indices, mix64(id ^ 0xa5a5a5a5deadbeef)
	}

	cfg := dataeng.Config{
		Cells:    32,
		Seeds:    []uint64{0x243f6a8885a308d3, 0x13198a2e03707344, 0xa4093822299f31d0},
		SchemeID: "host-example-mix64-v1",
		Hash:     hash,
	}

	a, err := dataeng.BuildTable(cfg, []uint64{101, 102, 103, 104})
	if err != nil {
		panic(err)
	}
	b, err := dataeng.BuildTable(cfg, []uint64{103, 105})
	if err != nil {
		panic(err)
	}
	diff, err := dataeng.Subtract(a, b)
	if err != nil {
		panic(err)
	}

	result, err := dataeng.PeelAll(diff)
	if err != nil {
		panic(err)
	}

	var positive, negative []uint64
	for _, key := range result.Keys {
		if key.Direction == dataeng.DirectionPositive {
			positive = append(positive, key.Key)
		} else {
			negative = append(negative, key.Key)
		}
	}
	slices.Sort(positive)
	slices.Sort(negative)

	fmt.Println("peel status:", result.Status)
	if result.Status != dataeng.PeelStatusPeeled {
		fmt.Println("residual cells:", len(result.Residual))
		return
	}

	verification, err := result.Verify([]uint64{101, 102, 103, 104}, []uint64{103, 105})
	if err != nil {
		panic(err)
	}
	fmt.Println("A-B:", positive)
	fmt.Println("B-A:", negative)
	fmt.Println("verification:", verification.Status)

	// Output:
	// peel status: peeled
	// A-B: [101 102 104]
	// B-A: [105]
	// verification: verified
}

func mix64(value uint64) uint64 {
	value += 0x9e3779b97f4a7c15
	value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9
	value = (value ^ (value >> 27)) * 0x94d049bb133111eb
	return value ^ (value >> 31)
}
