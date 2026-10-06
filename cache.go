// Package execcache provides a content-addressed execution cache.
//
// A cache key is derived from the task inputs, the source code, the
// command, and a digest of the environment. Runs with an identical key
// share a single execution and its result; changing any part of the key
// (e.g. a version switch in source or environment) produces a new key
// and forces re-execution. Failed executions are never cached.
// Cancellation is reference-counted: the upstream execution is only
// stopped when the last waiter for an in-flight call cancels.
package execcache

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
	"sync"
)

// Request describes a unit of work to execute and cache.
type Request struct {
	// Inputs are the task inputs (e.g. file contents or parameters).
	Inputs map[string]string
	// Source is the source code (or its digest) the task operates on.
	Source string
	// Command is the command line to execute.
	Command []string
	// Env is the environment the command runs under.
	Env map[string]string
}

// Key returns the content-addressed cache key for the request. Any
// change to inputs, source, command, or environment yields a new key.
func (r Request) Key() string {
	h := sha256.New()
	writeStringMap(h, r.Inputs)
	writeString(h, r.Source)
	writeStringSlice(h, r.Command)
	writeStringMap(h, r.Env)
	return hex.EncodeToString(h.Sum(nil))
}

func writeString(h interface{ Write([]byte) (int, error) }, s string) {
	var lenBuf [8]byte
	binary.LittleEndian.PutUint64(lenBuf[:], uint64(len(s)))
	h.Write(lenBuf[:])
	h.Write([]byte(s))
}

func writeStringSlice(h interface{ Write([]byte) (int, error) }, ss []string) {
	var lenBuf [8]byte
	binary.LittleEndian.PutUint64(lenBuf[:], uint64(len(ss)))
	h.Write(lenBuf[:])
	for _, s := range ss {
		writeString(h, s)
	}
}

func writeStringMap(h interface{ Write([]byte) (int, error) }, m map[string]string) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var lenBuf [8]byte
	binary.LittleEndian.PutUint64(lenBuf[:], uint64(len(keys)))
	h.Write(lenBuf[:])
	for _, k := range keys {
		writeString(h, k)
		writeString(h, m[k])
	}
}

// Result is the outcome of a successful execution.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

func (r Result) clone() Result {
	return Result{
		Stdout:   append([]byte(nil), r.Stdout...),
		Stderr:   append([]byte(nil), r.Stderr...),
		ExitCode: r.ExitCode,
	}
}

// Executor runs a request. Implementations must honor ctx cancellation.
type Executor interface {
	Execute(ctx context.Context, req Request) (Result, error)
}

// ExecutorFunc adapts a function to the Executor interface.
type ExecutorFunc func(ctx context.Context, req Request) (Result, error)

// Execute calls f(ctx, req).
func (f ExecutorFunc) Execute(ctx context.Context, req Request) (Result, error) {
	return f(ctx, req)
}

// call tracks an in-flight execution and its waiters.
type call struct {
	done    chan struct{}
	res     Result
	err     error
	cancel  context.CancelFunc
	waiters int
}

// Cache deduplicates and memoizes executions by request key.
type Cache struct {
	mu       sync.Mutex
	entries  map[string]Result
	inflight map[string]*call
}

// New returns an empty Cache.
func New() *Cache {
	return &Cache{
		entries:  make(map[string]Result),
		inflight: make(map[string]*call),
	}
}

// Do returns the result for req, executing it with exec if necessary.
//
// Concurrent calls with the same key share one execution. A cached
// result is only reused when the full key (inputs, source, command,
// environment digest) matches. Errors are never cached. If ctx is
// canceled, the caller stops waiting; the upstream execution is
// canceled only when its last remaining waiter goes away.
func (c *Cache) Do(ctx context.Context, req Request, exec Executor) (Result, error) {
	key := req.Key()

	c.mu.Lock()
	if res, ok := c.entries[key]; ok {
		c.mu.Unlock()
		return res.clone(), nil
	}
	if cl, ok := c.inflight[key]; ok {
		cl.waiters++
		c.mu.Unlock()
		return c.wait(ctx, key, cl)
	}
	execCtx, cancel := context.WithCancel(context.Background())
	cl := &call{done: make(chan struct{}), cancel: cancel, waiters: 1}
	c.inflight[key] = cl
	c.mu.Unlock()

	go func() {
		res, err := exec.Execute(execCtx, req)
		c.mu.Lock()
		if c.inflight[key] == cl {
			delete(c.inflight, key)
		}
		if err == nil {
			c.entries[key] = res.clone()
		}
		cl.res, cl.err = res, err
		close(cl.done)
		c.mu.Unlock()
	}()

	return c.wait(ctx, key, cl)
}

func (c *Cache) wait(ctx context.Context, key string, cl *call) (Result, error) {
	select {
	case <-cl.done:
		c.mu.Lock()
		cl.waiters--
		c.mu.Unlock()
		return cl.res.clone(), cl.err
	case <-ctx.Done():
		c.mu.Lock()
		cl.waiters--
		last := cl.waiters == 0
		if last {
			// No one is left to consume the result: stop the
			// upstream work and detach the call so future
			// callers start a fresh execution.
			if c.inflight[key] == cl {
				delete(c.inflight, key)
			}
		}
		c.mu.Unlock()
		if last {
			cl.cancel()
		}
		return Result{}, ctx.Err()
	}
}
