package graphtransform

import (
	"errors"
	"fmt"
	"math/rand"
)

// Verification errors returned by the independent verifier.
var (
	ErrIllegalTransform = errors.New("certificate contains an illegal transformation")
	ErrOutputMismatch   = errors.New("claimed output does not match the replayed chain")
	ErrInverseMismatch  = errors.New("inverse mapping of the claimed output does not restore the original graph")
	ErrSeedMismatch     = errors.New("certificate chain does not match the chain derived from the seed")
)

// NewCertificate generates a random legal chain of nSteps transformations
// for g and returns the resulting graph, the public result mapping, and a
// certificate recording the seed and the chain.
func NewCertificate(g *Graph, seed int64, nSteps int) (*Graph, *Mapping, Certificate, error) {
	chain := RandomChain(rand.New(rand.NewSource(seed)), g, nSteps)
	out, m, err := chain.Apply(g)
	if err != nil {
		return nil, nil, Certificate{}, err
	}
	return out, m, Certificate{Seed: seed, Chain: chain}, nil
}

// Verify independently judges whether claimed is the genuine result of
// applying the certificate's chain to orig. It does not trust any output
// produced alongside the chain: it replays the chain from orig, compares
// the result with claimed, then maps claimed back through the inverse
// chain and checks that the original graph is restored. Any illegal
// transformation or mismatch is explicitly rejected.
func Verify(orig, claimed *Graph, cert Certificate) error {
	if orig == nil || claimed == nil {
		return fmt.Errorf("%w: nil graph", ErrOutputMismatch)
	}
	// Forward replay: every step must be legal.
	replayed, _, err := cert.Chain.Apply(orig)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrIllegalTransform, err)
	}
	// Independent judgment of the actual output.
	if !replayed.Equal(claimed) {
		return fmt.Errorf("%w: replayed %s, claimed %s", ErrOutputMismatch, replayed, claimed)
	}
	// Inverse mapping: undoing the chain on the claimed output must
	// restore the original graph exactly.
	restored, err := cert.Chain.InverseApply(claimed)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrIllegalTransform, err)
	}
	if !restored.Equal(orig) {
		return fmt.Errorf("%w: restored %s, original %s", ErrInverseMismatch, restored, orig)
	}
	return nil
}

// VerifySeed additionally checks that the certificate's chain is exactly
// what the recorded seed regenerates for orig, binding the certificate to
// its seed.
func VerifySeed(orig *Graph, cert Certificate) error {
	regenerated := RandomChain(rand.New(rand.NewSource(cert.Seed)), orig, len(cert.Chain.Transforms))
	if len(regenerated.Transforms) != len(cert.Chain.Transforms) {
		return fmt.Errorf("%w: chain length %d, regenerated %d",
			ErrSeedMismatch, len(cert.Chain.Transforms), len(regenerated.Transforms))
	}
	g1, _, err := cert.Chain.Apply(orig)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrIllegalTransform, err)
	}
	g2, _, err := regenerated.Apply(orig)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrIllegalTransform, err)
	}
	if !g1.Equal(g2) {
		return fmt.Errorf("%w: recorded chain and regenerated chain diverge", ErrSeedMismatch)
	}
	return nil
}
