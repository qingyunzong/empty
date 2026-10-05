package main

import (
	"flag"
	"fmt"
	"os"
)

func usage() {
	fmt.Fprintf(os.Stderr, `dirswap - crash-safe directory replacement for updaters

Usage:
  dirswap update  --target DIR --source DIR   replace target with source
  dirswap recover --target DIR                finish the pending transaction

A pending transaction (journal file next to the target) blocks new
updates; recover completes exactly that same transaction.
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "update":
		fs := flag.NewFlagSet("update", flag.ExitOnError)
		target := fs.String("target", "", "directory to replace")
		source := fs.String("source", "", "new directory tree")
		fs.Parse(os.Args[2:])
		if *target == "" || *source == "" {
			usage()
		}
		err = update(*target, *source)
	case "recover":
		fs := flag.NewFlagSet("recover", flag.ExitOnError)
		target := fs.String("target", "", "directory whose transaction to finish")
		fs.Parse(os.Args[2:])
		if *target == "" {
			usage()
		}
		err = recover(*target)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "dirswap: "+err.Error())
		os.Exit(1)
	}
}
