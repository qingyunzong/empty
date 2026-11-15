package dataeng_test

import (
	"fmt"

	"example.org/dataeng/q0229"
)

func ExampleInfer() {
	samples := []dataeng.Sample{
		{Name: "jan.csv", Data: []byte("name,amount\n\"Alice\",10\n\"Bob\",20\n")},
		{Name: "feb.csv", Data: []byte("name,amount\n\"Carol\",30\n\"Dave\",40\n")},
	}
	result, err := dataeng.Infer(samples)
	if err != nil {
		panic(err)
	}
	if result.Ambiguous {
		fmt.Println("ambiguous:", result.Reasons)
		return
	}
	dialect := result.Dialect()
	fmt.Printf("delimiter=%c quote=%c newline=%q encoding=%s width=%d\n",
		dialect.Delimiter, dialect.Quote, dialect.Newline, dialect.Encoding,
		result.Best.Evidence.DominantWidth)
	// Output:
	// delimiter=, quote=" newline="\n" encoding=utf-8 width=2
}

func ExampleResult_Lock() {
	samples := []dataeng.Sample{
		{Name: "seed.csv", Data: []byte("id,value\n1,a\n2,b\n")},
	}
	result, err := dataeng.Infer(samples)
	if err != nil {
		panic(err)
	}
	lock, err := result.Lock()
	if err != nil {
		panic(err)
	}

	good := lock.Validate("good.csv", []byte("3,c\n"))
	bad := lock.Validate("bad.csv", []byte("4;d\n"))
	fmt.Println(good.Status)
	fmt.Println(bad.Status, bad.Violations[0].Kind)
	// Output:
	// accepted
	// quarantined delimiter
}
