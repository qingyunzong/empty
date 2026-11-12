// Command host is a minimal integration example for a data-ingest host.
//
// Run it with:
//
//	go run ./examples/host
package main

import (
	"fmt"
	"log"

	dataeng "example.org/dataeng/q0263"
)

func main() {
	ast := &dataeng.AST{Root: &dataeng.Node{
		Path: "ORDER",
		Kind: dataeng.Group,
		Children: []*dataeng.Node{
			{Path: "ORDER.LINE-COUNT", Kind: dataeng.UnsignedDisplay, Digits: 2},
			{Path: "ORDER.LINES", Kind: dataeng.Group, Occurs: dataeng.UpTo(4, "ORDER.LINE-COUNT"), Children: []*dataeng.Node{
				{Path: "ORDER.LINES.SKU", Kind: dataeng.UnsignedDisplay, Digits: 3},
				{Path: "ORDER.LINES.PRICE", Kind: dataeng.SignedPacked, Digits: 5, Scale: 2},
			}},
		},
	}}

	layout, err := dataeng.Compile(ast)
	if err != nil {
		log.Fatal(err)
	}

	// Two lines: SKU 001 at 1.23, SKU 002 at 4.50. Packed values are supplied
	// directly by the host's parser; the decoder never sees COBOL text.
	recordBytes := []byte{
		'0', '2',
		'0', '0', '1', 0x00, 0x12, 0x3c,
		'0', '0', '2', 0x00, 0x45, 0x0c,
	}

	record, err := layout.Decode(recordBytes, dataeng.DecodeOptions{MaxLeaves: 100})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("decoded %d bytes, %d expanded leaves\n", record.Size, record.Leaves)
	skus := record.Find("ORDER.LINES.SKU")
	prices := record.Find("ORDER.LINES.PRICE")
	for i, line := range skus {
		price := prices[i]
		fmt.Printf("line %d: SKU=%s price=%s\n",
			i, line.Value.String(), price.Value.String())
		fmt.Printf("  SKU bytes  [%d,%d) %s\n", line.Start, line.End, line.Value.Bytes)
		fmt.Printf("  price bytes [%d,%d) %x\n", price.Value.Start, price.Value.End, price.Value.Bytes)
	}

	fmt.Printf("min/max record size: %d/%d\n", layout.MinSize(), layout.MaxSize())
}
