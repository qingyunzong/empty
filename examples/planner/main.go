// Command planner is a small example of how a query planner can import the
// containment package. It uses parsed query structures directly; no SQL is
// parsed here.
package main

import (
	"fmt"
	"os"
	"sort"

	dq "example.org/dataeng/q0294"
)

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}

func tupleString(tuple dq.Tuple) string {
	out := "("
	for i, value := range tuple {
		if i > 0 {
			out += ","
		}
		if text, ok := value.Text(); ok {
			out += fmt.Sprintf("%q", text)
		} else {
			id, _ := value.FreshID()
			out += fmt.Sprintf("fresh#%d", id)
		}
	}
	return out + ")"
}

func printDatabase(db dq.Database) {
	relations := make([]string, 0, len(db.Relations))
	for relation := range db.Relations {
		relations = append(relations, relation)
	}
	sort.Strings(relations)
	if len(relations) == 0 {
		fmt.Println("  (empty database)")
		return
	}
	for _, relation := range relations {
		for _, tuple := range db.Relations[relation] {
			fmt.Printf("  %s%s\n", relation, tupleString(tuple))
		}
	}
}

func main() {
	schema := dq.NewSchema(map[string]int{"R": 1, "S": 1})

	// A(x) :- R(x), S(x)
	a := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
		dq.NewAtom("S", dq.Var("x")),
	)
	// B(x) :- R(x)
	b := dq.NewQuery(
		[]dq.Term{dq.Var("x")},
		dq.NewAtom("R", dq.Var("x")),
	)

	problem := dq.Problem{Schema: schema, A: a, B: b}
	result, err := dq.Check(problem, dq.Unlimited)
	if err != nil {
		fail("check A contained in B: %v", err)
	}
	fmt.Printf("A contained in B: %v (status=%s, steps=%d)\n",
		result.Status == dq.Contained, result.Status, result.TotalSteps)
	if result.Status == dq.Contained {
		for _, binding := range result.Mapping {
			fmt.Printf("  B variable %q -> %s\n", binding.Variable, binding.Target)
		}
	}

	reverse, err := dq.Check(problem.Reverse(), dq.Unlimited)
	if err != nil {
		fail("check B contained in A: %v", err)
	}
	fmt.Printf("B contained in A: %v (status=%s, steps=%d)\n",
		reverse.Status == dq.Contained, reverse.Status, reverse.TotalSteps)
	if reverse.Status == dq.NotContained {
		fmt.Println("Counterexample database:")
		printDatabase(reverse.Counterexample.Database)
		fmt.Printf("Counterexample head: %s\n", tupleString(reverse.Counterexample.Head))

		// Recompute with the actual interpreter instead of trusting the
		// certificate fields.
		inA, err := dq.ContainsTuple(b, reverse.Counterexample.Database, reverse.Counterexample.Head)
		if err != nil {
			fail("verify A on counterexample: %v", err)
		}
		inB, err := dq.ContainsTuple(a, reverse.Counterexample.Database, reverse.Counterexample.Head)
		if err != nil {
			fail("verify B on counterexample: %v", err)
		}
		fmt.Printf("Interpreter: tuple in B=%v, tuple in A=%v\n", inA, inB)
	}

	equivalence, err := dq.CheckEquivalence(problem, dq.Unlimited)
	if err != nil {
		fail("equivalence: %v", err)
	}
	if equivalence.Decided {
		fmt.Printf("Equivalent: %v\n", equivalence.Equal)
	} else {
		fmt.Println("Equivalent: undecided")
	}
}
