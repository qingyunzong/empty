// Command auditlog appends checksummed frames to an audit log, verifies
// and recovers it, and maintains a lagging sequence-number index.
package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"auditlog"
)

const usage = `usage: auditlog <command> [args]

commands:
  append  <log> <seq> <payload...>  append one frame (payload joined with spaces)
  list    <log>                     print seq and payload of every valid frame
  verify  <log>                     check all frames; report torn tail, fail on corruption
  recover <log>                     truncate an incomplete tail frame; never rewrites corruption
  reindex <log>                     rebuild <log>.idx from scratch, detecting conflicting seqs
`

func fail(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "append":
		if len(args) < 3 {
			fmt.Fprint(os.Stderr, usage)
			os.Exit(2)
		}
		seq, err := strconv.ParseUint(args[1], 10, 64)
		if err != nil {
			fail(fmt.Errorf("bad seq: %w", err))
		}
		payload := []byte(args[2])
		for _, p := range args[3:] {
			payload = append(payload, ' ')
			payload = append(payload, p...)
		}
		off, err := auditlog.Append(args[0], seq, payload)
		if err != nil {
			fail(err)
		}
		// Best-effort index update: the index is allowed to lag the log,
		// so failures here are warnings, not errors.
		idxPath := auditlog.IndexPath(args[0])
		if idx, ierr := auditlog.LoadIndex(idxPath); ierr == nil {
			if uerr := idx.Update(auditlog.Entry{Seq: seq, Offset: off}); uerr == nil {
				idx.Covered = off + int64(auditlog.HeaderLen+len(payload)+auditlog.CRCLen)
				ierr = idx.Save(idxPath)
			} else {
				ierr = uerr
			}
			if ierr != nil {
				fmt.Fprintln(os.Stderr, "warning: index not updated (lagging):", ierr)
			}
		} else {
			fmt.Fprintln(os.Stderr, "warning: index not updated (lagging):", ierr)
		}
		fmt.Printf("appended seq=%d offset=%d bytes=%d\n", seq, off, len(payload))
	case "list":
		requireArgs(args, 1)
		entries, truncated, err := auditlog.Verify(args[0])
		if err != nil {
			fail(err)
		}
		for _, e := range entries {
			fmt.Printf("%d\t%s\n", e.Seq, e.Payload)
		}
		if truncated {
			fmt.Fprintln(os.Stderr, "warning: incomplete tail frame present (run recover)")
		}
	case "verify":
		requireArgs(args, 1)
		entries, truncated, err := auditlog.Verify(args[0])
		if err != nil {
			fail(err)
		}
		fmt.Printf("ok: %d frames\n", len(entries))
		if truncated {
			fmt.Fprintln(os.Stderr, "warning: incomplete tail frame present (run recover)")
		}
	case "recover":
		requireArgs(args, 1)
		truncated, newLen, err := auditlog.Recover(args[0])
		if err != nil {
			if auditlog.IsCorrupt(err) {
				fmt.Fprintln(os.Stderr, "corruption detected; file left unmodified")
			}
			fail(err)
		}
		if truncated {
			fmt.Printf("truncated incomplete tail; new length %d\n", newLen)
		} else {
			fmt.Printf("no recovery needed; length %d\n", newLen)
		}
	case "reindex":
		requireArgs(args, 1)
		idx, err := auditlog.Rebuild(args[0])
		if err != nil {
			var dup *auditlog.DuplicateSeqError
			if errors.As(err, &dup) {
				fmt.Fprintln(os.Stderr, "conflicting duplicate sequence numbers; index not written")
			}
			fail(err)
		}
		if err := idx.Save(auditlog.IndexPath(args[0])); err != nil {
			fail(err)
		}
		fmt.Printf("rebuilt index: %d entries, covers %d log bytes\n", len(idx.Offsets), idx.Covered)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func requireArgs(args []string, n int) {
	if len(args) < n {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}
