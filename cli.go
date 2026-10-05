package joinopt

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"
)

// RunCLI runs the joinopt command and returns the process exit code.
func RunCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("joinopt", flag.ContinueOnError)
	fs.SetOutput(stderr)
	input := fs.String("input", "-", `input JSON file ("-" reads stdin)`)
	verify := fs.Bool("verify", false, "cross-check the optimum by enumerating all binary join trees (at most 9 tables)")
	noCerts := fs.Bool("no-certificates", false, "suppress the per-subtree certificate table")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	var r io.Reader = stdin
	if *input != "-" {
		f, err := os.Open(*input)
		if err != nil {
			fmt.Fprintf(stderr, "error: %v\n", err)
			return 2
		}
		defer f.Close()
		r = f
	}
	p, err := Parse(r)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}

	d := NewDP(p)
	best, ok := d.Optimal()
	if !ok {
		fmt.Fprintln(stdout, "no valid plan: the join graph is not connected")
		return 1
	}

	fmt.Fprintf(stdout, "tables: %d\nedges: %d\n\n", len(p.Names), len(p.Edges))
	fmt.Fprintf(stdout, "optimal cost: %s\n", best.Cost.RatString())
	fmt.Fprintf(stdout, "canonical plan: %s\n\n", best.Canon)

	fmt.Fprintln(stdout, "join order:")
	var steps []*Plan
	var post func(pl *Plan)
	post = func(pl *Plan) {
		if pl.Left == nil {
			return
		}
		post(pl.Left)
		post(pl.Right)
		steps = append(steps, pl)
	}
	post(best)
	tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
	for i, s := range steps {
		fmt.Fprintf(tw, "  %d.\t%s ⋈ %s\t-> est %s\tsubtree cost %s\n",
			i+1, s.Left.Canon, s.Right.Canon, d.Est[s.Mask].RatString(), s.Cost.RatString())
	}
	tw.Flush()

	if !*noCerts {
		fmt.Fprintln(stdout, "\ncertificates (every connected subtree):")
		tw := tabwriter.NewWriter(stdout, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "  tables\test\tbest cost\tbest plan")
		for _, c := range d.Certificates() {
			fmt.Fprintf(tw, "  {%s}\t%s\t%s\t%s\n",
				strings.Join(c.Tables, ", "), c.Est.RatString(), c.Cost.RatString(), c.Canon)
		}
		tw.Flush()
	}

	if *verify {
		if len(p.Names) > 9 {
			fmt.Fprintln(stderr, "error: -verify supports at most 9 tables")
			return 2
		}
		br := d.BruteForce()
		fmt.Fprintf(stdout, "\nverification: enumerated %d binary trees, %d satisfy the edge constraint\n",
			br.Trees, br.Valid)
		if br.Best == nil || br.Best.Cost.Cmp(best.Cost) != 0 || br.Best.Canon != best.Canon {
			fmt.Fprintln(stdout, "verification: FAIL")
			fmt.Fprintf(stdout, "  dp:    cost=%s plan=%s\n", best.Cost.RatString(), best.Canon)
			if br.Best != nil {
				fmt.Fprintf(stdout, "  brute: cost=%s plan=%s\n", br.Best.Cost.RatString(), br.Best.Canon)
			}
			return 1
		}
		fmt.Fprintln(stdout, "verification: PASS (exhaustive enumeration agrees with DP)")
	}
	return 0
}
