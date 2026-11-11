import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CookieJar, defaultPath } from "../src/index.js";

// Naive last-two-labels site attribution, injected by the caller in real use.
const siteForHost = (host: string): string => {
  const labels = host.split(".");
  return labels.slice(-2).join(".");
};

function makeJar(start = 1_000_000) {
  const clock = { t: start };
  const jar = new CookieJar({ siteForHost, now: () => clock.t });
  return { jar, clock };
}

const TOP = "https://top.example.com/";

describe("domain matching (RFC6265)", () => {
  it("sends Domain cookies to the domain and its subdomains", () => {
    const { jar } = makeJar();
    jar.setCookie("a=1; Domain=example.com", {
      requestUrl: "https://app.example.com/",
      topLevelSite: TOP,
    });
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://sub.example.com/",
        topLevelSite: TOP,
      }),
      "a=1",
    );
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      "a=1",
    );
  });

  it("rejects a Domain the request host does not match", () => {
    const { jar } = makeJar();
    assert.equal(
      jar.setCookie("a=1; Domain=other.com", {
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      null,
    );
    assert.equal(
      jar.setCookie("a=1; Domain=sub.example.com", {
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      null,
    );
    assert.equal(jar.size, 0);
  });

  it("host-only cookies never leak to subdomains", () => {
    const { jar } = makeJar();
    jar.setCookie("a=1", {
      requestUrl: "https://example.com/",
      topLevelSite: TOP,
    });
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://sub.example.com/",
        topLevelSite: TOP,
      }),
      "",
    );
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      "a=1",
    );
  });
});

describe("path matching (RFC6265)", () => {
  it("computes the default path from the request URL", () => {
    assert.equal(defaultPath("/a/b/c"), "/a/b");
    assert.equal(defaultPath("/a"), "/");
    assert.equal(defaultPath("/"), "/");
  });

  it("matches directory boundaries only", () => {
    const { jar } = makeJar();
    jar.setCookie("a=1; Path=/app", {
      requestUrl: "https://example.com/",
      topLevelSite: TOP,
    });
    const at = (path: string) =>
      jar.getCookieHeader({
        requestUrl: `https://example.com${path}`,
        topLevelSite: TOP,
      });
    assert.equal(at("/app"), "a=1");
    assert.equal(at("/app/x"), "a=1");
    assert.equal(at("/apple"), "");
    assert.equal(at("/"), "");
  });
});

describe("Secure and SameSite", () => {
  it("Secure cookies only travel over HTTPS", () => {
    const { jar } = makeJar();
    jar.setCookie("s=1; Secure", {
      requestUrl: "https://example.com/",
      topLevelSite: TOP,
    });
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "http://example.com/",
        topLevelSite: TOP,
      }),
      "",
    );
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      "s=1",
    );
  });

  it("rejects Secure cookies set over plain HTTP", () => {
    const { jar } = makeJar();
    assert.equal(
      jar.setCookie("s=1; Secure", {
        requestUrl: "http://example.com/",
        topLevelSite: TOP,
      }),
      null,
    );
  });

  it("rejects SameSite=None without Secure", () => {
    const { jar } = makeJar();
    assert.equal(
      jar.setCookie("n=1; SameSite=None", {
        requestUrl: "https://example.com/",
        topLevelSite: TOP,
      }),
      null,
    );
  });
});

describe("cross-site navigation", () => {
  function seededJar() {
    const ctx = { requestUrl: "https://tracker.example/", topLevelSite: "https://tracker.example/" };
    const { jar } = makeJar();
    jar.setCookie("strict=1; SameSite=Strict", ctx);
    jar.setCookie("lax=1; SameSite=Lax", ctx);
    jar.setCookie("none=1; SameSite=None; Secure", {
      requestUrl: "https://tracker.example/",
      topLevelSite: "https://tracker.example/",
    });
    return jar;
  }

  it("sends everything on a same-site request", () => {
    const jar = seededJar();
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://tracker.example/api",
        topLevelSite: "https://tracker.example/",
      }),
      "strict=1; lax=1; none=1",
    );
  });

  it("withholds Strict and Lax on a cross-site subresource request", () => {
    const jar = seededJar();
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://tracker.example/pixel.gif",
        topLevelSite: "https://shop.example/",
        method: "GET",
      }),
      "none=1",
    );
  });

  it("allows Lax (not Strict) on a cross-site top-level GET navigation", () => {
    const jar = seededJar();
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://tracker.example/landing",
        topLevelSite: "https://shop.example/",
        method: "GET",
        isTopLevelNavigation: true,
      }),
      "lax=1; none=1",
    );
  });

  it("withholds Lax on a cross-site top-level POST navigation", () => {
    const jar = seededJar();
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://tracker.example/landing",
        topLevelSite: "https://shop.example/",
        method: "POST",
        isTopLevelNavigation: true,
      }),
      "none=1",
    );
  });
});

describe("Partitioned (CHIPS)", () => {
  it("isolates cookies by top-level site and mixes with unpartitioned ones", () => {
    const { jar } = makeJar();
    // widget.com is embedded as a third party on shop-a.com and shop-b.com.
    jar.setCookie("p=fromA; Secure; SameSite=None; Partitioned", {
      requestUrl: "https://widget.com/",
      topLevelSite: "https://shop-a.com/",
    });
    jar.setCookie("p=fromB; Secure; SameSite=None; Partitioned", {
      requestUrl: "https://widget.com/",
      topLevelSite: "https://shop-b.com/",
    });
    jar.setCookie("shared=1; Secure; SameSite=None", {
      requestUrl: "https://widget.com/",
      topLevelSite: "https://shop-a.com/",
    });

    const at = (top: string) =>
      jar.getCookieHeader({
        requestUrl: "https://widget.com/",
        topLevelSite: top,
      });
    assert.equal(at("https://shop-a.com/"), "p=fromA; shared=1");
    assert.equal(at("https://shop-b.com/"), "p=fromB; shared=1");
    assert.equal(at("https://widget.com/"), "shared=1");
  });

  it("rejects Partitioned without Secure", () => {
    const { jar } = makeJar();
    assert.equal(
      jar.setCookie("p=1; Partitioned", {
        requestUrl: "https://widget.com/",
        topLevelSite: "https://shop-a.com/",
      }),
      null,
    );
  });
});

describe("__Host- prefix", () => {
  const ctx = { requestUrl: "https://example.com/", topLevelSite: TOP };

  it("accepts Secure, host-only, Path=/ cookies", () => {
    const { jar } = makeJar();
    assert.notEqual(jar.setCookie("__Host-id=1; Secure; Path=/", ctx), null);
  });

  it("rejects cookies with a Domain, a non-root path, or no Secure", () => {
    const { jar } = makeJar();
    assert.equal(
      jar.setCookie("__Host-a=1; Secure; Path=/; Domain=example.com", ctx),
      null,
    );
    assert.equal(jar.setCookie("__Host-b=1; Secure; Path=/app", ctx), null);
    assert.equal(jar.setCookie("__Host-c=1; Path=/", ctx), null);
    assert.equal(jar.size, 0);
  });
});

describe("expiry", () => {
  it("expires exactly at the Max-Age boundary", () => {
    const { jar, clock } = makeJar(0);
    jar.setCookie("a=1; Max-Age=10", {
      requestUrl: "https://example.com/",
      topLevelSite: TOP,
    });
    const ctx = { requestUrl: "https://example.com/", topLevelSite: TOP };
    clock.t = 9_999;
    assert.equal(jar.getCookieHeader(ctx), "a=1");
    clock.t = 10_000;
    assert.equal(jar.getCookieHeader(ctx), "");
    assert.equal(jar.size, 0);
  });

  it("Max-Age takes precedence over Expires", () => {
    const { jar, clock } = makeJar(Date.parse("Wed, 01 Jan 2025 00:00:00 GMT"));
    // Expires in the past, but Max-Age keeps it alive.
    jar.setCookie(
      "a=1; Max-Age=100; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      { requestUrl: "https://example.com/", topLevelSite: TOP },
    );
    assert.equal(jar.size, 1);
    // Expires in the future, but Max-Age=0 deletes it.
    jar.setCookie(
      "a=1; Max-Age=0; Expires=Wed, 01 Jan 2048 00:00:00 GMT",
      { requestUrl: "https://example.com/", topLevelSite: TOP },
    );
    assert.equal(jar.size, 0);
    clock.t += 1;
  });

  it("honors Expires when no Max-Age is present", () => {
    const { jar, clock } = makeJar(Date.parse("Wed, 01 Jan 2025 00:00:00 GMT"));
    const ctx = { requestUrl: "https://example.com/", topLevelSite: TOP };
    jar.setCookie("a=1; Expires=Thu, 02 Jan 2025 00:00:00 GMT", ctx);
    assert.equal(jar.getCookieHeader(ctx), "a=1");
    clock.t = Date.parse("Thu, 02 Jan 2025 00:00:00 GMT");
    assert.equal(jar.getCookieHeader(ctx), "");
  });
});

describe("ordering and updates", () => {
  it("sorts same-name cookies by longest path, then creation order", () => {
    const { jar } = makeJar();
    const ctx = { requestUrl: "https://example.com/app/deep/x", topLevelSite: TOP };
    jar.setCookie("n=root; Path=/", ctx);
    jar.setCookie("n=deep; Path=/app/deep", ctx);
    jar.setCookie("n=app; Path=/app", ctx);
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://example.com/app/deep/page",
        topLevelSite: TOP,
      }),
      "n=deep; n=app; n=root",
    );
  });

  it("keeps creation order across updates of the same cookie", () => {
    const { jar } = makeJar();
    const ctx = { requestUrl: "https://example.com/", topLevelSite: TOP };
    jar.setCookie("a=1; Path=/", ctx);
    jar.setCookie("b=1; Path=/", ctx);
    jar.setCookie("a=2; Path=/", ctx);
    assert.equal(jar.size, 2);
    assert.equal(jar.getCookieHeader(ctx), "a=2; b=1");
  });

  it("treats cookies with different paths as distinct entries", () => {
    const { jar } = makeJar();
    const ctx = { requestUrl: "https://example.com/", topLevelSite: TOP };
    jar.setCookie("n=1; Path=/", ctx);
    jar.setCookie("n=2; Path=/sub", ctx);
    assert.equal(jar.size, 2);
    assert.equal(
      jar.getCookieHeader({
        requestUrl: "https://example.com/sub/page",
        topLevelSite: TOP,
      }),
      "n=2; n=1",
    );
  });
});
