// Command host demonstrates wiring the dataeng decoder into a data-import
// host. It is not a SAV parser; it only owns the closed S8 data region.
package main

import (
	"fmt"
	"log"

	de "example.org/dataeng/q0320"
	"example.org/dataeng/q0320/internal/s8fixture"
)

func main() {
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("id"),
			de.BytesField("name", 12),
			de.NumericField("score"),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       10,
		RowByteBudget: 64,
		Projection:    []string{"score", "name"},
	}

	// Build a tiny physical region for the example. A real host would receive
	// these bytes from its file reader.
	b := s8fixture.New(s8fixture.Little)
	check(b.AddCode(42, cfg.Bias)) // id = 42
	check(b.AddBytesLiteral([8]byte{'A', 'd', 'a', ' ', 'L', 'o', 'v', 'e'}))
	check(b.AddBytesLiteral([8]byte{'l', 'a', 'c', 'e', ' ', ' ', ' ', ' '}))
	check(b.AddNumericLiteral(0x8000000000000000)) // score = -0
	check(b.AddTerminator())
	data, _, err := b.Encode()
	if err != nil {
		log.Fatal(err)
	}

	d, err := de.NewDecoder(cfg)
	if err != nil {
		log.Fatal(err)
	}

	// Hosts can hand the region to Push in arbitrary slices.
	for _, chunk := range [][]byte{data[:3], data[3:9], data[9:15], data[15:]} {
		rows, err := d.Push(chunk)
		if err != nil {
			log.Fatal(err)
		}
		for _, row := range rows {
			for _, value := range row.Values {
				switch value.Kind {
				case de.Numeric:
					fmt.Printf("%s: missing=%t bits=0x%016x source=group %d code %d\n",
						value.Field, value.Missing, value.Bits,
						value.Source.GroupOffset, value.Source.CodeIndex)
				case de.Bytes:
					fmt.Printf("%s: %q source=%d fragments\n",
						value.Field, value.Data, len(value.Fragments))
					for _, f := range value.Fragments {
						fmt.Printf("  fragment %q group %d code %d literal [%d,%d)\n",
							f.Data, f.Source.GroupOffset, f.Source.CodeIndex,
							f.Source.LiteralOffset, f.Source.LiteralOffset+int64(f.Source.LiteralLength))
					}
				}
			}
		}
	}
	if err := d.Finish(); err != nil {
		log.Fatal(err)
	}
	fmt.Println("complete:", d.Complete(), "rows:", d.RowsDecoded())
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
