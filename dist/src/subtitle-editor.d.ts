/**
 * 字幕编辑器：区间插入、裁剪、撤销，以及可见段计算。
 *
 * 区间均为半开区间 [start, end)，单位毫秒。
 * 遮挡规则：同一时刻，层（layer）大的字幕遮挡层小的；层相同时，后插入的优先。
 */
export type SubtitleId = number;
export interface InsertOptions {
    layer: number;
    /** 起始毫秒（含） */
    start: number;
    /** 结束毫秒（不含） */
    end: number;
    text?: string;
}
export interface SubtitleView {
    id: SubtitleId;
    layer: number;
    start: number;
    end: number;
    text: string;
    /** 插入序号，用于同层时“后插入优先”的判定 */
    seq: number;
}
/** 一段最大连续可见区间及其来源字幕 */
export interface VisibleSegment {
    start: number;
    end: number;
    source: SubtitleId;
    layer: number;
    text: string;
}
export declare class SubtitleEditor {
    private state;
    private undoStack;
    /** 当前版本号：每次成功的插入/裁剪 +1，撤销后恢复到操作前的版本号。 */
    get version(): number;
    get canUndo(): boolean;
    /** 插入一条字幕，返回其 id。 */
    insert(options: InsertOptions): SubtitleId;
    /**
     * 将 id 对应的字幕裁剪到窗口 [start, end) 内（取交集）。
     * 交集为空时该字幕被移除。id 不存在时返回 false 且不产生版本变化。
     */
    crop(id: SubtitleId, start: number, end: number): boolean;
    /** 撤销最近一次插入/裁剪，恢复到操作前的同一版本。无可撤销时返回 false。 */
    undo(): boolean;
    /** 按插入顺序列出当前所有字幕（副本）。 */
    list(): SubtitleView[];
    get(id: SubtitleId): SubtitleView | undefined;
    /** t 毫秒处可见的字幕；无覆盖时返回 null。 */
    visibleAt(t: number): SubtitleView | null;
    /**
     * 计算最大连续可见段：相邻且来源相同的基本区间会被合并。
     * 只返回有字幕覆盖的段，段与段之间按时间升序、互不重叠。
     */
    visibleSegments(): VisibleSegment[];
    private pushUndo;
}
