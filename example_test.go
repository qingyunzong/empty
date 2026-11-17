package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10160"
)

func ExampleCoordinator() {
	store := formal.NewMemoryStore()
	c, err := formal.Open(store)
	if err != nil {
		panic(err)
	}

	receipt, err := c.Prepare(formal.PrepareRequest{
		ID: "order-42",
		Message: formal.Message{
			ID:    "message-42",
			Topic: "orders",
			Body:  []byte(`{"amount":10}`),
		},
	})
	if err != nil {
		panic(err)
	}
	fmt.Println("prepared deliveries:", len(c.Deliverable()))

	decision, err := c.Commit(receipt.Ref)
	if err != nil {
		panic(err)
	}
	fmt.Println("decision:", decision.State, "deliveries:", len(c.Deliverable()))

	again, err := c.Commit(receipt.Ref)
	if err != nil {
		panic(err)
	}
	fmt.Println("duplicate:", again.Duplicate, "deliveries:", len(c.Deliverable()))

	replayed, err := formal.Open(store)
	if err != nil {
		panic(err)
	}
	fmt.Println("after replay:", len(replayed.Deliverable()))

	// Output:
	// prepared deliveries: 0
	// decision: committed deliveries: 1
	// duplicate: true deliveries: 1
	// after replay: 1
}
