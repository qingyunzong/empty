package formal_test

import (
	"fmt"

	formal "example.org/dlks/formal/q10097"
)

func ExampleAllocator() {
	allocator := formal.NewAllocator(formal.Options{EntityTag: "team"})
	for _, resource := range []formal.Resource{
		{ID: "root", Tags: formal.Tags{"team": "platform"}},
		{ID: "web", Parent: "root", Tags: formal.Tags{"team": "web"}},
		{ID: "db", Parent: "root", Tags: formal.Tags{"team": "db"}},
		{ID: "batch", Parent: "root"},
	} {
		if err := allocator.AddResource(resource); err != nil {
			panic(err)
		}
	}
	for _, charge := range []formal.Charge{
		formal.DirectCharge("web-vm", "web", formal.MustParseMoney("40.00")),
		formal.DirectCharge("db-vm", "db", formal.MustParseMoney("20.00")),
		formal.DirectCharge("batch-job", "batch", formal.MustParseMoney("5.00")),
		{
			ID: "shared-nat", Amount: formal.MustParseMoney("12.00"), Kind: formal.KindShared,
			Shares: []formal.Share{
				formal.ResourceShare("web", 1),
				formal.ResourceShare("db", 1),
			},
		},
		formal.SavingCharge("commitment", "root", formal.MustParseMoney("3.00"),
			map[string]int64{"web": 2, "db": 1}),
	} {
		if err := allocator.AddCharge(charge); err != nil {
			panic(err)
		}
	}

	report, err := allocator.Allocate()
	if err != nil {
		panic(err)
	}
	for _, entity := range report.Entities {
		fmt.Printf("%s direct=%s shared=%s savings=%s total=%s\n",
			entity.Entity, entity.Direct, entity.Shared, entity.Savings, entity.Total)
	}
	fmt.Printf("net=%s unallocated=%s\n", report.GrandTotal(), report.Totals.Unallocated)

	// Output:
	// db direct=20.00 shared=6.00 savings=1.00 total=25.00
	// platform direct=5.00 shared=0.00 savings=0.00 total=5.00
	// web direct=40.00 shared=6.00 savings=2.00 total=44.00
	// net=74.00 unallocated=0.00
}
