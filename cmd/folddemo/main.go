// folddemo parses integer expressions, prints the original and folded ASTs
// with provenance, and evaluates both against a sample environment.
package main

import (
	"fmt"

	"intfold"
)

func main() {
	samples := []string{
		"2 + 3 * 4",
		"2147483647 + 1",
		"0 && 1 / 0",
		"1 || 1 % 0",
		"1 ? 42 : 1 / 0",
		"1 / 0",
		"x && 1 / 0",
		"x ? x % 0 : 7",
	}
	env := map[string]int32{"x": 5}
	for _, src := range samples {
		fmt.Printf("=== %s\n", src)
		e, err := intfold.Parse(src)
		if err != nil {
			fmt.Println("parse error:", err)
			continue
		}
		fmt.Println("-- original AST --")
		fmt.Print(intfold.Dump(e))
		f := intfold.Fold(e)
		fmt.Println("-- folded AST (with provenance) --")
		fmt.Print(intfold.Dump(f))
		v1, t1 := intfold.Eval(e, env)
		v2, t2 := intfold.Eval(f, env)
		fmt.Printf("eval original: %s\n", result(v1, t1))
		fmt.Printf("eval folded  : %s\n\n", result(v2, t2))
	}
}

func result(v int32, t *intfold.Trap) string {
	if t != nil {
		return "TRAP " + t.Error()
	}
	return fmt.Sprintf("%d", v)
}
