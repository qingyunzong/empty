// Command rescheck runs the resource-protocol checker on two demo
// programs and prints the violating paths it finds.
package main

import (
	"fmt"

	"rescheck"
)

// Clean: the resource is consumed on every path, including the loop.
func cleanProgram() *rescheck.Program {
	p := rescheck.NewProgram()
	entry := p.Block("entry", rescheck.New("conn"))
	loop := p.Block("loop", rescheck.Use("conn"), rescheck.New("conn"))
	exit := p.Block("exit", rescheck.Use("conn"), rescheck.Ret())
	rescheck.Link(entry, loop)
	rescheck.Link(loop, loop)
	rescheck.Link(loop, exit)
	return p
}

// Buggy: consumed only on one branch, moved then used, and still live
// at a panic exit.
func buggyProgram() *rescheck.Program {
	p := rescheck.NewProgram()
	entry := p.Block("entry", rescheck.New("conn"))
	then := p.Block("then", rescheck.Use("conn"))
	els := p.Block("else", rescheck.Move("other", "conn"))
	merge := p.Block("merge", rescheck.Use("conn"))
	fail := p.Block("fail", rescheck.Panic())
	rescheck.Link(entry, then)
	rescheck.Link(entry, els)
	rescheck.Link(then, merge)
	rescheck.Link(els, merge)
	rescheck.Link(merge, fail)
	return p
}

func main() {
	for name, p := range map[string]*rescheck.Program{
		"clean": cleanProgram(),
		"buggy": buggyProgram(),
	} {
		fmt.Printf("=== program %q ===\n", name)
		fmt.Print(rescheck.Diagnose(p, 3).Report())
		fmt.Println()
	}
}
