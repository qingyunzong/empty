// Package dataeng tracks per-source pause windows for a fetch host.
//
// Each failed response carries a positive version, receive wall-clock and
// monotonic readings, an optional server Date, and a Retry-After directive
// (non-negative seconds or a caller-parsed absolute UTC second). Absolute
// dates are estimated against the server Date when valid, otherwise against
// the receive UTC instant; negative waits clamp to zero and all deadline
// arithmetic saturates instead of overflowing. Out-of-order responses keep
// the maximum deadline, and an explicit success clears all pauses at or
// below its version, raising a barrier so late stale failures cannot
// resurrect them.
package dataeng
