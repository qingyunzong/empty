package linearck_test

import (
	"fmt"

	"linearck"
)

// Exclusive borrows forbid aliased access to the owner; the checker
// prints the violating path.
func ExampleCheck() {
	p := &linearck.Program{
		Entry: "main",
		Blocks: map[string]*linearck.Block{
			"main": {
				Name: "main",
				Cmds: []linearck.Cmd{
					linearck.New{Name: "x"},
					linearck.Mut{Ref: "m", Owner: "x"},
					linearck.Use{Name: "x"},
				},
			},
		},
	}
	violations, err := linearck.Check(p)
	if err != nil {
		panic(err)
	}
	for _, v := range violations {
		fmt.Println(v)
	}
	// Output:
	// alias-during-exclusive: use x at main[2]
	//   path: main -> main[0] -> main[1] -> main[2]
}

// Branches that rejoin must agree on the borrow state; otherwise the
// checker reports both conflicting paths.
func ExampleCheck_merge() {
	p := &linearck.Program{
		Entry: "entry",
		Blocks: map[string]*linearck.Block{
			"entry": {
				Name: "entry",
				Cmds: []linearck.Cmd{linearck.New{Name: "x"}},
				Next: []string{"left", "right"},
			},
			"left": {
				Name: "left",
				Cmds: []linearck.Cmd{linearck.Share{Ref: "r", Owner: "x"}},
				Next: []string{"join"},
			},
			"right": {Name: "right", Next: []string{"join"}},
			"join":  {Name: "join"},
		},
	}
	violations, err := linearck.Check(p)
	if err != nil {
		panic(err)
	}
	for _, v := range violations {
		fmt.Println(v)
	}
	// Output:
	// merge-incompatible: block join entered with incompatible borrow states
	//   path A: entry -> entry[0] -> right -> join
	//   path B: entry -> entry[0] -> left -> left[0] -> join
}
