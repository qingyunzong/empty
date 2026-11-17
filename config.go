package formal

import (
	"errors"
	"fmt"
	"math"
	"math/rand"
	"time"
)

// ErrorClass selects a backoff policy. Applications can define additional
// classes; a class without an explicit policy uses Config.DefaultBackoff.
type ErrorClass string

const (
	ErrorClassTransient   ErrorClass = "transient"
	ErrorClassConflict    ErrorClass = "conflict"
	ErrorClassRateLimited ErrorClass = "rate-limited"
	ErrorClassTerminal    ErrorClass = "terminal"
)

// Short aliases for the standard error classes.
const (
	Transient   = ErrorClassTransient
	Conflict    = ErrorClassConflict
	RateLimited = ErrorClassRateLimited
	Terminal    = ErrorClassTerminal

	TransientError   = ErrorClassTransient
	ConflictError    = ErrorClassConflict
	RateLimitedError = ErrorClassRateLimited
	TerminalError    = ErrorClassTerminal
)

var (
	// ErrConflict and the other sentinels can be wrapped by an application
	// error to select the corresponding backoff class.
	ErrConflict    = errors.New("conflict")
	ErrRateLimited = errors.New("rate limited")
	ErrTerminal    = errors.New("terminal")
)

// ClassifiedError attaches an ErrorClass to an error.
type ClassifiedError struct {
	Class ErrorClass
	Err   error
}

func (e *ClassifiedError) Error() string {
	if e.Err == nil {
		return string(e.Class)
	}
	return fmt.Sprintf("%s: %v", e.Class, e.Err)
}

func (e *ClassifiedError) Unwrap() error {
	return e.Err
}

// ErrorClass returns the explicit class carried by the error.
func (e *ClassifiedError) ErrorClass() ErrorClass {
	return e.Class
}

// WithClass tags err with class. It returns nil when err is nil.
func WithClass(err error, class ErrorClass) error {
	if err == nil {
		return nil
	}
	return &ClassifiedError{Class: class, Err: err}
}

// ClassifyError determines the retry class used by Fail. An explicit
// ClassifiedError (or any error implementing ErrorClass() ErrorClass) wins,
// followed by the standard sentinel errors. Unclassified errors are treated as
// transient.
func ClassifyError(err error) ErrorClass {
	if err == nil {
		return ErrorClassTransient
	}
	var classified interface {
		ErrorClass() ErrorClass
	}
	if errors.As(err, &classified) {
		return classified.ErrorClass()
	}
	switch {
	case errors.Is(err, ErrConflict):
		return ErrorClassConflict
	case errors.Is(err, ErrRateLimited):
		return ErrorClassRateLimited
	case errors.Is(err, ErrTerminal):
		return ErrorClassTerminal
	default:
		return ErrorClassTransient
	}
}

// RateLimit configures a token bucket. Rate is tokens per second and Burst is
// bucket capacity. A non-positive Rate or Burst disables that bucket.
type RateLimit struct {
	Rate  float64
	Burst int
}

func (r RateLimit) enabled() bool {
	return r.Rate > 0 && r.Burst > 0
}

// Backoff describes exponential retry delay for one error class.
//
// Attempt one waits Base. Each later attempt multiplies the previous delay by
// Multiplier, up to Max. Jitter is a fraction in [0,1): a value of 0.2 spreads
// a delay uniformly within +/-20 percent.
type Backoff struct {
	Base       time.Duration
	Max        time.Duration
	Multiplier float64
	Jitter     float64
}

func (b Backoff) normalized() Backoff {
	if b.Base <= 0 {
		b.Base = 100 * time.Millisecond
	}
	if b.Max <= 0 {
		b.Max = 30 * time.Second
	}
	if b.Multiplier < 1 {
		b.Multiplier = 2
	}
	if b.Jitter < 0 {
		b.Jitter = 0
	}
	if b.Jitter > 0.99 {
		b.Jitter = 0.99
	}
	if b.Max < b.Base {
		b.Max = b.Base
	}
	return b
}

// Delay returns the retry delay for a one-based attempt number.
func (b Backoff) Delay(attempt int) time.Duration {
	b = b.normalized()
	if attempt < 1 {
		attempt = 1
	}

	delay := float64(b.Base)
	for i := 1; i < attempt && delay < float64(b.Max); i++ {
		delay *= b.Multiplier
		if math.IsInf(delay, 0) || delay > float64(math.MaxInt64) {
			delay = float64(math.MaxInt64)
			break
		}
	}
	if delay > float64(b.Max) {
		delay = float64(b.Max)
	}
	if b.Jitter > 0 {
		delay *= 1 + (rand.Float64()*2-1)*b.Jitter
		if delay < 1 {
			delay = 1
		}
	}
	if delay > float64(math.MaxInt64) {
		delay = float64(math.MaxInt64)
	}
	return time.Duration(delay)
}

// Config controls queue ordering, retry, and rate limits.
type Config struct {
	// Global limits delivery across all namespaces.
	Global RateLimit
	// Namespace limits delivery independently for every namespace.
	Namespace RateLimit
	// NamespaceLimits overrides Namespace for selected namespaces.
	NamespaceLimits map[string]RateLimit

	// GlobalRate/GlobalBurst and NamespaceRate/NamespaceBurst are flat
	// convenience aliases. The corresponding struct field wins when either of
	// its members is non-zero.
	GlobalRate     float64
	GlobalBurst    int
	NamespaceRate  float64
	NamespaceBurst int

	// Backoff contains category-specific policies. Missing classes use
	// DefaultBackoff.
	Backoff        map[ErrorClass]Backoff
	DefaultBackoff Backoff
	Classify       func(error) ErrorClass
	Now            func() time.Time
}

// DefaultConfig returns a configuration with unlimited delivery rate and
// conventional retry delays. Use RateLimit fields to enable limiting.
func DefaultConfig() Config {
	return Config{
		Backoff: map[ErrorClass]Backoff{
			ErrorClassTransient:   {Base: 100 * time.Millisecond, Max: 30 * time.Second, Multiplier: 2},
			ErrorClassConflict:    {Base: 250 * time.Millisecond, Max: 10 * time.Second, Multiplier: 2},
			ErrorClassRateLimited: {Base: time.Second, Max: 30 * time.Second, Multiplier: 2},
		},
		DefaultBackoff: Backoff{Base: 100 * time.Millisecond, Max: 30 * time.Second, Multiplier: 2},
		Classify:       ClassifyError,
		Now:            time.Now,
	}
}

func (c Config) normalized() Config {
	defaults := DefaultConfig()
	if c.Global.Rate == 0 && c.Global.Burst == 0 {
		c.Global = RateLimit{Rate: c.GlobalRate, Burst: c.GlobalBurst}
	}
	if c.Namespace.Rate == 0 && c.Namespace.Burst == 0 {
		c.Namespace = RateLimit{Rate: c.NamespaceRate, Burst: c.NamespaceBurst}
	}
	if c.NamespaceLimits != nil {
		limits := make(map[string]RateLimit, len(c.NamespaceLimits))
		for namespace, limit := range c.NamespaceLimits {
			limits[namespace] = limit
		}
		c.NamespaceLimits = limits
	}

	if c.DefaultBackoff == (Backoff{}) {
		c.DefaultBackoff = defaults.DefaultBackoff
	}
	backoff := make(map[ErrorClass]Backoff, len(defaults.Backoff)+len(c.Backoff))
	if c.DefaultBackoff == defaults.DefaultBackoff {
		for class, policy := range defaults.Backoff {
			backoff[class] = policy
		}
	}
	for class, policy := range c.Backoff {
		backoff[class] = policy
	}
	c.Backoff = backoff
	c.DefaultBackoff = c.DefaultBackoff.normalized()
	for class, policy := range c.Backoff {
		c.Backoff[class] = policy.normalized()
	}
	if c.Classify == nil {
		c.Classify = defaults.Classify
	}
	if c.Now == nil {
		c.Now = defaults.Now
	}
	return c
}
