package quorum

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

const usage = `usage: quorumcli <command> [flags]

commands:
  quorum         find a minimum-cost legal quorum (weight majority + domain spread)
  pair           find a minimum-cost read/write quorum pair resilient to single faults
  verify-quorum  verify a quorum certificate against the input
  verify-pair    verify a read/write pair certificate against the input

flags:
  -f file     read input JSON from file (default: stdin)
  -cert file  read certificate JSON from file (required by verify commands)
`

// RunCLI executes the quorumcli command line. It returns a non-nil error
// on failure; callers decide the exit code.
func RunCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return fmt.Errorf("missing command")
	}
	cmd := args[0]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(stderr)
	inputPath := fs.String("f", "", "read input JSON from `file` (default: stdin)")
	certPath := fs.String("cert", "", "read certificate JSON from `file`")
	if err := fs.Parse(args[1:]); err != nil {
		return err
	}

	readInput := func() (*Input, error) {
		var data []byte
		var err error
		if *inputPath == "" {
			data, err = io.ReadAll(stdin)
		} else {
			data, err = os.ReadFile(*inputPath)
		}
		if err != nil {
			return nil, fmt.Errorf("reading input: %w", err)
		}
		return ParseInput(data)
	}
	encode := func(v interface{}) error {
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(v)
	}

	switch cmd {
	case "quorum", "pair":
		in, err := readInput()
		if err != nil {
			return err
		}
		if cmd == "quorum" {
			cert, err := SolveQuorum(in)
			if err != nil {
				return err
			}
			return encode(cert)
		}
		cert, err := SolvePair(in)
		if err != nil {
			return err
		}
		return encode(cert)
	case "verify-quorum", "verify-pair":
		if *certPath == "" {
			return fmt.Errorf("%s: -cert is required", cmd)
		}
		in, err := readInput()
		if err != nil {
			return err
		}
		data, err := os.ReadFile(*certPath)
		if err != nil {
			return fmt.Errorf("reading certificate: %w", err)
		}
		if cmd == "verify-quorum" {
			var cert QuorumCertificate
			if err := json.Unmarshal(data, &cert); err != nil {
				return fmt.Errorf("decoding certificate: %w", err)
			}
			if err := VerifyQuorum(in, &cert); err != nil {
				return err
			}
		} else {
			var cert PairCertificate
			if err := json.Unmarshal(data, &cert); err != nil {
				return fmt.Errorf("decoding certificate: %w", err)
			}
			if err := VerifyPair(in, &cert); err != nil {
				return err
			}
		}
		return encode(map[string]bool{"valid": true})
	default:
		fmt.Fprint(stderr, usage)
		return fmt.Errorf("unknown command %q", cmd)
	}
}
