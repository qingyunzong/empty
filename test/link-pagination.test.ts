import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findLink, LinkHeaderParseError, parseLinkHeader } from '../src/link-header.ts';
import {
  type Checkpoint,
  CrossOriginNextError,
  normalizeUrl,
  paginate,
} from '../src/paginator.ts';

describe('parseLinkHeader', () => {
  it('parses a simple next link', () => {
    const [entry] = parseLinkHeader('</page/2>; rel="next"');
    assert.equal(entry.target, '/page/2');
    assert.deepEqual(entry.rels, ['next']);
  });

  it('keeps commas inside the URI-reference', () => {
    const entries = parseLinkHeader('</items?ids=1,2,3>; rel="next"');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].target, '/items?ids=1,2,3');
  });

  it('does not split on commas inside quoted-strings', () => {
    const entries = parseLinkHeader('</a>; rel="next"; title="x, y; z", </b>; rel="last"');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].params.title, 'x, y; z');
    assert.equal(entries[1].target, '/b');
  });

  it('parses multiple relation types in one rel param', () => {
    const [entry] = parseLinkHeader('</p2>; rel="next prev"');
    assert.deepEqual(entry.rels, ['next', 'prev']);
    assert.equal(findLink([entry], 'prev'), entry);
  });

  it('parses multiple link-values', () => {
    const entries = parseLinkHeader('<https://a/1>; rel="prev", </2>; rel="next"');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.rels[0]), ['prev', 'next']);
  });

  it('accepts token-form (unquoted) parameter values', () => {
    const [entry] = parseLinkHeader('</2>; rel=next; type="application/json"');
    assert.deepEqual(entry.rels, ['next']);
    assert.equal(entry.params.type, 'application/json');
  });

  it('unescapes quoted-pairs inside quoted-strings', () => {
    const [entry] = parseLinkHeader('</2>; rel="next"; title="say \\"hi\\" \\\\ ok"');
    assert.equal(entry.params.title, 'say "hi" \\ ok');
  });

  it('matches relation types case-insensitively', () => {
    const entries = parseLinkHeader('</2>; REL="Next"');
    assert.ok(findLink(entries, 'NEXT'));
  });

  it('handles parameters without values', () => {
    const [entry] = parseLinkHeader('</2>; rel="next"; foo');
    assert.equal(entry.params.foo, '');
  });

  it('tolerates empty list members', () => {
    const entries = parseLinkHeader('</a>; rel="next", , </b>; rel="last"');
    assert.equal(entries.length, 2);
  });

  it('rejects malformed headers', () => {
    assert.throws(() => parseLinkHeader('/no-brackets; rel="next"'), LinkHeaderParseError);
    assert.throws(() => parseLinkHeader('</unterminated; rel="next"'), LinkHeaderParseError);
    assert.throws(() => parseLinkHeader('</a>; rel="next" junk'), LinkHeaderParseError);
    assert.throws(() => parseLinkHeader('</a>; title="unterminated'), LinkHeaderParseError);
  });
});

describe('normalizeUrl', () => {
  it('resolves relative references against the base', () => {
    assert.equal(normalizeUrl('/p/2', 'https://api.example.com/p/1'), 'https://api.example.com/p/2');
    assert.equal(normalizeUrl('?page=2', 'https://a.example.com/list?page=1'), 'https://a.example.com/list?page=2');
    assert.equal(normalizeUrl('../v2/items', 'https://a.example.com/v1/items'), 'https://a.example.com/v2/items');
  });

  it('canonicalizes case, default ports and fragments', () => {
    assert.equal(normalizeUrl('HTTPS://API.Example.COM:443/a#frag', 'https://x.example.com/'), 'https://api.example.com/a');
    assert.equal(normalizeUrl('http://a.example.com:80/x', 'http://a.example.com/'), 'http://a.example.com/x');
  });
});

interface MockPage {
  body: string;
  linkHeader?: string | null;
}

function mockFetch(pages: Record<string, MockPage>, events: string[]) {
  return async (url: string) => {
    events.push(`fetch:${url}`);
    const page = pages[url];
    assert.ok(page, `unexpected fetch of ${url}`);
    return page;
  };
}

describe('paginate', () => {
  it('follows next links and returns the visited path', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/items?page=1': {
        body: 'p1',
        linkHeader: '</items?page=2>; rel="next", </items?page=9>; rel="last"',
      },
      'https://api.example.com/items?page=2': {
        body: 'p2',
        linkHeader: '<https://api.example.com/items?page=3>; rel="next"',
      },
      'https://api.example.com/items?page=3': { body: 'p3' },
    };
    const events: string[] = [];
    const result = await paginate({
      startUrl: 'https://api.example.com/items?page=1',
      fetchPage: mockFetch(pages, events),
      sink: async (page) => {
        events.push(`sink:${page.url}`);
      },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.path, [
      'https://api.example.com/items?page=1',
      'https://api.example.com/items?page=2',
      'https://api.example.com/items?page=3',
    ]);
    assert.equal(result.resumeFrom, null);
  });

  it('commits the resume point only after the sink confirms', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '</p2>; rel="next"' },
      'https://api.example.com/p2': { body: 'b' },
    };
    const events: string[] = [];
    const checkpoints: Checkpoint[] = [];
    await paginate({
      startUrl: 'https://api.example.com/p1',
      fetchPage: mockFetch(pages, events),
      sink: async (page) => {
        events.push(`sink:${page.url}`);
      },
      checkpointStore: {
        commit: (cp) => {
          events.push(`commit:${cp.nextUrl}`);
          checkpoints.push(cp);
        },
      },
    });
    assert.deepEqual(events, [
      'fetch:https://api.example.com/p1',
      'sink:https://api.example.com/p1',
      'commit:https://api.example.com/p2',
      'fetch:https://api.example.com/p2',
      'sink:https://api.example.com/p2',
      'commit:null',
    ]);
    assert.deepEqual(checkpoints, [
      { nextUrl: 'https://api.example.com/p2', pagesCompleted: 1 },
      { nextUrl: null, pagesCompleted: 2 },
    ]);
  });

  it('does not commit a checkpoint when the sink fails', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '</p2>; rel="next"' },
    };
    const commits: Checkpoint[] = [];
    await assert.rejects(
      paginate({
        startUrl: 'https://api.example.com/p1',
        fetchPage: mockFetch(pages, []),
        sink: async () => {
          throw new Error('db write failed');
        },
        checkpointStore: {
          commit: (cp) => {
            commits.push(cp);
          },
        },
      }),
      /db write failed/,
    );
    assert.deepEqual(commits, []);
  });

  it('detects cycles and returns the path without duplicates', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '</p2>; rel="next"' },
      'https://api.example.com/p2': { body: 'b', linkHeader: '</p1>; rel="next"' },
    };
    const result = await paginate({
      startUrl: 'https://api.example.com/p1',
      fetchPage: mockFetch(pages, []),
      sink: async () => {},
    });
    assert.equal(result.status, 'cycle-detected');
    assert.deepEqual(result.path, ['https://api.example.com/p1', 'https://api.example.com/p2']);
  });

  it('rejects cross-origin next links outside the whitelist', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '<https://evil.example.net/steal>; rel="next"' },
    };
    await assert.rejects(
      paginate({
        startUrl: 'https://api.example.com/p1',
        fetchPage: mockFetch(pages, []),
        sink: async () => {},
      }),
      (err: unknown) => {
        if (!(err instanceof CrossOriginNextError)) return false;
        assert.equal(err.nextUrl, 'https://evil.example.net/steal');
        return true;
      },
    );
  });

  it('allows whitelisted cross-origin next links', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '<https://cdn.example.com/p2>; rel="next"' },
      'https://cdn.example.com/p2': { body: 'b' },
    };
    const result = await paginate({
      startUrl: 'https://api.example.com/p1',
      fetchPage: mockFetch(pages, []),
      sink: async () => {},
      allowedOrigins: ['https://cdn.example.com'],
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.path, ['https://api.example.com/p1', 'https://cdn.example.com/p2']);
  });

  it('rejects a resume point outside the whitelist', async () => {
    await assert.rejects(
      paginate({
        startUrl: 'https://api.example.com/p1',
        resumeFrom: 'https://evil.example.net/p9',
        fetchPage: mockFetch({}, []),
        sink: async () => {},
      }),
      CrossOriginNextError,
    );
  });

  it('resumes from a committed checkpoint', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p2': { body: 'b' },
    };
    const result = await paginate({
      startUrl: 'https://api.example.com/p1',
      resumeFrom: 'https://api.example.com/p2',
      fetchPage: mockFetch(pages, []),
      sink: async () => {},
    });
    assert.deepEqual(result.path, ['https://api.example.com/p2']);
  });

  it('follows next URLs containing commas end-to-end', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/items': {
        body: 'a',
        linkHeader: '</items?ids=1,2,3&cursor=abc>; rel="next"; note="has, comma"',
      },
      'https://api.example.com/items?ids=1,2,3&cursor=abc': { body: 'b' },
    };
    const result = await paginate({
      startUrl: 'https://api.example.com/items',
      fetchPage: mockFetch(pages, []),
      sink: async () => {},
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.path, [
      'https://api.example.com/items',
      'https://api.example.com/items?ids=1,2,3&cursor=abc',
    ]);
  });

  it('stops at maxPages and reports the resume point', async () => {
    const pages: Record<string, MockPage> = {
      'https://api.example.com/p1': { body: 'a', linkHeader: '</p2>; rel="next"' },
      'https://api.example.com/p2': { body: 'b', linkHeader: '</p3>; rel="next"' },
    };
    const result = await paginate({
      startUrl: 'https://api.example.com/p1',
      fetchPage: mockFetch(pages, []),
      sink: async () => {},
      maxPages: 2,
    });
    assert.equal(result.status, 'max-pages-reached');
    assert.equal(result.resumeFrom, 'https://api.example.com/p3');
  });
});
