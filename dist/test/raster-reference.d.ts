/**
 * 逐毫秒栅格参照实现：与被测库完全独立，用于随机操作对照。
 * 直接维护一份字幕数组 + 快照栈，可见性按毫秒逐点暴力求解。
 */
import type { SubtitleView, VisibleSegment } from "../src/subtitle-editor.js";
interface RasterRecord {
    id: number;
    layer: number;
    start: number;
    end: number;
    text: string;
    seq: number;
}
export declare class RasterReference {
    private state;
    private undoStack;
    get version(): number;
    insert(layer: number, start: number, end: number, text?: string): number;
    crop(id: number, start: number, end: number): boolean;
    undo(): boolean;
    list(): SubtitleView[];
    /** 逐毫秒求可见者，再合并为最大连续段。 */
    visibleSegments(): VisibleSegment[];
    winnerAt(t: number): RasterRecord | null;
}
export {};
