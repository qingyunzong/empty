package dataeng

// Token identifies the topic and subscription generation that produced an
// acknowledgement. A topic unload or a subscription generation change makes
// tokens from the previous generation stale.
type Token struct {
	TopicGeneration        uint64 `json:"topic_generation"`
	SubscriptionGeneration uint64 `json:"subscription_generation"`
}

// Generation and Epoch are aliases for Token.
type Generation = Token
type Epoch = Token

// Options configures a Tracker created with NewWithOptions.
type Options struct {
	Topic                  string
	Subscription           string
	TopicGeneration        uint64
	SubscriptionGeneration uint64
}
