package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10095"
)

func ExampleAggregator() {
	a, err := formal.New(formal.DefaultConfig(), "api-1", "api-2")
	if err != nil {
		panic(err)
	}

	for _, id := range []formal.InstanceID{"api-1", "api-2"} {
		_, _ = a.Record(id, formal.ProbeStartup, formal.ProbePass)
		_, _ = a.Record(id, formal.ProbeReadiness, formal.ProbePass)
		_, _ = a.Record(id, formal.ProbeReadiness, formal.ProbePass)
	}
	fmt.Println(a.ReadyInstances())
	fmt.Println(a.Select(2))

	for i := 0; i < 3; i++ {
		_, _ = a.Record("api-1", formal.ProbeReadiness, formal.ProbeFail)
	}
	fmt.Println(a.ReadyInstances())
	fmt.Println(a.Select(2))

	// Output:
	// [api-1 api-2]
	// [api-1 api-2]
	// [api-2]
	// [api-2]
}
