package main

import (
	"fmt"
	"io"
	"os"

	"ticketlog"
)

func main() {
	var data []byte
	var err error
	if len(os.Args) > 1 {
		data, err = os.ReadFile(os.Args[1])
	} else {
		data, err = io.ReadAll(os.Stdin)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "read log:", err)
		os.Exit(2)
	}
	events, err := ticketlog.Parse(string(data))
	if err != nil {
		fmt.Fprintln(os.Stderr, "parse log:", err)
		os.Exit(2)
	}
	if verr := ticketlog.Check(events); verr != nil {
		fmt.Print(verr.Detail())
		os.Exit(1)
	}
	fmt.Printf("OK: %d events, log is valid\n", len(events))
}
