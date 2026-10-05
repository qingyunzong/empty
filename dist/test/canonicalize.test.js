import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { canonicalizeUrl, CanonicalizationError } from '../src/index.js';
describe('path dot-segment removal', () => {
    const cases = [
        ['/a/b/../c', '/a/c'],
        ['/a/./b', '/a/b'],
        ['/../a', '/a'],
        ['/a/../../b', '/b'],
        ['/a/b/..', '/a/'],
        ['/a/b/.', '/a/b/'],
        ['/%2e/b', '/b'],
        ['/a/%2E%2e/c', '/c'],
        ['/a/%2e./../b', '/b'],
        ['/', '/'],
        ['', '/'],
        ['/a//b', '/a//b'],
        ['/a/b/', '/a/b/'],
    ];
    for (const [input, expected] of cases) {
        test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
            assert.equal(canonicalizeUrl(input).canonicalPath, expected);
        });
    }
});
describe('percent handling', () => {
    test('decodes unreserved ASCII only', () => {
        const c = canonicalizeUrl('/%7Euser/%41%2e%5F%2D');
        assert.equal(c.canonicalPath, '/~user/A._-');
    });
    test('reserved characters stay encoded, hex uppercased', () => {
        const c = canonicalizeUrl('/a%2fb%3ac%3fd');
        assert.equal(c.canonicalPath, '/a%2Fb%3Ac%3Fd');
    });
    test('non-ASCII bytes stay encoded; raw non-ASCII gets UTF-8 encoded', () => {
        assert.equal(canonicalizeUrl('/%c3%a9').canonicalPath, '/%C3%A9');
        assert.equal(canonicalizeUrl('/é').canonicalPath, '/%C3%A9');
    });
    test('query reserved characters preserved', () => {
        const c = canonicalizeUrl('/p?k=%2f%3a%40&v=%7e');
        assert.equal(c.canonicalQuery, 'k=%2F%3A%40&v=~');
    });
    test('idempotency: normalizing the canonical form again is a fixed point', () => {
        const originals = [
            'http://h/a/./b/../c/%7E?b=2&a=%2f&a=1#frag',
            '/%2e%2e/x/%c3%a9?z=%7e&z=%2F',
            'http://user@host:8080/p?q=a%2b&r=%41',
        ];
        for (const url of originals) {
            const once = canonicalizeUrl(url);
            const twice = canonicalizeUrl(once.canonical);
            assert.equal(twice.canonical, once.canonical, `not idempotent for ${url}`);
            assert.deepEqual([...twice.canonicalBytes], [...once.canonicalBytes]);
        }
    });
});
describe('invalid escapes reject the whole normalization', () => {
    for (const bad of ['/%', '/%2', '/%GG', '/a%1x', '/p?k=%', '/p?k=v%2', '/p?%zz=1']) {
        test(`${JSON.stringify(bad)} throws`, () => {
            assert.throws(() => canonicalizeUrl(bad), CanonicalizationError);
        });
    }
});
describe('query canonicalization', () => {
    test('duplicate keys preserved, sorted by key then value bytes', () => {
        const c = canonicalizeUrl('/p?b=2&a=1&a=0&b=1');
        assert.equal(c.canonicalQuery, 'a=0&a=1&b=1&b=2');
        assert.equal(c.params.length, 4);
        assert.deepEqual(c.params.map((p) => p.key), ['a', 'a', 'b', 'b']);
    });
    test('value-less pairs keep their form and sort before/after by bytes', () => {
        const c = canonicalizeUrl('/p?a&a=&b');
        assert.equal(c.canonicalQuery, 'a&a=&b');
        assert.equal(c.params[0]?.hasValue, false);
        assert.equal(c.params[1]?.hasValue, true);
    });
    test('empty query and missing query are distinct', () => {
        assert.equal(canonicalizeUrl('/p?').canonical, '/p?');
        assert.equal(canonicalizeUrl('/p').canonical, '/p');
    });
    test('fragment excluded from signature input', () => {
        const c = canonicalizeUrl('/p?a=1#frag?b=2');
        assert.equal(c.canonical, '/p?a=1');
    });
});
describe('equivalence derivation steps', () => {
    test('every normalization reports its derivation steps', () => {
        const c = canonicalizeUrl('http://h/a/./b/%7E?b=2&a=1&a=0#x');
        const joined = c.steps.join('\n');
        assert.match(joined, /fragment excluded/);
        assert.match(joined, /removed dot segment/);
        assert.match(joined, /decoded %7E -> '~'/);
        assert.match(joined, /duplicates preserved/);
        assert.match(joined, /sorted 3 pair\(s\)/);
        assert.ok(c.steps.length >= 5);
    });
    test('canonical bytes are the UTF-8 encoding of the canonical string', () => {
        const c = canonicalizeUrl('/p?x=%C3%A9');
        assert.deepEqual([...c.canonicalBytes], [...new TextEncoder().encode(c.canonical)]);
    });
});
