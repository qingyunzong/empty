package q220_test

import (
	"fmt"

	q220 "example.com/dlks/q220"
)

func ExampleCanonicalize() {
	triples := []q220.Triple{
		{Subject: q220.Node{Type: q220.Blank, Value: "x"},
			Predicate: q220.Node{Type: q220.IRI, Value: "http://p/knows"},
			Object:    q220.Node{Type: q220.Blank, Value: "y"}},
		{Subject: q220.Node{Type: q220.Blank, Value: "y"},
			Predicate: q220.Node{Type: q220.IRI, Value: "http://p/name"},
			Object:    q220.Node{Type: q220.IRI, Value: "http://n/1"}},
	}

	res, err := q220.Canonicalize(triples)
	if err != nil {
		panic(err)
	}
	fmt.Println("blank count:", res.BlankCount)
	for _, m := range res.Mapping {
		kind := "IRI"
		if m.Source.Type == q220.Blank {
			kind = "blank"
		}
		fmt.Printf("%s %s -> %s\n", kind, m.Source.Value, m.Canonical.Value)
	}
	fmt.Printf("encoding: %x\n", res.Encoding)
	// Output:
	// blank count: 2
	// blank x -> 1
	// IRI http://p/knows -> http://p/knows
	// blank y -> 0
	// IRI http://p/name -> http://p/name
	// IRI http://n/1 -> http://n/1
	// encoding: 420000000130490000000d687474703a2f2f702f6e616d65490000000a687474703a2f2f6e2f31420000000131490000000e687474703a2f2f702f6b6e6f7773420000000130
}

func ExampleMerger() {
	mg := q220.NewMerger()

	first := []q220.Triple{
		{q220.Node{Type: q220.Blank, Value: "a1"},
			q220.Node{Type: q220.IRI, Value: "p"},
			q220.Node{Type: q220.IRI, Value: "u"}},
	}
	if _, err := mg.Merge(first); err != nil {
		panic(err)
	}

	second := []q220.Triple{
		{q220.Node{Type: q220.Blank, Value: "renamed"},
			q220.Node{Type: q220.IRI, Value: "p"},
			q220.Node{Type: q220.IRI, Value: "u"}},
	}
	report, err := mg.Merge(second)
	if err != nil {
		panic(err)
	}
	fmt.Println("isomorphic:", report.Isomorphic)
	for _, bm := range report.BlankMapping {
		fmt.Printf("%s -> %s\n", bm.From, bm.To)
	}
	// Output:
	// isomorphic: true
	// renamed -> a1
}
