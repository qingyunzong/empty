import { test } from "node:test";
import assert from "node:assert/strict";
import { PageLoadAdapter } from "../src/adapter.js";
import { evaluateResource } from "../src/policy.js";
import type { ResourcePolicy } from "../src/types.js";

const PAGE = "https://shop.example.test";

test("default ports: explicit and omitted ports compare equal", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://cdn.example.test"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  const omitted = adapter.canLoadScript("https://cdn.example.test/a.js");
  const explicit = adapter.canLoadScript("https://cdn.example.test:443/a.js");
  const wrongPort = adapter.canLoadScript("https://cdn.example.test:8443/a.js");

  assert.equal(omitted.allowed, true);
  assert.deepEqual(omitted.allowedBy, [0]);
  assert.deepEqual(omitted.deniedBy, []);
  assert.equal(explicit.allowed, true);
  assert.equal(wrongPort.allowed, false);
  assert.deepEqual(wrongPort.deniedBy, [0]);

  const httpPage = new PageLoadAdapter("http://shop.example.test", [
    { img: ["http://img.example.test"] },
  ]);
  assert.equal(
    httpPage.canLoadImage("http://img.example.test:80/p.png").allowed,
    true,
  );
});

test("protocol-relative URL inherits the page scheme", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://cdn.example.test/js"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  const protoRelative = adapter.canLoadScript("//cdn.example.test/js/app.js");
  assert.equal(protoRelative.allowed, true);

  const httpAdapter = new PageLoadAdapter("http://shop.example.test", [
    { script: ["cdn.example.test"] },
  ]);
  const overHttp = httpAdapter.canLoadScript("//cdn.example.test/x.js");
  assert.equal(overHttp.allowed, true);

  const schemeMismatch = new PageLoadAdapter(PAGE, [
    { script: ["http://cdn.example.test"] },
  ]).canLoadScript("//cdn.example.test/x.js");
  assert.equal(schemeMismatch.allowed, false);
});

test("wildcard root domain matches subdomains only, never the bare host", () => {
  const policies: ResourcePolicy[] = [
    { img: ["*.cdn.example.test"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  assert.equal(
    adapter.canLoadImage("https://a.cdn.example.test/x.png").allowed,
    true,
  );
  assert.equal(
    adapter.canLoadImage("https://a.b.cdn.example.test/x.png").allowed,
    true,
  );
  assert.equal(
    adapter.canLoadImage("https://cdn.example.test/x.png").allowed,
    false,
  );

  const exact = new PageLoadAdapter(PAGE, [
    { img: ["cdn.example.test"] },
  ]);
  assert.equal(exact.canLoadImage("https://cdn.example.test/x.png").allowed, true);
  assert.equal(
    exact.canLoadImage("https://a.cdn.example.test/x.png").allowed,
    false,
  );
});

test("encoded slash: decoded once then compared by segment prefix", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://cdn.example.test/app"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  const encodedSlash = adapter.canLoadScript(
    "https://cdn.example.test/app%2Flib/x.js",
  );
  assert.equal(encodedSlash.allowed, true);

  const doubleEncoded = adapter.canLoadScript(
    "https://cdn.example.test/app%252Flib/x.js",
  );
  assert.equal(doubleEncoded.allowed, false);

  const segmentBoundary = adapter.canLoadScript(
    "https://cdn.example.test/apple/x.js",
  );
  assert.equal(segmentBoundary.allowed, false);
});

test("bad percent escape is rejected even when sources would otherwise match", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://cdn.example.test"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  const badEscape = adapter.canLoadScript(
    "https://cdn.example.test/a%ZZ/b.js",
  );
  assert.equal(badEscape.allowed, false);
  assert.deepEqual(badEscape.deniedBy, [0]);

  const truncated = adapter.canLoadScript("https://cdn.example.test/a%2/b.js");
  assert.equal(truncated.allowed, false);
});

test("dot segments are removed before path-prefix comparison", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://cdn.example.test/app"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  assert.equal(
    adapter.canLoadScript("https://cdn.example.test/app/../app/x.js").allowed,
    true,
  );
  assert.equal(
    adapter.canLoadScript("https://cdn.example.test/app/../../etc/p.js").allowed,
    false,
  );
});

test("multiple policies intersect and report allow/deny indices", () => {
  const policies: ResourcePolicy[] = [
    { script: ["https://a.example.test", "https://b.example.test"] },
    { script: ["https://b.example.test", "https://c.example.test"] },
  ];
  const adapter = new PageLoadAdapter(PAGE, policies);

  const intersection = adapter.canLoadScript("https://b.example.test/x.js");
  assert.equal(intersection.allowed, true);
  assert.deepEqual(intersection.allowedBy, [0, 1]);

  const onlyFirst = adapter.canLoadScript("https://a.example.test/x.js");
  assert.equal(onlyFirst.allowed, false);
  assert.deepEqual(onlyFirst.allowedBy, [0]);
  assert.deepEqual(onlyFirst.deniedBy, [1]);

  const neither = adapter.canLoadScript("https://d.example.test/x.js");
  assert.equal(neither.allowed, false);
  assert.deepEqual(neither.deniedBy, [0, 1]);
});

test("directive fallback: resource bucket, then default, then unrestricted", () => {
  const adapter = new PageLoadAdapter(PAGE, [
    { default: ["https://cdn.example.test"] },
  ]);
  assert.equal(
    adapter.canLoadImage("https://cdn.example.test/p.png").allowed,
    true,
  );
  assert.equal(
    adapter.canLoadImage("https://other.example.test/p.png").allowed,
    false,
  );

  const unrestricted = new PageLoadAdapter(PAGE, [{ script: ["'none'"] }]);
  const imageVerdict = unrestricted.canLoadImage("https://anything.test/p.png");
  assert.equal(imageVerdict.allowed, true);
  assert.deepEqual(imageVerdict.allowedBy, [0]);

  const noneOnly = new PageLoadAdapter(PAGE, [{ img: ["'none'"] }]);
  assert.equal(noneOnly.canLoadImage("https://x.test/p.png").allowed, false);
});

test("none must be exclusive; mixed sources fail closed", () => {
  const mixed = new PageLoadAdapter(PAGE, [
    { script: ["'none'", "https://cdn.example.test"] },
  ]);
  assert.equal(mixed.canLoadScript("https://cdn.example.test/a.js").allowed, false);
});

test("self matches only the page origin (scheme, host and port)", () => {
  const adapter = new PageLoadAdapter(PAGE, [
    { script: ["'self'"] },
  ]);
  assert.equal(adapter.canLoadScript("/assets/x.js").allowed, true);
  assert.equal(
    adapter.canLoadScript("https://shop.example.test:443/assets/x.js").allowed,
    true,
  );
  assert.equal(
    adapter.canLoadScript("https://other.example.test/x.js").allowed,
    false,
  );
  assert.equal(
    adapter.canLoadScript("http://shop.example.test/x.js").allowed,
    false,
  );
});

test("bare host source uses page scheme and its default port", () => {
  const adapter = new PageLoadAdapter(PAGE, [
    { script: ["cdn.example.test"] },
  ]);
  assert.equal(adapter.canLoadScript("https://cdn.example.test/x.js").allowed, true);
  assert.equal(adapter.canLoadScript("http://cdn.example.test/x.js").allowed, false);

  const withPort = new PageLoadAdapter(PAGE, [
    { script: ["cdn.example.test:8443/app"] },
  ]);
  assert.equal(
    withPort.canLoadScript("https://cdn.example.test:8443/app/x.js").allowed,
    true,
  );
  assert.equal(
    withPort.canLoadScript("https://cdn.example.test/app/x.js").allowed,
    false,
  );
});

test("scheme source matches any host on that scheme", () => {
  const verdict = evaluateResource(
    PAGE,
    [{ img: ["data:"] }],
    "data:image/png;base64,AAAA",
    "img",
  );
  assert.equal(verdict.allowed, true);
});

test("sources within one policy are unioned", () => {
  const adapter = new PageLoadAdapter(PAGE, [
    { script: ["https://one.example.test", "https://two.example.test"] },
  ]);
  assert.equal(adapter.canLoadScript("https://one.example.test/a.js").allowed, true);
  assert.equal(adapter.canLoadScript("https://two.example.test/b.js").allowed, true);
  assert.equal(
    adapter.canLoadScript("https://three.example.test/c.js").allowed,
    false,
  );
});
