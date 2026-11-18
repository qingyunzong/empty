package formal

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"time"
)

// Update is one candidate revision emitted by a Source.
//
// Token optionally identifies the source revision (for example a file hash or
// an etcd revision). A non-empty token that matches the last successfully
// applied token is ignored. Err reports a source or decode failure; it is
// recorded as a rejection and never changes the published configuration.
type Update struct {
	Parts []Part
	Token string
	Err   error
}

// Source emits configuration updates until the context is cancelled or the
// update channel is closed.
type Source interface {
	Watch(ctx context.Context) (<-chan Update, error)
}

// SourceFunc adapts a function to the Source interface.
type SourceFunc func(ctx context.Context) (<-chan Update, error)

// Watch implements Source.
func (f SourceFunc) Watch(ctx context.Context) (<-chan Update, error) {
	if f == nil {
		return nil, errors.New("formal: nil source function")
	}
	return f(ctx)
}

// Watch consumes updates from src until ctx is done or src closes its channel.
// A rejected candidate does not stop the watch loop: a later valid update can
// still be published.
func (m *Manager) Watch(ctx context.Context, src Source) error {
	if src == nil {
		return errors.New("formal: nil source")
	}
	updates, err := src.Watch(ctx)
	if err != nil {
		return fmt.Errorf("formal: start source: %w", err)
	}
	return m.WatchUpdates(ctx, updates)
}

// WatchUpdates consumes a stream of updates. Updates are applied serially, so
// they commit in channel order.
func (m *Manager) WatchUpdates(ctx context.Context, updates <-chan Update) error {
	var lastToken string
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case update, ok := <-updates:
			if !ok {
				return nil
			}
			if update.Err != nil {
				m.ReportRejection(update.Parts, update.Err)
				continue
			}
			if update.Token != "" && update.Token == lastToken {
				continue
			}
			if _, err := m.Apply(update.Parts); err != nil {
				continue
			}
			if update.Token != "" {
				lastToken = update.Token
			}
		}
	}
}

// FileSource polls a configuration file and emits a new update whenever its
// contents change. Polling is used instead of platform-specific file
// notifications so the source stays dependency-free and portable.
type FileSource struct {
	Path     string
	Decode   func([]byte) ([]Part, error)
	Interval time.Duration
}

// Watch implements Source. The current file contents are emitted immediately,
// then re-read at Interval. Decode errors are delivered through Update.Err and
// are retried when the file contents change.
func (f *FileSource) Watch(ctx context.Context) (<-chan Update, error) {
	if f == nil || f.Path == "" {
		return nil, errors.New("formal: file source has no path")
	}
	decode := f.Decode
	if decode == nil {
		decode = DecodeJSON
	}
	interval := f.Interval
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}

	updates := make(chan Update, 1)
	go func() {
		defer close(updates)

		send := func(update Update) bool {
			select {
			case updates <- update:
				return true
			case <-ctx.Done():
				return false
			}
		}

		var last string
		emit := func() bool {
			data, err := os.ReadFile(f.Path)
			if err != nil {
				token := "read:" + err.Error()
				if token == last {
					return true
				}
				last = token
				return send(Update{Token: token, Err: err})
			}

			sum := sha256.Sum256(data)
			token := hex.EncodeToString(sum[:])
			if token == last {
				return true
			}
			last = token

			parts, err := decode(data)
			if err != nil {
				return send(Update{Token: token, Err: err})
			}
			return send(Update{Parts: parts, Token: token})
		}

		if !emit() {
			return
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !emit() {
					return
				}
			}
		}
	}()
	return updates, nil
}

// DecodeJSON decodes a JSON object into one Part per top-level member.
// Numbers are decoded as json.Number to avoid precision loss.
func DecodeJSON(data []byte) ([]Part, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()

	var object map[string]any
	if err := decoder.Decode(&object); err != nil {
		return nil, fmt.Errorf("decode JSON object: %w", err)
	}
	if object == nil {
		return nil, errors.New("decode JSON object: expected an object")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("decode JSON object: trailing value")
		}
		return nil, fmt.Errorf("decode JSON object: %w", err)
	}

	names := make([]string, 0, len(object))
	for name := range object {
		names = append(names, name)
	}
	sort.Strings(names)

	parts := make([]Part, len(names))
	for i, name := range names {
		parts[i] = Part{Name: name, Value: object[name]}
	}
	return parts, nil
}
