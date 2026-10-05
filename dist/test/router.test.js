import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { canonicalizeUrl, matchRoute } from '../src/index.js';
const ROUTES = [
    { name: 'user', pattern: '/users/{id}' },
    { name: 'ab', pattern: '/a/b' },
    { name: 'file', pattern: '/files/{name}' },
    { name: 'root', pattern: '/' },
];
function originalPath(url) {
    const noFrag = url.split('#')[0];
    const noQuery = noFrag.split('?')[0];
    const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/.exec(noQuery);
    return m ? noQuery.slice(m[0].length) : noQuery;
}
describe('independent matcher cross-check', () => {
    const cases = [
        'http://h/users/%7Ebob?x=1',
        'http://h/x/../a/./b',
        'http://h/files/a%2Fb',
        'http://h/files/%C3%A9',
        'http://h/users/bob',
        'http://h/./',
        '/a/./b',
    ];
    for (const url of cases) {
        test(`key equivalence preserves route semantics: ${url}`, () => {
            const c = canonicalizeUrl(url);
            const before = matchRoute(ROUTES, originalPath(url));
            const after = matchRoute(ROUTES, c.canonicalPath);
            assert.ok(before !== null, `original ${url} should match a route`);
            assert.deepEqual(after, before);
        });
    }
    test('captured params agree between original and canonical forms', () => {
        const c = canonicalizeUrl('http://h/users/%7Ebob');
        const before = matchRoute(ROUTES, '/users/%7Ebob');
        const after = matchRoute(ROUTES, c.canonicalPath);
        assert.equal(before.name, 'user');
        assert.equal(before.params['id'], '~bob');
        assert.equal(after.params['id'], before.params['id']);
    });
    test('reserved escapes decode identically on both sides', () => {
        const c = canonicalizeUrl('http://h/files/a%2Fb');
        assert.equal(c.canonicalPath, '/files/a%2Fb'); // reserved byte stays encoded
        const before = matchRoute(ROUTES, '/files/a%2Fb');
        const after = matchRoute(ROUTES, c.canonicalPath);
        assert.equal(before.params['name'], 'a/b');
        assert.deepEqual(after, before);
    });
});
