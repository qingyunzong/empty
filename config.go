package formal

import (
	"fmt"
	"strings"
	"time"
)

// Config describes one participant in one cluster.
type Config struct {
	// Cluster scopes the lease. Identically named leases in different
	// clusters are independent and never contend.
	Cluster string

	// LeaseName is the shared lease key inside Cluster.
	LeaseName string

	// Holder must be unique among all processes that can participate in the
	// same cluster. A duplicated holder name can defeat fencing.
	Holder string

	// LeaseDuration is how long a successful acquisition or renewal remains
	// valid. It is measured on the holder's clock.
	LeaseDuration time.Duration

	// RenewInterval is the minimum delay between renewal attempts.
	RenewInterval time.Duration

	// ClockSkewBound is the maximum difference between any two participating
	// clocks in the same cluster. A non-holder replaces a lease only after its
	// local clock is strictly later than ExpiresAt plus this bound.
	//
	// If each process independently has an error of at most E against a
	// reference clock, set ClockSkewBound to 2*E. Every participant that
	// evaluates the same lease must use the same bound.
	ClockSkewBound time.Duration
}

// Validate returns an error if the configuration cannot guarantee safe
// operation.
func (c Config) Validate() error {
	switch {
	case strings.TrimSpace(c.Cluster) == "":
		return fmt.Errorf("%w: cluster is required", ErrInvalidConfig)
	case strings.TrimSpace(c.LeaseName) == "":
		return fmt.Errorf("%w: lease name is required", ErrInvalidConfig)
	case strings.TrimSpace(c.Holder) == "":
		return fmt.Errorf("%w: holder is required", ErrInvalidConfig)
	case c.LeaseDuration <= 0:
		return fmt.Errorf("%w: lease duration must be positive", ErrInvalidConfig)
	case c.RenewInterval <= 0:
		return fmt.Errorf("%w: renew interval must be positive", ErrInvalidConfig)
	case c.RenewInterval >= c.LeaseDuration:
		return fmt.Errorf("%w: renew interval must be shorter than lease duration", ErrInvalidConfig)
	case c.ClockSkewBound < 0:
		return fmt.Errorf("%w: clock skew bound must not be negative", ErrInvalidConfig)
	}
	return nil
}
