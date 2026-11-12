package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0052"
)

func Example() {
	root := &dataeng.Node{Tag: "root", Children: []*dataeng.Node{
		{ID: 1, Tag: "section", Children: []*dataeng.Node{
			{ID: 2, Tag: "item"},
			{ID: 3, Tag: "item"},
		}},
		{ID: 4, Tag: "section", Children: []*dataeng.Node{
			{ID: 5, Tag: "item"},
		}},
	}}

	// Position predicates are relative to each input node's own candidates,
	// so item 3 (last of section 1) and item 5 (last of section 2) match;
	// the [1] branch adds item 2, while item 5 is deduplicated in the union.
	sel := dataeng.MustCompile("section/item[last()]|section/item[1]")
	for _, id := range sel.EvalIDs(root) {
		fmt.Println(id)
	}

	if _, err := dataeng.Compile("section/"); err != nil {
		fmt.Println(err)
	}
	// Output:
	// 2
	// 3
	// 5
	// selector: syntax error at byte 8: empty step
}
