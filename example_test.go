package dataeng_test

import (
	"fmt"

	dataeng "example.org/dataeng/q0119"
)

func ExampleInterpreter() {
	metadata := dataeng.Metadata{
		Version: "2026-11",
		Regions: map[string]dataeng.Region{
			"GB": {
				CountryCode:           "44",
				InternationalPrefix:   "00",
				NationalPrefix:        "0",
				NationalNumberLengths: []int{10},
			},
		},
	}

	interpreter, err := dataeng.NewInterpreter(metadata, "GB")
	if err != nil {
		panic(err)
	}
	result, err := interpreter.Interpret("+44 (0)20 7946 0018 ext. 42")
	if err != nil {
		panic(err)
	}

	candidate := result.Interpretations[0]
	fmt.Printf("%s %s %s %s %s %s\n",
		candidate.Kind,
		candidate.CountryCode,
		candidate.TrunkPrefix,
		candidate.NationalNumber,
		candidate.Extension,
		candidate.Possibility,
	)
	// Output:
	// international_plus 44 0 2079460018 42 possible
}
