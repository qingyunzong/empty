package logrule_test

import (
	"fmt"

	"logrule"
)

func Example() {
	// Rules are replaced dynamically; the new generation takes effect at
	// sequence number 100.
	e := logrule.NewEngine(2)
	e.ReplaceRules(0, []logrule.Rule{{
		Name:  "old",
		Match: func(logrule.Record) bool { return true },
	}})
	e.ReplaceRules(100, []logrule.Rule{{
		Name:  "disk",
		Match: func(r logrule.Record) bool { return r.Kind == "log" },
		Derive: func(rec logrule.Record) []logrule.Record {
			return []logrule.Record{{Seq: rec.Seq, Kind: "diag", Msg: "check /var"}}
		},
	}})

	// Seq 50 is processed by the old generation; seq 100 by the new one.
	fmt.Print(e.Process(logrule.Record{Seq: 50, Kind: "log", Msg: "hello"}).String())
	fmt.Print(e.Process(logrule.Record{Seq: 100, Kind: "log", Msg: "disk full"}).String())

	// Output:
	// depth=0 gen=0 seq=50 kind="log" msg="hello" matched=[old]
	// depth=0 gen=1 seq=100 kind="log" msg="disk full" matched=[disk]
	//   depth=1 gen=1 seq=100 kind="diag" msg="check /var" matched=[]
}
