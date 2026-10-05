// Command simdemo runs a small broadcast simulation with packet loss.
package main

import (
	"fmt"
	"log"
	"os"

	"broadcastsim"
)

func main() {
	dir, err := os.MkdirTemp("", "simdemo")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)

	c, err := broadcastsim.NewCluster(dir, "n1", "n2", "n3")
	if err != nil {
		log.Fatal(err)
	}

	for seq := 1; seq <= 3; seq++ {
		if err := c.Broadcast("n1", broadcastsim.Message{Seq: seq, Payload: fmt.Sprintf("hello-%d", seq)}); err != nil {
			log.Fatal(err)
		}
	}

	// First round: drop everything destined for n3.
	c.Loss = func(env broadcastsim.Envelope) bool { return env.To == "n3" }
	for round := 0; round < 3; round++ {
		if err := c.Flush(); err != nil {
			log.Fatal(err)
		}
	}
	fmt.Println("after lossy rounds:")
	for _, id := range c.NodeIDs() {
		fmt.Printf("  %s delivered: %v (pending packets: %d)\n", id, c.Node(id).Delivered(), c.Pending())
	}

	// Network recovers; retained packets are retried.
	c.Loss = nil
	if err := c.FlushUntilIdle(20); err != nil {
		log.Fatal(err)
	}
	fmt.Println("after recovery:")
	for _, id := range c.NodeIDs() {
		fmt.Printf("  %s delivered: %v\n", id, c.Node(id).Delivered())
	}
	if err := c.Verify(); err != nil {
		log.Fatal(err)
	}
	fmt.Println("cluster verified: no conflicts, consistent prefixes")
}
