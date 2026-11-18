package formal_test

import (
	"errors"
	"fmt"
	"time"

	"example.org/dlks/formal/q10099"
)

func Example() {
	manager, err := formal.NewManager(
		[]formal.Part{
			{Name: "server", Value: "127.0.0.1:8080"},
			{Name: "timeout", Value: 5 * time.Second},
		},
		formal.WithValidator("timeout", func(part formal.Part) error {
			if part.Value.(time.Duration) <= 0 {
				return errors.New("timeout must be positive")
			}
			return nil
		}),
	)
	if err != nil {
		panic(err)
	}

	snapshot := manager.Acquire()
	defer snapshot.Release()
	fmt.Printf("snapshot v%d parts=%d\n", snapshot.Version.ID(), snapshot.Version.Len())

	_, err = manager.Apply([]formal.Part{
		{Name: "server", Value: "127.0.0.1:9090"},
		{Name: "timeout", Value: time.Duration(0)},
	})
	fmt.Printf("bad apply: rejected=%v current=v%d\n", err != nil, manager.Current().ID())

	next, err := manager.Apply([]formal.Part{
		{Name: "server", Value: "127.0.0.1:9090"},
		{Name: "timeout", Value: 3 * time.Second},
	})
	if err != nil {
		panic(err)
	}
	server, _ := formal.Lookup[string](snapshot.Version, "server")
	fmt.Printf("good apply: v%d current=v%d\n", next.ID(), manager.Current().ID())
	fmt.Printf("snapshot still v%d server=%s\n", snapshot.Version.ID(), server)

	// Output:
	// snapshot v1 parts=2
	// bad apply: rejected=true current=v1
	// good apply: v2 current=v2
	// snapshot still v1 server=127.0.0.1:8080
}
