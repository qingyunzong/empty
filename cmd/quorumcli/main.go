package main

import (
	"fmt"
	"os"

	"quorumcli/quorum"
)

func main() {
	if err := quorum.RunCLI(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
