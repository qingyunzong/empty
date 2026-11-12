import {
  Decoder,
  Demultiplexer,
  decodeReference,
  type AttributePair,
  type DecodedMessage,
  type Delivery,
  type RespValue,
} from "../index.js";

const encoder = new TextEncoder();
const textDecoder = new TextDecoder();

function wire(...parts: string[]): Uint8Array {
  return encoder.encode(parts.join(""));
}

/** Illustrative host-side value projection; raw bytes stay available too. */
function valueJson(value: RespValue): unknown {
  switch (value.type) {
    case "simple-string":
    case "simple-error":
      return {
        type: value.type,
        text: textDecoder.decode(value.value),
        attributes: pairsJson(value.attributes),
      };
    case "integer":
      return {
        type: value.type,
        value: value.value.toString(),
        attributes: pairsJson(value.attributes),
      };
    case "null":
      return { type: value.type, attributes: pairsJson(value.attributes) };
    case "blob":
      return {
        type: value.type,
        text: textDecoder.decode(value.value),
        chunkLengths: value.chunks.map((chunk) => chunk.length),
        attributes: pairsJson(value.attributes),
      };
    case "array":
      return {
        type: value.type,
        values: value.value.map(valueJson),
        attributes: pairsJson(value.attributes),
      };
    case "map":
      return {
        type: value.type,
        pairs: value.value.map((pair) => ({
          key: valueJson(pair.key),
          value: valueJson(pair.value),
        })),
        attributes: pairsJson(value.attributes),
      };
  }
}

function pairsJson(pairs: AttributePair[]): unknown[] {
  return pairs.map((pair) => ({
    key: valueJson(pair.key),
    value: valueJson(pair.value),
  }));
}

function messageJson(message: DecodedMessage): unknown {
  if (message.type === "push") {
    return {
      type: "push",
      attributes: pairsJson(message.attributes),
      values: message.values.map(valueJson),
      range: message.range,
    };
  }
  return {
    type: "value",
    value: valueJson(message.value),
    range: message.range,
  };
}

interface HostEvent {
  connectionId: string;
  delivery: Delivery<string>;
}

/**
 * A small collector-side host, not a Redis client. It accepts the same
 * physical chunks an acquisition loop would receive and dispatches complete
 * responses and pushes to separate handlers.
 */
class CollectorHost {
  private readonly demux = new Demultiplexer<string>(new Decoder());
  private readonly responseSink: HostEvent[] = [];
  private readonly pushSink: HostEvent[] = [];

  register(ticket: string): void {
    this.demux.register(ticket);
  }

  cancel(ticket: string): void {
    this.demux.cancel(ticket);
  }

  onConnectionBytes(connectionId: string, bytes: Uint8Array): void {
    this.demux.pushBytes(bytes);
    while (true) {
      const delivery = this.demux.next();
      if (delivery === null) {
        break;
      }
      const event = { connectionId, delivery };
      if (delivery.disposition === "push") {
        this.pushSink.push(event);
      } else {
        this.responseSink.push(event);
      }
    }
  }

  finish(): void {
    const finish = this.demux.finish();
    if (!finish.clean) {
      throw new Error(`truncated collector stream: ${finish.reason}`);
    }
  }

  snapshot(): { responses: HostEvent[]; pushes: HostEvent[] } {
    return {
      responses: this.responseSink,
      pushes: this.pushSink,
    };
  }
}

// Two requests, then an attribute-bearing push, then the remaining replies.
// Request "req-2" is cancelled while still in flight, so its error response
// occupies the cancelled slot and is marked discarded.
const transcript = wire(
  "|1\r\n+ttl\r\n:10\r\n:42\r\n",
  "|1\r\n+channel\r\n+ops\r\n>2\r\n+deploy\r\n%1\r\n+id\r\n:7\r\n",
  "-ERR cancelled request\r\n",
  "*3\r\n+alpha\r\n|1\r\n+meta\r\n+three\r\n_\r\n*0\r\n",
  "$?\r\n;4\r\nok\r\n\r\n;0\r\n",
  "+background-notification\r\n",
);

const host = new CollectorHost();
host.register("req-1");
host.register("req-2");
host.register("req-3");
host.register("req-4");
host.cancel("req-2");

// Feed arbitrary transport fragments, exactly as an acquisition loop would.
const fragmentSizes = [1, 7, 2, 19, 3, 11, 1, 5];
let offset = 0;
let fragmentIndex = 0;
while (offset < transcript.length) {
  const size = fragmentSizes[fragmentIndex % fragmentSizes.length]!;
  const end = Math.min(transcript.length, offset + size);
  host.onConnectionBytes("collector-connection-1", transcript.slice(offset, end));
  offset = end;
  fragmentIndex += 1;
}
host.finish();

const snapshot = host.snapshot();
console.log(
  JSON.stringify(
    {
      responses: snapshot.responses.map((event) => ({
        ticket: event.delivery.ticket,
        disposition: event.delivery.disposition,
        message: messageJson(event.delivery.message),
      })),
      pushes: snapshot.pushes.map((event) => ({
        ticket: event.delivery.ticket,
        disposition: event.delivery.disposition,
        message: messageJson(event.delivery.message),
      })),
    },
    null,
    2,
  ),
);

// The independent whole-buffer parser is used here only as an offline check.
const reference = decodeReference(transcript);
console.log(
  `reference messages: ${reference.messages.length}; clean: ${reference.clean}`,
);
