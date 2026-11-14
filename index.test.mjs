import test from "node:test";
import assert from "node:assert/strict";

import {
  CookieJar,
  filterSnapshotForTopLevelSite,
  importSnapshot,
  mergeSetCookieEvents,
  mergeSnapshots,
  normalizeTopLevelSite,
  parseSetCookie,
} from "./.test-dist/index.js";

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const FUTURE = Date.UTC(2035, 0, 15, 12, 0, 0);
const APP = "https://app.example.com";
const OTHER = "https://other.example.net";

function cookie(overrides = {}) {
  return {
    name: "sid",
    value: "value",
    domain: "example.com",
    path: "/",
    sameSite: "lax",
    secure: true,
    httpOnly: true,
    expires: FUTURE,
    generation: 1,
    partitionKey: null,
    ...overrides,
  };
}

test("normalizes schemeful sites for partition comparison", () => {
  assert.equal(
    normalizeTopLevelSite("HTTPS://Example.COM:8443/a/b?q=1"),
    "https://example.com",
  );
  assert.equal(normalizeTopLevelSite("example.com"), "https://example.com");
  assert.notEqual(
    normalizeTopLevelSite("http://example.com"),
    normalizeTopLevelSite("https://example.com"),
  );
});

test("filters by top-level site without stripping or inventing partition keys", () => {
  const snapshot = {
    format: "cookie-snapshot/v1",
    topLevelSite: APP,
    generation: 2,
    cookies: [
      cookie({ name: "global", partitionKey: null }),
      cookie({
        name: "appPartition",
        partitionKey: { topLevelSite: APP, hasCrossSiteAncestor: false },
      }),
      cookie({
        name: "appAncestor",
        partitionKey: { topLevelSite: APP, hasCrossSiteAncestor: true },
      }),
      cookie({
        name: "otherPartition",
        partitionKey: { topLevelSite: OTHER, hasCrossSiteAncestor: false },
      }),
    ],
  };

  const filtered = filterSnapshotForTopLevelSite(snapshot, `${APP}/`, {
    now: NOW,
  });
  assert.deepEqual(
    filtered.cookies.map((entry) => entry.name),
    ["appAncestor", "appPartition", "global"],
  );

  const appPartition = filtered.cookies.find(
    (entry) => entry.name === "appPartition",
  );
  assert.deepEqual(appPartition.partitionKey, {
    topLevelSite: APP,
    hasCrossSiteAncestor: false,
  });

  const appAncestor = filtered.cookies.find(
    (entry) => entry.name === "appAncestor",
  );
  assert.deepEqual(appAncestor.partitionKey, {
    topLevelSite: APP,
    hasCrossSiteAncestor: true,
  });

  assert.equal(
    filtered.cookies.some(
      (entry) => entry.name === "otherPartition" || entry.name === "appPartition" && entry.partitionKey === null,
    ),
    false,
  );
});

test("importSnapshot applies the partition filter before merging", () => {
  const snapshot = {
    cookies: [
      cookie({ name: "global" }),
      cookie({
        name: "appOnly",
        partitionKey: { topLevelSite: APP, hasCrossSiteAncestor: false },
      }),
      cookie({
        name: "otherOnly",
        partitionKey: { topLevelSite: OTHER, hasCrossSiteAncestor: false },
      }),
    ],
  };

  const imported = importSnapshot(snapshot, { topLevelSite: APP, now: NOW });
  assert.deepEqual(
    imported.cookies.map((entry) => entry.name),
    ["appOnly", "global"],
  );
  assert.equal(imported.topLevelSite, APP);
  assert.ok(
    imported.cookies.find((entry) => entry.name === "appOnly").partitionKey,
  );
  assert.equal(
    imported.cookies.some((entry) => entry.name === "otherOnly"),
    false,
  );
});

test("Partitioned Set-Cookie keeps its partition key and never degrades", () => {
  const jar = new CookieJar({ now: NOW });
  jar.applySetCookie(
    "sid=partitioned; Domain=example.com; Path=/; Secure; HttpOnly; SameSite=None; Partitioned",
    {
      generation: 4,
      topLevelSite: APP,
    requestUrl: "https://example.com/account",
    },
  );

  const stored = jar.getCookie("sid");
  assert.equal(stored.value, "partitioned");
  assert.equal(stored.sameSite, "None");
  assert.equal(stored.secure, true);
  assert.equal(stored.httpOnly, true);
  assert.deepEqual(stored.partitionKey, {
    topLevelSite: APP,
    hasCrossSiteAncestor: false,
  });

  jar.applySetCookie("normal=1; Path=/", {
    generation: 5,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  assert.equal(jar.getCookie("normal").partitionKey, null);

  assert.throws(
    () =>
      jar.applySetCookie("lost=1; Path=/; Partitioned", {
        generation: 6,
        requestUrl: "https://example.com/",
      }),
    /topLevelSite/,
  );
});

test("concurrent Set-Cookie events merge by response generation regardless of arrival order", () => {
  const oldEvent = {
    header: "sid=old; Path=/; Max-Age=3600",
    generation: 3,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  };
  const newEvent = {
    header: "sid=new; Path=/; Max-Age=3600",
    generation: 8,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  };
  const independentOld = {
    header: "legacy=still-here; Path=/; Max-Age=3600",
    generation: 2,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  };

  const first = mergeSetCookieEvents([oldEvent, newEvent, independentOld], {
    now: NOW,
    topLevelSite: APP,
  });
  assert.equal(first.cookies.find((entry) => entry.name === "sid").value, "new");
  assert.equal(
    first.cookies.find((entry) => entry.name === "legacy").value,
    "still-here",
  );

  const reversed = mergeSetCookieEvents([newEvent, oldEvent], {
    now: NOW,
    topLevelSite: APP,
  });
  assert.equal(
    reversed.cookies.find((entry) => entry.name === "sid").value,
    "new",
  );
});

test("deletion tombstones prevent old snapshots and late responses from resurrecting cookies", () => {
  const jar = new CookieJar({ now: NOW });
  jar.applySetCookie("sid=live; Path=/; Max-Age=3600", {
    generation: 3,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  jar.applySetCookie("sid=; Path=/; Max-Age=0", {
    generation: 5,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  assert.equal(jar.getCookie("sid"), null);

  const deletion = jar.toSnapshot({ topLevelSite: APP });
  assert.equal(deletion.tombstones.length, 1);
  assert.equal(deletion.tombstones[0].name, "sid");
  assert.equal(deletion.tombstones[0].generation, 5);

  jar.import({ cookies: [cookie({ generation: 4 })] }, {
    topLevelSite: APP,
    now: NOW,
  });
  assert.equal(jar.getCookie("sid"), null);

  jar.applySetCookie("sid=late; Path=/; Max-Age=3600", {
    generation: 4,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  assert.equal(jar.getCookie("sid"), null);

  jar.applySetCookie("sid=fresh; Path=/; Max-Age=3600", {
    generation: 6,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  assert.equal(jar.getCookie("sid").value, "fresh");
});

test("expired snapshot entries become tombstones instead of live cookies", () => {
  const jar = new CookieJar({ now: NOW });
  jar.import(
    {
      cookies: [
        cookie({
          generation: 9,
          expires: NOW - 1,
        }),
      ],
    },
    { topLevelSite: APP, now: NOW },
  );

  assert.equal(jar.size, 0);
  const snapshot = jar.toSnapshot({ topLevelSite: APP });
  assert.equal(snapshot.tombstones.length, 1);
  assert.equal(snapshot.tombstones[0].reason, "expired");
  assert.equal(snapshot.tombstones[0].generation, 9);

  jar.import({ cookies: [cookie({ generation: 8 })] }, {
    topLevelSite: APP,
    now: NOW,
  });
  assert.equal(jar.size, 0);
});

test("mergeSnapshots is order independent for generations and keeps tombstones", () => {
  const oldSnapshot = {
    generation: 1,
    cookies: [cookie({ name: "sid", value: "old", generation: 1 })],
  };
  const newSnapshot = {
    generation: 7,
    tombstones: [
      {
        name: "sid",
        domain: "example.com",
        path: "/",
        hostOnly: true,
        partitionKey: null,
        deleted: true,
        reason: "set-cookie",
        generation: 7,
      },
    ],
  };

  const oldThenNew = mergeSnapshots([oldSnapshot, newSnapshot], APP);
  const newThenOld = mergeSnapshots([newSnapshot, oldSnapshot], APP);

  assert.equal(oldThenNew.cookies.length, 0);
  assert.equal(newThenOld.cookies.length, 0);
  assert.equal(oldThenNew.tombstones.length, 1);
  assert.equal(newThenOld.tombstones.length, 1);
  assert.equal(newThenOld.tombstones[0].generation, 7);
});

test("Set-Cookie parser represents SameSite, flags, expiry and Max-Age precedence", () => {
  const parsed = parseSetCookie(
    'sid="a;b"; Domain=.Example.COM; Path=/app; Secure; HttpOnly; SameSite=No_Restriction; Max-Age=60',
    { now: NOW },
  );

  assert.equal(parsed.name, "sid");
  assert.equal(parsed.value, "a;b");
  assert.equal(parsed.domain, ".Example.COM");
  assert.equal(parsed.path, "/app");
  assert.equal(parsed.sameSite, "None");
  assert.equal(parsed.secure, true);
  assert.equal(parsed.httpOnly, true);
  assert.equal(parsed.maxAge, 60);
  assert.equal(parsed.expires, NOW + 60_000);
  assert.equal(parsed.deleted, false);
});

test("Chrome-style cookie fields and epoch-second expiry import correctly", () => {
  const chromeCookie = {
    name: "chrome",
    value: "v",
    domain: ".example.com",
    hostOnly: false,
    path: "/",
    sameSite: "no_restriction",
    secure: true,
    httpOnly: false,
    expirationDate: Math.floor(FUTURE / 1000),
    generation: 2,
  };
  const imported = importSnapshot({ cookies: [chromeCookie] }, APP);
  const stored = imported.cookies[0];

  assert.equal(stored.sameSite, "None");
  assert.equal(stored.expires, Math.floor(FUTURE / 1000) * 1000);
  assert.equal(stored.domain, ".example.com");
  assert.equal(stored.hostOnly, false);
});

test("a mismatched partition is skipped even when an unpartitioned copy would fit", () => {
  const snapshot = {
    cookies: [
      cookie({
        name: "private",
        value: "other-site",
        partitionKey: { topLevelSite: OTHER, hasCrossSiteAncestor: true },
      }),
    ],
  };

  const imported = importSnapshot(snapshot, APP);
  assert.equal(imported.cookies.length, 0);
  assert.equal(imported.tombstones.length, 0);
});

test("natural expiry becomes a tombstone that blocks older generations", () => {
  let now = NOW;
  const jar = new CookieJar({ now: () => now });
  jar.applySetCookie("sid=short; Path=/; Max-Age=1", {
    generation: 11,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  assert.equal(jar.getCookie("sid").value, "short");

  now += 2_000;
  assert.equal(jar.getCookie("sid"), null);
  const snapshot = jar.toSnapshot({ topLevelSite: APP });
  assert.equal(snapshot.tombstones[0].reason, "expired");

  jar.import({ cookies: [cookie({ generation: 10 })] }, {
    topLevelSite: APP,
    now,
  });
  assert.equal(jar.size, 0);
});

test("JSON snapshot round-trips partition keys and tombstones", () => {
  const jar = new CookieJar({ now: NOW });
  jar.applySetCookie(
    "part=value; Domain=example.com; Path=/; Secure; HttpOnly; Partitioned",
    {
      generation: 12,
      topLevelSite: APP,
      requestUrl: "https://example.com/",
    },
  );
  jar.applySetCookie("gone=1; Path=/", {
    generation: 13,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });
  jar.applySetCookie("gone=; Path=/; Max-Age=0", {
    generation: 14,
    topLevelSite: APP,
    requestUrl: "https://example.com/",
  });

  const json = JSON.stringify(jar.toSnapshot({ topLevelSite: APP }));
  const restored = importSnapshot(JSON.parse(json), APP);

  assert.deepEqual(restored.cookies[0].partitionKey, {
    topLevelSite: APP,
    hasCrossSiteAncestor: false,
  });
  assert.equal(restored.tombstones.length, 1);
  assert.equal(restored.tombstones[0].name, "gone");
  assert.equal(restored.tombstones[0].generation, 14);
});
