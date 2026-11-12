package main

import (
	"fmt"
	"log"
	"math/big"

	de "example.org/dataeng/q0298"
)

func main() {
	// Element 0-01-001: 8 bits, scale 1, reference 0.
	temperature, err := de.NewElementDef("air-temperature", 8, 1, big.NewInt(0))
	if err != nil {
		log.Fatal(err)
	}
	elements := de.ElementTable{{X: 1, Y: 1}: temperature}

	// Delayed replication of one raw descriptor position:
	//
	//   1-01-000  factor 0-31-001  element 0-01-001
	//
	// The factor is outside X=1; the replicated body is the single element
	// descriptor position.
	root := []de.Descriptor{
		{F: 1, X: 1, Y: 0},
		{F: 0, X: 31, Y: 1},
		{F: 0, X: 1, Y: 1},
	}
	template, err := de.Compile(root, elements, nil)
	if err != nil {
		log.Fatal(err)
	}

	// Factor=2 (8 bits), then values 20 and 25. Three zero padding bits follow
	// the final subset.
	bits, err := de.NewBitString("00000010" + "00010100" + "00011001" + "000")
	if err != nil {
		log.Fatal(err)
	}
	observations, err := template.Decode(bits, de.DecodeOptions{
		Subsets:         1,
		MaxObservations: 10,
		MaxSteps:        10,
		MaxDepth:        1,
	})
	if err != nil {
		log.Fatal(err)
	}

	for _, obs := range observations {
		fmt.Printf("subset=%d %s value=%s bits=[%d,%d) path=%v\n",
			obs.Subset, obs.Element.Name, obs.RationalString(),
			obs.BitStart, obs.BitEnd, obs.Path)
	}
}
