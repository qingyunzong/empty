// Package dataeng parses DNS response messages received by the collector.
//
// It performs no network access: bytes arrive through Decoder.Push and fully
// parsed messages are delivered by Push (or Decoder.Finish for the trailing
// message). Any malformed input stops the component permanently and never
// delivers a partial message.
package dataeng
