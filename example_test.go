package dataeng

import "fmt"

func ExampleDiff() {
	old := Snapshot{Blocks: []Block{
		{ID: "p1", Path: "article>p[1]", Text: "alpha"},
		{ID: "p2", Path: "article>p[2]", Text: "beta"},
	}}
	new := Snapshot{Blocks: []Block{
		{ID: "ad", Kind: KindAdvertisement, Path: "article>div.ad[1]", Text: "buy"},
		{ID: "p1", Path: "article>p[2]", Text: "alpha revised"},
		{ID: "p2", Path: "article>p[3]", Text: "beta"},
		{ID: "p3", Path: "article>p[4]", Text: "gamma"},
	}}

	for _, event := range Diff(old, new).Events {
		fmt.Printf("%s %s\n", event.Kind, event.BlockID)
	}

	// Output:
	// add p3
	// modify p1
}
