"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateStore = exports.ACTIONS = void 0;
exports.keysHeld = keysHeld;
exports.popcount = popcount;
exports.stateKey = stateKey;
exports.ACTIONS = ["up", "down", "left", "right"];
const DELTA = {
    up: [0, -1],
    down: [0, 1],
    left: [-1, 0],
    right: [1, 0],
};
/** 当前持有的钥匙 = 已拾取且未被开门消耗（门 i 消耗钥匙 i） */
function keysHeld(s) {
    return s.collected & ~s.doorsOpen;
}
function popcount(n) {
    let c = 0;
    while (n) {
        n &= n - 1;
        c++;
    }
    return c;
}
class StateStore {
    level;
    versions = [];
    constructor(level) {
        this.level = level;
    }
    /** 创建初始版本（version 0） */
    initial() {
        if (this.versions.length !== 0)
            throw new Error("initial state already exists");
        const s = {
            version: 0, parent: -1, action: null,
            pos: this.level.start, collected: 0, doorsOpen: 0,
        };
        this.versions.push(s);
        return s;
    }
    get(version) {
        const s = this.versions[version];
        if (!s)
            throw new Error(`unknown version ${version}`);
        return s;
    }
    get size() {
        return this.versions.length;
    }
    /**
     * 应用一个动作，返回新版本；动作非法（撞墙/出界/无钥匙开门）返回 null。
     * 走进钥匙格自动拾取；走进关闭的门且持有对应钥匙时开门并消耗钥匙。
     */
    apply(from, action) {
        const L = this.level;
        const [dx, dy] = DELTA[action];
        const x = (from.pos % L.width) + dx;
        const y = Math.floor(from.pos / L.width) + dy;
        if (x < 0 || y < 0 || x >= L.width || y >= L.height)
            return null;
        const next = y * L.width + x;
        if (L.walls[next])
            return null;
        let { collected, doorsOpen } = from;
        const doorId = L.doorAt.get(next);
        if (doorId !== undefined && !(doorsOpen & (1 << doorId))) {
            if (!(keysHeld(from) & (1 << doorId)))
                return null; // 没有对应钥匙
            doorsOpen |= 1 << doorId; // 开门，消耗钥匙（keysHeld 随之减少）
        }
        const keyId = L.keyAt.get(next);
        if (keyId !== undefined)
            collected |= 1 << keyId;
        const s = {
            version: this.versions.length,
            parent: from.version,
            action,
            pos: next,
            collected,
            doorsOpen,
        };
        this.versions.push(s);
        return s;
    }
    /** 撤销一步：返回父版本。门随之恢复关闭，已消耗的钥匙自动返还。 */
    undo(s) {
        return s.parent < 0 ? null : this.get(s.parent);
    }
    /** 从任意历史版本分叉（版本不可变，直接取用即可继续 apply） */
    fork(version) {
        return this.get(version);
    }
    /** 从 stopAt 版本（不含，默认根）到 s 的动作序列 */
    pathTo(s, stopAt = -1) {
        const out = [];
        let cur = s;
        while (cur.parent >= 0 && cur.version !== stopAt) {
            out.push(cur.action);
            cur = this.get(cur.parent);
        }
        return out.reverse();
    }
}
exports.StateStore = StateStore;
/** 全状态去重键：位置 + 已拾取钥匙 + 已开门 */
function stateKey(s) {
    return `${s.pos}|${s.collected}|${s.doorsOpen}`;
}
