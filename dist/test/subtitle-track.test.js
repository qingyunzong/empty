import test from "node:test";
import assert from "node:assert/strict";
import { SubtitleTrack, } from "../src/subtitle-track.js";
// ---------------------------------------------------------------------------
// Independent brute-force raster model: one sample per millisecond.
// ---------------------------------------------------------------------------
function rasterWinner(clips, t) {
    let best = null;
    for (const c of clips) {
        if (c.start <= t && t < c.end) {
            if (best === null ||
                c.layer > best.layer ||
                (c.layer === best.layer && c.seq > best.seq)) {
                best = c;
            }
        }
    }
    return best;
}
/** Compress the per-ms raster into maximal runs of the same source clip. */
function rasterSegments(clips) {
    const maxEnd = clips.reduce((m, c) => Math.max(m, c.end), 0);
    const runs = [];
    for (let t = 0; t < maxEnd; t++) {
        const winner = rasterWinner(clips, t);
        if (!winner)
            continue;
        const last = runs[runs.length - 1];
        if (last && last.end === t && last.clipId === winner.id) {
            runs[runs.length - 1] = { ...last, end: t + 1 };
        }
        else {
            runs.push({ start: t, end: t + 1, clipId: winner.id, layer: winner.layer });
        }
    }
    return runs;
}
function assertMatchesRaster(track) {
    const clips = track.getClips();
    assert.deepEqual(track.visibleSegments(), rasterSegments(clips));
    // Spot-check visibleAt against the raster at every covered millisecond.
    const maxEnd = clips.reduce((m, c) => Math.max(m, c.end), 0);
    for (let t = 0; t < maxEnd; t++) {
        const expected = rasterWinner(clips, t);
        const actual = track.visibleAt(t);
        assert.equal(actual?.id ?? null, expected?.id ?? null, `visibleAt(${t})`);
    }
}
// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) for reproducible random tests.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------
test("higher layer occludes lower layer", () => {
    const track = new SubtitleTrack();
    const low = track.insert(0, 100, 0);
    const high = track.insert(40, 60, 1);
    assert.deepEqual(track.visibleSegments(), [
        { start: 0, end: 40, clipId: low, layer: 0 },
        { start: 40, end: 60, clipId: high, layer: 1 },
        { start: 60, end: 100, clipId: low, layer: 0 },
    ]);
});
test("same layer: later insert wins", () => {
    const track = new SubtitleTrack();
    const first = track.insert(0, 100, 2);
    const second = track.insert(50, 150, 2);
    assert.deepEqual(track.visibleSegments(), [
        { start: 0, end: 50, clipId: first, layer: 2 },
        { start: 50, end: 150, clipId: second, layer: 2 },
    ]);
});
test("half-open intervals: boundary belongs to the next clip, adjacency merges", () => {
    const track = new SubtitleTrack();
    const a = track.insert(0, 50, 0);
    const b = track.insert(50, 100, 0);
    assert.equal(track.visibleAt(49)?.id, a);
    assert.equal(track.visibleAt(50)?.id, b);
    assert.equal(track.visibleAt(100), null);
    // Same clip cropped into two abutting pieces still reports one segment.
    const track2 = new SubtitleTrack();
    const id = track2.insert(0, 100, 0);
    track2.crop(id, 0, 100);
    assert.deepEqual(track2.visibleSegments(), [
        { start: 0, end: 100, clipId: id, layer: 0 },
    ]);
});
test("crop trims to intersection and reveals occluded clips", () => {
    const track = new SubtitleTrack();
    const low = track.insert(0, 100, 0);
    const high = track.insert(0, 100, 1);
    track.crop(high, 20, 40);
    assert.deepEqual(track.visibleSegments(), [
        { start: 0, end: 20, clipId: low, layer: 0 },
        { start: 20, end: 40, clipId: high, layer: 1 },
        { start: 40, end: 100, clipId: low, layer: 0 },
    ]);
    // Crop outside the clip removes it entirely.
    assert.equal(track.crop(high, 500, 600), true);
    assert.deepEqual(track.visibleSegments(), [
        { start: 0, end: 100, clipId: low, layer: 0 },
    ]);
});
test("undo restores the exact pre-mutation version and state", () => {
    const track = new SubtitleTrack();
    const a = track.insert(0, 100, 0);
    const b = track.insert(10, 20, 5);
    const stateV2 = JSON.stringify(track.getClips());
    const versionV2 = track.version;
    track.crop(a, 30, 50);
    track.remove(b);
    track.insert(200, 300, 1);
    assert.equal(track.undo(), true);
    assert.equal(track.undo(), true);
    assert.equal(track.undo(), true);
    assert.equal(track.version, versionV2);
    assert.equal(JSON.stringify(track.getClips()), stateV2);
    assertMatchesRaster(track);
    assert.equal(track.undo(), true); // undoes insert of b
    assert.equal(track.undo(), true); // undoes insert of a
    assert.equal(track.version, 0);
    assert.deepEqual(track.getClips(), []);
    assert.equal(track.undo(), false); // nothing left
});
test("undo of crop restores the untrimmed interval", () => {
    const track = new SubtitleTrack();
    const id = track.insert(0, 100, 0);
    track.crop(id, 10, 20);
    assert.deepEqual(track.visibleSegments(), [
        { start: 10, end: 20, clipId: id, layer: 0 },
    ]);
    track.undo();
    assert.deepEqual(track.visibleSegments(), [
        { start: 0, end: 100, clipId: id, layer: 0 },
    ]);
});
test("invalid intervals and unknown ids are rejected", () => {
    const track = new SubtitleTrack();
    assert.throws(() => track.insert(50, 50, 0), RangeError);
    assert.throws(() => track.insert(60, 50, 0), RangeError);
    assert.throws(() => track.insert(-1, 50, 0), RangeError);
    assert.throws(() => track.insert(0.5, 50, 0), RangeError);
    assert.equal(track.crop(999, 0, 10), false);
    assert.equal(track.remove(999), false);
    assert.equal(track.version, 0); // failed ops do not create versions
});
// ---------------------------------------------------------------------------
// Randomized property test: random insert/crop/remove/undo sequences must
// always agree with the per-millisecond raster, and undo must restore the
// exact earlier version.
// ---------------------------------------------------------------------------
test("random operations match the per-millisecond raster", () => {
    for (let seed = 1; seed <= 40; seed++) {
        const rand = mulberry32(seed);
        const track = new SubtitleTrack();
        // Mirror of committed states to verify undo restores identical versions.
        const stateLog = [JSON.stringify({ v: 0, clips: [] })];
        for (let step = 0; step < 120; step++) {
            const roll = rand();
            const liveIds = track.getClips().map((c) => c.id);
            if (roll < 0.45 || liveIds.length === 0) {
                const start = Math.floor(rand() * 300);
                const end = start + 1 + Math.floor(rand() * 120);
                const layer = Math.floor(rand() * 4);
                track.insert(start, end, layer);
                stateLog.push(JSON.stringify({ v: track.version, clips: track.getClips() }));
            }
            else if (roll < 0.7) {
                const id = liveIds[Math.floor(rand() * liveIds.length)];
                const start = Math.floor(rand() * 300);
                const end = start + 1 + Math.floor(rand() * 120);
                track.crop(id, start, end);
                stateLog.push(JSON.stringify({ v: track.version, clips: track.getClips() }));
            }
            else if (roll < 0.8) {
                const id = liveIds[Math.floor(rand() * liveIds.length)];
                track.remove(id);
                stateLog.push(JSON.stringify({ v: track.version, clips: track.getClips() }));
            }
            else {
                const undone = track.undo();
                if (undone)
                    stateLog.pop();
                const expected = stateLog[stateLog.length - 1];
                assert.equal(JSON.stringify({ v: track.version, clips: track.getClips() }), expected, `seed ${seed} step ${step}: undo must restore the identical version`);
            }
            assertMatchesRaster(track);
        }
    }
});
