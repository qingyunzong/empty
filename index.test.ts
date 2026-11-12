import test from "node:test";
import assert from "node:assert/strict";

import {
  MetricParseError,
  MetricParser,
  createMetricParser,
  parseMetricText,
  type MetricSample,
} from "./index.ts";

test("parses directives, labels and CRLF-delimited lines", () => {
  const parser = new MetricParser();

  assert.equal(
    parser.pushLine("# HELP http_requests_total Total HTTP requests."),
    null,
  );
  assert.equal(
    parser.pushLine("# TYPE http_requests_total counter"),
    null,
  );
  assert.equal(parser.pushLine("# an unrelated comment"), null);
  assert.equal(parser.pushLine(""), null);

  assert.deepEqual(
    parser.pushLine(
      'http_requests_total{method="GET",path="/v1"} 42 123',
    ),
    {
      name: "http_requests_total",
      labels: { method: "GET", path: "/v1" },
      value: 42,
      timestamp: 123,
    },
  );

  assert.deepEqual(parser.pushLine("http_requests_total 7\r"), {
    name: "http_requests_total",
    labels: {},
    value: 7,
  });

  assert.deepEqual(parser.samples, [
    {
      name: "http_requests_total",
      labels: { method: "GET", path: "/v1" },
      value: 42,
      timestamp: 123,
    },
    {
      name: "http_requests_total",
      labels: {},
      value: 7,
    },
  ]);
});

test("a TYPE that follows a sample fails and leaves prior samples intact", () => {
  const priorSample: MetricSample = {
    name: "request_latency_bucket",
    labels: { le: "0.1" },
    value: 3,
  };
  const parser = new MetricParser();

  assert.deepEqual(
    parser.pushLine('request_latency_bucket{le="0.1"} 3'),
    priorSample,
  );
  assert.throws(
    () => parser.pushLine("# TYPE request_latency histogram"),
    MetricParseError,
  );
  assert.deepEqual(parser.samples, [priorSample]);
  assert.equal(parser.stopped, true);
  assert.equal(parser.error instanceof MetricParseError, true);

  assert.equal(parser.pushLine("request_latency_sum 9"), null);
  assert.deepEqual(parser.samples, [priorSample]);
});

test("HELP is at most once and must precede related samples", () => {
  const parser = new MetricParser();
  parser.pushLine("# TYPE help_metric gauge");
  parser.pushLine("# HELP help_metric First help.");

  assert.throws(
    () => parser.pushLine("# HELP help_metric Second help."),
    MetricParseError,
  );

  const lateHelp = new MetricParser();
  lateHelp.pushLine("late_help_metric 1");
  assert.throws(
    () => lateHelp.pushLine("# HELP late_help_metric Too late."),
    MetricParseError,
  );
});

test("duplicate label names fail", () => {
  const parser = new MetricParser();
  assert.throws(
    () => parser.pushLine('duplicate_label{a="first",a="second"} 1'),
    MetricParseError,
  );
  assert.deepEqual(parser.samples, []);
});

test("histogram buckets require exactly one le label", () => {
  const missing = new MetricParser();
  missing.pushLine("# TYPE histogram_metric histogram");
  assert.throws(
    () => missing.pushLine("histogram_metric_bucket 1"),
    MetricParseError,
  );

  const duplicate = new MetricParser();
  duplicate.pushLine("# TYPE histogram_metric histogram");
  assert.throws(
    () => duplicate.pushLine('histogram_metric_bucket{le="1",le="2"} 1'),
    MetricParseError,
  );

  const wrongPart = new MetricParser();
  wrongPart.pushLine("# TYPE histogram_metric histogram");
  assert.throws(
    () => wrongPart.pushLine('histogram_metric_sum{le="1"} 2'),
    MetricParseError,
  );

  const valid = new MetricParser();
  valid.pushLine("# TYPE histogram_metric histogram");
  assert.deepEqual(
    valid.pushLine('histogram_metric_bucket{le="+Inf",host="a"} 5'),
    {
      name: "histogram_metric_bucket",
      labels: { le: "+Inf", host: "a" },
      value: 5,
    },
  );
  assert.deepEqual(valid.pushLine("histogram_metric_sum 8"), {
    name: "histogram_metric_sum",
    labels: {},
    value: 8,
  });
});

test("summary base names require quantile and siblings reject it", () => {
  const valid = new MetricParser();
  valid.pushLine("# TYPE summary_metric summary");
  assert.deepEqual(
    valid.pushLine('summary_metric{quantile="0.5"} 4'),
    {
      name: "summary_metric",
      labels: { quantile: "0.5" },
      value: 4,
    },
  );

  const missing = new MetricParser();
  missing.pushLine("# TYPE summary_metric summary");
  assert.throws(
    () => missing.pushLine("summary_metric 4"),
    MetricParseError,
  );

  const wrongPart = new MetricParser();
  wrongPart.pushLine("# TYPE summary_metric summary");
  assert.throws(
    () => wrongPart.pushLine('summary_metric_sum{quantile="0.5"} 2'),
    MetricParseError,
  );

  const leOnBase = new MetricParser();
  leOnBase.pushLine("# TYPE summary_metric summary");
  assert.throws(
    () => leOnBase.pushLine('summary_metric{quantile="0.5",le="1"} 2'),
    MetricParseError,
  );
});

test("le and quantile are rejected on unrelated declared types", () => {
  const leOnGauge = new MetricParser();
  leOnGauge.pushLine("# TYPE gauge_metric gauge");
  assert.throws(
    () => leOnGauge.pushLine('gauge_metric{le="1"} 3'),
    MetricParseError,
  );

  const quantileOnCounter = new MetricParser();
  quantileOnCounter.pushLine("# TYPE counter_metric counter");
  assert.throws(
    () => quantileOnCounter.pushLine('counter_metric{quantile="0.9"} 3'),
    MetricParseError,
  );

  const suffixOnGauge = new MetricParser();
  suffixOnGauge.pushLine("# TYPE suffixed_gauge gauge");
  assert.throws(
    () => suffixOnGauge.pushLine("suffixed_gauge_bucket 3"),
    MetricParseError,
  );

  const unknownHistogramSuffix = new MetricParser();
  unknownHistogramSuffix.pushLine("# TYPE suffixed_histogram histogram");
  assert.throws(
    () => unknownHistogramSuffix.pushLine("suffixed_histogram_other 3"),
    MetricParseError,
  );

  const unknownSummarySuffix = new MetricParser();
  unknownSummarySuffix.pushLine("# TYPE suffixed_summary summary");
  assert.throws(
    () => unknownSummarySuffix.pushLine("suffixed_summary_other 3"),
    MetricParseError,
  );
});

test("TYPE kinds are restricted and a TYPE may not be repeated", () => {
  const invalidKind = new MetricParser();
  assert.throws(
    () => invalidKind.pushLine("# TYPE kind_metric number"),
    MetricParseError,
  );

  const repeated = new MetricParser();
  repeated.pushLine("# TYPE repeated_metric gauge");
  assert.throws(
    () => repeated.pushLine("# TYPE repeated_metric untyped"),
    MetricParseError,
  );
});

test("malformed HELP and TYPE lines fail while other comments are ignored", () => {
  const malformed = new MetricParser();
  assert.throws(
    () => malformed.pushLine("# TYPE malformed_metric"),
    MetricParseError,
  );

  const extra = new MetricParser();
  assert.throws(
    () => extra.pushLine("# TYPE extra_metric gauge trailing"),
    MetricParseError,
  );

  const ignored = new MetricParser();
  assert.equal(ignored.pushLine("#HELP ignored_metric text"), null);
  assert.equal(ignored.pushLine("# ignored_metric text"), null);
  assert.deepEqual(ignored.samples, []);
});

test("label escapes are decoded and unsupported escapes fail", () => {
  const parser = new MetricParser();
  const line = String.raw`escaped{a="back\\slash",b="quote\"inside",c="line\nnext"} 1`;
  assert.deepEqual(parser.pushLine(line), {
    name: "escaped",
    labels: {
      a: "back\\slash",
      b: 'quote"inside',
      c: "line\nnext",
    },
    value: 1,
  });

  const badEscape = new MetricParser();
  assert.throws(
    () => badEscape.pushLine(String.raw`bad_escape{a="\t"} 1`),
    MetricParseError,
  );
});

test("decimal values round to binary64 and preserve signed zero", () => {
  const parser = new MetricParser();

  const negativeZero = parser.pushLine("zero_value -0");
  assert.notEqual(negativeZero, null);
  assert.equal(Object.is(negativeZero?.value, -0), true);

  const positiveZero = parser.pushLine("zero_value +0.0e0");
  assert.notEqual(positiveZero, null);
  assert.equal(Object.is(positiveZero?.value, 0), true);

  const tinyNegative = parser.pushLine("zero_value -1e-400");
  assert.notEqual(tinyNegative, null);
  assert.equal(Object.is(tinyNegative?.value, -0), true);

  assert.equal(parser.pushLine("value_metric 0.1")?.value, 0.1);
  assert.equal(parser.pushLine("value_metric 1.25e2")?.value, 125);
  assert.equal(parser.pushLine("value_metric NaN")?.value, Number.NaN);
  assert.equal(parser.pushLine("value_metric +Inf")?.value, Number.POSITIVE_INFINITY);
  assert.equal(parser.pushLine("value_metric -Inf")?.value, Number.NEGATIVE_INFINITY);
  assert.equal(parser.pushLine("value_metric 1e400")?.value, Number.POSITIVE_INFINITY);

  const tieToEven = new MetricParser();
  assert.equal(
    tieToEven.pushLine(
      "value_metric 1.00000000000000011102230246251565404236316680908203125",
    )?.value,
    1,
  );
  assert.equal(
    tieToEven.pushLine(
      "value_metric 1.00000000000000033306690738754696212708950042724609375",
    )?.value,
    1 + 2 ** -51,
  );

  for (const invalid of [".5", "1.", "1e", "+", "inf", "1,2", "0x10"]) {
    const invalidParser = new MetricParser();
    assert.throws(
      () => invalidParser.pushLine(`invalid_value ${invalid}`),
      MetricParseError,
      invalid,
    );
  }
});

test("timestamps are decimal int64 values with no leading zero", () => {
  const valid = new MetricParser();
  assert.deepEqual(valid.pushLine("stamped 1 0"), {
    name: "stamped",
    labels: {},
    value: 1,
    timestamp: 0,
  });
  assert.deepEqual(valid.pushLine("stamped 2 -1"), {
    name: "stamped",
    labels: {},
    value: 2,
    timestamp: -1,
  });
  assert.deepEqual(valid.pushLine("stamped 3 9223372036854775807"), {
    name: "stamped",
    labels: {},
    value: 3,
    timestamp: BigInt("9223372036854775807"),
  });
  assert.deepEqual(valid.pushLine("stamped 4 -9223372036854775808"), {
    name: "stamped",
    labels: {},
    value: 4,
    timestamp: BigInt("-9223372036854775808"),
  });

  for (const invalid of [
    "-0",
    "01",
    "00",
    "+1",
    "-01",
    "9223372036854775808",
    "-9223372036854775809",
    "1.0",
  ]) {
    const invalidParser = new MetricParser();
    assert.throws(
      () => invalidParser.pushLine(`bad_timestamp 1 ${invalid}`),
      MetricParseError,
      invalid,
    );
  }
});

test("a line cut at a CRLF boundary is parsed as two independent lines", () => {
  const input =
    "# TYPE split_metric gauge\r\n" +
    'split_metric{part="a"} 1 10\r\n' +
    "\r\n" +
    "split_metric 2\r\n";
  assert.deepEqual(parseMetricText(input), [
    {
      name: "split_metric",
      labels: { part: "a" },
      value: 1,
      timestamp: 10,
    },
    {
      name: "split_metric",
      labels: {},
      value: 2,
    },
  ]);
});

test("a truncated line is a bad line rather than a partial line", () => {
  const parser = new MetricParser();
  assert.deepEqual(parser.pushLine("complete_metric 1"), {
    name: "complete_metric",
    labels: {},
    value: 1,
  });
  assert.throws(
    () => parser.pushLine("truncated_metric"),
    MetricParseError,
  );
  assert.deepEqual(parser.samples, [
    {
      name: "complete_metric",
      labels: {},
      value: 1,
    },
  ]);
});

test("factory helpers produce an independent parser with the same behavior", () => {
  const parser = createMetricParser();
  assert.deepEqual(parser.feed('factory_metric{ok="yes"} 6'), {
    name: "factory_metric",
    labels: { ok: "yes" },
    value: 6,
  });
  assert.deepEqual(parser.samples, [
    {
      name: "factory_metric",
      labels: { ok: "yes" },
      value: 6,
    },
  ]);
});
