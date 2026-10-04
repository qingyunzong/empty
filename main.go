package main

import (
	"flag"
	"fmt"
	"os"
)

const demoSpec = `{
  "name": "demo-release-1.4",
  "branches": ["login", "logout", "checkout", "refund", "search", "profile"],
  "features": {
    "os": ["linux", "windows"],
    "browser": ["chrome", "firefox"],
    "db": ["postgres", "mysql"]
  },
  "time_limit": 100,
  "tests": [
    {"name": "t00-setup-auth",  "cost": 2,  "duration": 5,  "branches": ["login", "logout"]},
    {"name": "t01-smoke-linux", "cost": 6,  "duration": 20, "requires": ["t00-setup-auth"],
     "branches": ["checkout"], "assign": {"os": "linux", "browser": "chrome", "db": "postgres"}},
    {"name": "t02-smoke-win",   "cost": 6,  "duration": 20, "requires": ["t00-setup-auth"],
     "branches": ["refund"],   "assign": {"os": "windows", "browser": "firefox", "db": "mysql"}},
    {"name": "t03-cross-lf",    "cost": 5,  "duration": 15, "assign": {"os": "linux", "browser": "firefox"}},
    {"name": "t04-cross-wc",    "cost": 5,  "duration": 15, "assign": {"os": "windows", "browser": "chrome"}},
    {"name": "t05-db-lmy",      "cost": 4,  "duration": 10, "assign": {"os": "linux", "db": "mysql"}},
    {"name": "t06-db-wpg",      "cost": 4,  "duration": 10, "assign": {"os": "windows", "db": "postgres"}},
    {"name": "t07-db-cmy",      "cost": 4,  "duration": 10, "assign": {"browser": "chrome", "db": "mysql"}},
    {"name": "t08-db-fpg",      "cost": 4,  "duration": 10, "assign": {"browser": "firefox", "db": "postgres"}},
    {"name": "t09-profile-win", "cost": 9,  "duration": 25, "branches": ["profile"],
     "assign": {"os": "windows", "browser": "chrome", "db": "postgres"}},
    {"name": "t10-search-lin",  "cost": 7,  "duration": 15, "branches": ["search"],
     "assign": {"os": "linux", "browser": "firefox", "db": "mysql"}},
    {"name": "t11-refund-win",  "cost": 7,  "duration": 15, "requires": ["t00-setup-auth"],
     "branches": ["refund"],   "assign": {"os": "windows", "browser": "firefox", "db": "mysql"}}
  ]
}
`

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "solve":
		cmdSolve(os.Args[2:])
	case "check":
		cmdCheck(os.Args[2:])
	case "example":
		fmt.Print(string(demoSpec))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `testplan - exact test-selection planner

Usage:
  testplan solve -f spec.json [-cert out.json]   solve and print summary
  testplan check -f spec.json                    cross-check vs exhaustive search
  testplan example                               print a sample spec

The objective is lexicographic: minimize total cost, then test count.
`)
}

func cmdSolve(args []string) {
	fs := flag.NewFlagSet("solve", flag.ExitOnError)
	file := fs.String("f", "", "spec file (JSON)")
	cert := fs.String("cert", "", "write coverage certificate JSON to this path")
	fs.Parse(args)
	if *file == "" {
		fmt.Fprintln(os.Stderr, "solve: -f is required")
		os.Exit(2)
	}
	spec, err := loadSpec(*file)
	if err != nil {
		fatal(err)
	}
	m := compile(spec)
	res := solve(m)
	c := buildCertificate(m, res)
	fmt.Print(c.summary())
	if *cert != "" {
		js, err := c.json()
		if err != nil {
			fatal(err)
		}
		if err := os.WriteFile(*cert, []byte(js+"\n"), 0o644); err != nil {
			fatal(err)
		}
		fmt.Printf("certificate written to %s\n", *cert)
	}
	if !res.feasible {
		os.Exit(1)
	}
}

func cmdCheck(args []string) {
	fs := flag.NewFlagSet("check", flag.ExitOnError)
	file := fs.String("f", "", "spec file (JSON)")
	fs.Parse(args)
	if *file == "" {
		fmt.Fprintln(os.Stderr, "check: -f is required")
		os.Exit(2)
	}
	spec, err := loadSpec(*file)
	if err != nil {
		fatal(err)
	}
	m := compile(spec)
	fast := solve(m)
	brute := exhaustive(m)
	fmt.Printf("branch-and-bound: feasible=%v objective=(cost=%d,tests=%d) nodes=%d\n",
		fast.feasible, fast.obj.cost, fast.obj.count, fast.nodes)
	fmt.Printf("exhaustive:       feasible=%v objective=(cost=%d,tests=%d) nodes=%d\n",
		brute.feasible, brute.obj.cost, brute.obj.count, brute.nodes)
	if fast.feasible != brute.feasible || fast.obj != brute.obj {
		fmt.Println("MISMATCH: solver disagrees with exhaustive search")
		os.Exit(1)
	}
	fmt.Println("OK: solver matches exhaustive search")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
