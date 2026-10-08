// Command demo runs the checker on a sample program with branches, a
// loop and an exceptional exit, printing every violating path.
package main

import (
	"fmt"

	"rescheck"
)

func main() {
	prog := rescheck.Seq{
		rescheck.New{Name: "conn"},
		rescheck.If{
			Then: rescheck.Seq{rescheck.Move{Dst: "c2", Src: "conn"}, rescheck.Consume{Name: "c2"}},
			Else: rescheck.Seq{rescheck.Consume{Name: "conn"}, rescheck.Consume{Name: "conn"}}, // double consume
		},
		rescheck.While{Body: rescheck.Seq{
			rescheck.New{Name: "buf"},
			rescheck.If{
				Then: rescheck.Seq{rescheck.Consume{Name: "buf"}},
				Else: rescheck.Seq{}, // buf leaks on this arm
			},
		}},
		rescheck.If{
			Then: rescheck.Seq{rescheck.New{Name: "tmp"}, rescheck.Throw{}}, // throws with live tmp
			Else: rescheck.Seq{},
		},
	}
	for _, v := range rescheck.Check(prog) {
		fmt.Println("VIOLATION:", v)
	}
}
