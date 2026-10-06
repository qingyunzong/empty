// Package execcache provides a content-addressed execution cache.
//
// A cache key is derived from the full task fingerprint: inputs, source
// code, command, and an environment summary. Runs sharing a key share a
// single execution and its result; changing any component of the
// fingerprint yields a different key and therefore never reuses a stale
// result. Failed executions are never cached, and the upstream execution
// is cancelled only when its last waiter goes away.
package execcache

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
)

// Request describes a task to execute. Every field participates in the
// cache key, so any change invalidates previously cached results.
type Request struct {
	// Inputs are named task inputs (e.g. file name -> content).
	Inputs map[string][]byte
	// Source is the source code (or its digest) the task operates on.
	Source []byte
	// Command is the argv used to run the task.
	Command []string
	// Env is the environment summary relevant to the task.
	Env map[string]string
}

// Key computes a canonical, collision-resistant fingerprint of r.
// Map iteration order does not affect the result.
func Key(r Request) string {
	h := sha256.New()
	var lenBuf [8]byte

	writeCount := func(n int) {
		binary.BigEndian.PutUint64(lenBuf[:], uint64(n))
		h.Write(lenBuf[:])
	}
	writeField := func(b []byte) {
		writeCount(len(b))
		h.Write(b)
	}

	inputNames := make([]string, 0, len(r.Inputs))
	for name := range r.Inputs {
		inputNames = append(inputNames, name)
	}
	sort.Strings(inputNames)
	writeCount(len(inputNames))
	for _, name := range inputNames {
		writeField([]byte(name))
		writeField(r.Inputs[name])
	}

	writeField(r.Source)

	writeCount(len(r.Command))
	for _, arg := range r.Command {
		writeField([]byte(arg))
	}

	envNames := make([]string, 0, len(r.Env))
	for name := range r.Env {
		envNames = append(envNames, name)
	}
	sort.Strings(envNames)
	writeCount(len(envNames))
	for _, name := range envNames {
		writeField([]byte(name))
		writeField([]byte(r.Env[name]))
	}

	return hex.EncodeToString(h.Sum(nil))
}
