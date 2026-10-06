package linearchk_test

import (
	"fmt"

	"linearchk"
)

func ExampleCheck() {
	prog, _ := linearchk.Parse(`
		new x
		excl m = &mut x
		use x
		drop x
	`)
	for _, v := range linearchk.Check(prog) {
		fmt.Println(v)
	}
	// Output:
	// use x: aliased access during exclusive borrow m
	//   path: new x -> excl m = &mut x -> use x
	// drop x: borrow m would outlive its owner
	//   path: new x -> excl m = &mut x -> use x -> drop x
}

func ExampleExplore() {
	prog, _ := linearchk.Parse(`
		new x
		share r = &x
		use r
		drop r
		drop x
	`)
	ex := linearchk.Explore(prog)
	fmt.Println("violations:", len(ex.Bad))
	fmt.Println("reachable states:", len(ex.States))
	// Output:
	// violations: 0
	// reachable states: 3
}
