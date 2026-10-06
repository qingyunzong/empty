package main

import (
	"os"

	"crashreplay"
)

func main() {
	os.Exit(crashreplay.Run(os.Args[1:], os.Stdout))
}
