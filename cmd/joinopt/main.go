package main

import (
	"os"

	"joinopt"
)

func main() {
	os.Exit(joinopt.RunCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}
