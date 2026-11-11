package q216

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

const sha256Size = 32

// manifest is a fully validated targets document.
type manifest struct {
	env     *parsedEnvelope
	doc     *SignedManifest
	expires time.Time
	targets map[string]TargetFile
}

// compileManifest validates a parsed envelope against the manifest schema,
// including target length and SHA-256 references.
func compileManifest(env *parsedEnvelope) (*manifest, error) {
	docType, err := requireString(env.signed, "type")
	if err != nil {
		return nil, err
	}
	if docType != typeManifest {
		return nil, fmt.Errorf("%w: expected type %q, got %q",
			ErrMalformed, typeManifest, docType)
	}
	version, err := requirePositiveInt(env.signed, "version")
	if err != nil {
		return nil, err
	}
	expiresRaw, err := requireString(env.signed, "expires")
	if err != nil {
		return nil, err
	}
	expires, err := time.Parse(time.RFC3339, expiresRaw)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid expires timestamp: %v", ErrMalformed, err)
	}

	var doc SignedManifest
	if err := strictUnmarshal(env.signed, &doc); err != nil {
		return nil, classifySchemaError(err)
	}
	doc.Version = version

	targets := make(map[string]TargetFile, len(doc.Targets))
	for _, target := range doc.Targets {
		if target.Name == "" {
			return nil, fmt.Errorf("%w: target entries require a name", ErrMalformed)
		}
		if _, dup := targets[target.Name]; dup {
			return nil, fmt.Errorf("%w: target %q listed more than once",
				ErrDuplicateKey, target.Name)
		}
		if target.Length < 0 {
			return nil, fmt.Errorf("%w: target %q has negative length",
				ErrMalformed, target.Name)
		}
		if target.Version <= 0 {
			return nil, fmt.Errorf("%w: target %q version must be positive",
				ErrMalformed, target.Name)
		}
		digest, ok := target.Hashes["sha256"]
		if !ok || digest == "" {
			return nil, fmt.Errorf("%w: target %q must reference a sha256 hash",
				ErrMalformed, target.Name)
		}
		rawDigest, err := hex.DecodeString(digest)
		if err != nil || len(rawDigest) != sha256Size {
			return nil, fmt.Errorf("%w: target %q has an invalid sha256 hash",
				ErrMalformed, target.Name)
		}
		targets[target.Name] = target
	}

	return &manifest{
		env:     env,
		doc:     &doc,
		expires: expires,
		targets: targets,
	}, nil
}

// checkNotExpired enforces the expiry boundary: metadata is valid while
// now.Before(expires); the expiry instant itself is expired.
func checkNotExpired(expires, now time.Time) error {
	if !now.Before(expires) {
		return fmt.Errorf("%w: metadata expired at %s (now %s)",
			ErrExpired, expires.UTC().Format(time.RFC3339),
			now.UTC().Format(time.RFC3339))
	}
	return nil
}

// classifySchemaError maps encoding/json unknown-field errors onto the
// component's own sentinel.
func classifySchemaError(err error) error {
	if isUnknownFieldError(err) {
		return fmt.Errorf("%w: %v", ErrUnknownField, err)
	}
	return fmt.Errorf("%w: %v", ErrMalformed, err)
}

func isUnknownFieldError(err error) bool {
	return strings.Contains(err.Error(), "unknown field")
}

// State is the persisted verifier state. The root and the accepted manifest
// version always advance together within a single atomic Store write.
type State struct {
	// RootVersion is the version of the trusted root metadata.
	RootVersion int64 `json:"rootVersion"`
	// Root is the raw trusted root envelope.
	Root []byte `json:"root"`
	// ManifestVersion is the highest accepted manifest version; zero means
	// no manifest has been accepted yet.
	ManifestVersion int64 `json:"manifestVersion"`
}

// Clone returns an independent copy of the state.
func (s *State) Clone() *State {
	if s == nil {
		return nil
	}
	cp := *s
	cp.Root = append([]byte(nil), s.Root...)
	return &cp
}

// Store abstracts durable state storage so the verifier can be injected
// with any persistence backend.
type Store interface {
	// Load returns the current state. A missing initial state must return
	// ErrUninitialized.
	Load(ctx context.Context) (*State, error)
	// Save atomically replaces the persisted state.
	Save(ctx context.Context, state *State) error
}

// Option customizes an Updater.
type Option func(*Updater)

// WithClock injects a clock, mainly for deterministic expiry testing.
func WithClock(now func() time.Time) Option {
	return func(u *Updater) {
		if now != nil {
			u.now = now
		}
	}
}

// Updater verifies signed roots and manifests against injected persistent
// state. All state transitions are atomic: a failed verification leaves the
// previously accepted root and manifest version untouched.
type Updater struct {
	store Store
	now   func() time.Time
}

// NewUpdater builds an Updater backed by store.
func NewUpdater(store Store, opts ...Option) *Updater {
	u := &Updater{
		store: store,
		now:   time.Now,
	}
	for _, opt := range opts {
		opt(u)
	}
	return u
}

// loadTrusted loads state and re-compiles the stored root.
func (u *Updater) loadTrusted(ctx context.Context) (*State, *trustedRoot, error) {
	state, err := u.store.Load(ctx)
	if err != nil {
		return nil, nil, err
	}
	env, err := parseEnvelope(state.Root)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: persisted root is unreadable: %v", ErrPersist, err)
	}
	root, err := compileRoot(env)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: persisted root is invalid: %v", ErrPersist, err)
	}
	// A trusted root that has passed its expiry must no longer authorize
	// any further metadata operations until it is replaced out of band.
	if err := checkNotExpired(root.expires, u.now()); err != nil {
		return nil, nil, err
	}
	return state, root, nil
}

// Bootstrap installs the initial trusted root. The root must be
// self-signed by its own root-role key set at or above its root threshold,
// be unexpired and carry a positive version.
func (u *Updater) Bootstrap(ctx context.Context, rawRoot []byte) (*SignedRoot, error) {
	if existing, err := u.store.Load(ctx); err == nil && existing != nil {
		return nil, fmt.Errorf("%w: state is already bootstrapped at root version %d",
			ErrPersist, existing.RootVersion)
	} else if !errors.Is(err, ErrUninitialized) {
		return nil, err
	}

	env, err := parseEnvelope(rawRoot)
	if err != nil {
		return nil, err
	}
	root, err := compileRoot(env)
	if err != nil {
		return nil, err
	}
	if err := checkNotExpired(root.expires, u.now()); err != nil {
		return nil, err
	}
	if err := root.verifySignatures(env, RoleRoot); err != nil {
		return nil, err
	}

	state := &State{
		RootVersion:     root.doc.Version,
		Root:            append([]byte(nil), rawRoot...),
		ManifestVersion: 0,
	}
	if err := u.store.Save(ctx, state); err != nil {
		return nil, err
	}
	return root.doc, nil
}

// UpdateRoot performs a root rotation. The candidate must:
//   - have a strictly greater version than the trusted root,
//   - be unexpired at the current time,
//   - satisfy the OLD root's root-role threshold, and
//   - satisfy the NEW (candidate) root's root-role threshold with its own
//     root-role key set.
//
// On any failure the persisted state is left untouched.
func (u *Updater) UpdateRoot(ctx context.Context, rawRoot []byte) (*SignedRoot, error) {
	state, oldRoot, err := u.loadTrusted(ctx)
	if err != nil {
		return nil, err
	}

	env, err := parseEnvelope(rawRoot)
	if err != nil {
		return nil, err
	}
	newRoot, err := compileRoot(env)
	if err != nil {
		return nil, err
	}
	if newRoot.doc.Version <= state.RootVersion {
		return nil, fmt.Errorf("%w: new root version %d is not greater than trusted version %d",
			ErrVersionRollback, newRoot.doc.Version, state.RootVersion)
	}
	if err := checkNotExpired(newRoot.expires, u.now()); err != nil {
		return nil, err
	}

	// The old root must authorize the rotation using its own root keys.
	if err := oldRoot.verifySignatures(env, RoleRoot); err != nil {
		return nil, fmt.Errorf("%w: old-root authorization failed: %v",
			ErrRootRotation, err)
	}
	// The new root must also be self-signed under its own root threshold.
	if err := newRoot.verifySignatures(env, RoleRoot); err != nil {
		return nil, fmt.Errorf("%w: new-root self-signature insufficient: %v",
			ErrRootRotation, err)
	}

	next := state.Clone()
	next.RootVersion = newRoot.doc.Version
	next.Root = append([]byte(nil), rawRoot...)
	if err := u.store.Save(ctx, next); err != nil {
		return nil, err
	}
	return newRoot.doc, nil
}

// UpdateManifest accepts a download manifest only when it is signed by the
// trusted root's targets role, is unexpired and carries a version strictly
// greater than the highest accepted manifest version. A rejected manifest
// never lowers the persisted version.
func (u *Updater) UpdateManifest(ctx context.Context, rawManifest []byte) (*SignedManifest, error) {
	state, root, err := u.loadTrusted(ctx)
	if err != nil {
		return nil, err
	}

	env, err := parseEnvelope(rawManifest)
	if err != nil {
		return nil, err
	}
	m, err := compileManifest(env)
	if err != nil {
		return nil, err
	}
	if m.doc.Version <= state.ManifestVersion {
		return nil, fmt.Errorf("%w: manifest version %d is not greater than accepted version %d",
			ErrVersionRollback, m.doc.Version, state.ManifestVersion)
	}
	if err := checkNotExpired(m.expires, u.now()); err != nil {
		return nil, err
	}
	if err := root.verifySignatures(env, RoleTargets); err != nil {
		return nil, err
	}

	next := state.Clone()
	next.ManifestVersion = m.doc.Version
	// Root and the new version record advance in the same atomic write.
	if err := u.store.Save(ctx, next); err != nil {
		return nil, err
	}
	return m.doc, nil
}

// VerifyTarget streams content and checks it against a manifest target's
// exact length and SHA-256 digest. The manifest is re-verified against the
// trusted targets role before its references are used.
func (u *Updater) VerifyTarget(ctx context.Context, rawManifest []byte, targetName string, content io.Reader) error {
	_, root, err := u.loadTrusted(ctx)
	if err != nil {
		return err
	}
	env, err := parseEnvelope(rawManifest)
	if err != nil {
		return err
	}
	m, err := compileManifest(env)
	if err != nil {
		return err
	}
	if err := checkNotExpired(m.expires, u.now()); err != nil {
		return err
	}
	if err := root.verifySignatures(env, RoleTargets); err != nil {
		return err
	}
	target, ok := m.targets[targetName]
	if !ok {
		return fmt.Errorf("%w: target %q is not in the manifest", ErrTargetMismatch, targetName)
	}

	h := sha256.New()
	n, err := io.Copy(h, content)
	if err != nil {
		return fmt.Errorf("%w: reading target content: %v", ErrTargetMismatch, err)
	}
	if n != target.Length {
		return fmt.Errorf("%w: target %q length is %d, expected %d",
			ErrTargetMismatch, targetName, n, target.Length)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != target.Hashes["sha256"] {
		return fmt.Errorf("%w: target %q sha256 %s does not match expected %s",
			ErrTargetMismatch, targetName, got, target.Hashes["sha256"])
	}
	return nil
}

// State returns a copy of the currently persisted state.
func (u *Updater) State(ctx context.Context) (*State, error) {
	state, err := u.store.Load(ctx)
	if err != nil {
		return nil, err
	}
	return state.Clone(), nil
}
