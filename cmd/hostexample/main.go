// Command hostexample is a small host-side walkthrough of the dataeng allele
// projection package: it builds a mapping, ranks and unranks tuples,
// projects a complete probability vector, and rewrites GT strings.
package main

import (
	"fmt"
	"math/big"

	dataeng "example.org/dataeng/q0275"
)

func main() {
	const sourceAlleles = 4
	const targetAlleles = 3
	const ploidy = 2

	// Source 0 keeps target 0; source alleles 1 and 2 merge onto target 1;
	// source allele 3 is retained as target 2. No allele is dropped here.
	mapping := []int{0, 1, 1, 2}
	transform, err := dataeng.NewTransform(sourceAlleles, targetAlleles, ploidy, mapping)
	if err != nil {
		panic(err)
	}

	fmt.Println("source tuples:", transform.SourceCount().String())
	fmt.Println("target tuples:", transform.TargetCount().String())

	tuple := []int{1, 3}
	rank, err := transform.RankSource(tuple)
	if err != nil {
		panic(err)
	}
	fmt.Printf("rank of %v = %s\n", tuple, rank.String())

	roundTrip, err := transform.UnrankSource(rank)
	if err != nil {
		panic(err)
	}
	fmt.Printf("unrank(%s) = %v\n", rank.String(), roundTrip)

	// Exact round trip above the JavaScript Number safe-integer limit.
	huge := new(big.Int).Add(big.NewInt(1), new(big.Int).Lsh(big.NewInt(1), 53))
	hugeTuple, err := dataeng.Unrank(64, 16, huge)
	if err != nil {
		panic(err)
	}
	hugeRank, err := dataeng.Rank(hugeTuple, 16)
	if err != nil {
		panic(err)
	}
	fmt.Printf("2^53+1 round trip: %s -> %v -> %s\n", huge.String(), hugeTuple, hugeRank.String())

	// A complete source probability vector for C(4+2-1,2) = 10 tuples.
	probabilities := make([]dataeng.Rational, 10)
	for i := range probabilities {
		probabilities[i] = dataeng.Rational{Num: "1", Den: "10"}
	}
	result, err := transform.ConvertVector(probabilities, 1<<20)
	if err != nil {
		panic(err)
	}
	fmt.Printf("retained=%s discarded=%s status=%d\n",
		result.Retained.Num+"/"+result.Retained.Den,
		result.Discarded.Num+"/"+result.Discarded.Den,
		result.Status)
	for targetRank, probability := range result.Probabilities {
		targetTuple, err := transform.UnrankTarget(big.NewInt(int64(targetRank)))
		if err != nil {
			panic(err)
		}
		fmt.Printf("target %v <- %s/%s\n", targetTuple, probability.Num, probability.Den)
	}

	// GT conversion keeps order and separators; dropped alleles become '.'.
	dropMapping := []int{0, dataeng.Drop, 1}
	dropTransform, err := dataeng.NewTransform(3, 2, 2, dropMapping)
	if err != nil {
		panic(err)
	}
	for _, gt := range []string{"0/1", "2|1", "./1"} {
		projected, err := dropTransform.ConvertGT(gt)
		if err != nil {
			panic(err)
		}
		fmt.Printf("GT %s -> %s\n", gt, projected)
	}
}
