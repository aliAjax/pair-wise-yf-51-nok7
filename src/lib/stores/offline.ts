import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";
import { cues, logEvent, terms, tracks, type Cue, type CueStatus, type GlossaryTerm } from "./subtitles";

// 离线批次：外拍车断网前保存 base 同步点，回棚后保存 offline 快照，
// 与棚内当前副本（studio）按字幕条做三方合并。
export type OfflineBatchStatus = "离线中" | "待合并" | "部分合并" | "已合并" | "合并失败";
export type CueMergeStatus = "待合并" | "已合并" | "冲突待选" | "未通过术语校验" | "已跳过";
export type MergeField = "translated" | "start" | "end" | "status" | "deleted";
export type MergeSide = "offline" | "studio";

export interface FieldConflict {
  field: MergeField;
  label: string;
  offline: string;
  studio: string;
}

export interface CueMergeResult {
  cueId: string;
  source: string;
  status: CueMergeStatus;
  conflicts: FieldConflict[];
  choices: Partial<Record<MergeField, MergeSide>>;
  defaults: Partial<Record<MergeField, MergeSide>>;
  message?: string;
  termSource?: string;
  termTarget?: string;
}

export interface OfflineBatch {
  id: string;
  name: string;
  device: string;
  createdAt: string;
  checkedInAt?: string;
  status: OfflineBatchStatus;
  base: Cue[];
  offline: Cue[];
  results: CueMergeResult[];
}

const KEY = "pair-wise-yf-51/offline-batches-v1";
const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const offlineBatches = writable<OfflineBatch[]>(initial ?? []);
if (browser) offlineBatches.subscribe((items) => localStorage.setItem(KEY, JSON.stringify(items)));

export const activeOfflineBatch = derived(offlineBatches, ($batches) => $batches.find((batch) => batch.status === "离线中"));

const FIELD_LABELS: Record<MergeField, string> = { translated: "译文", start: "开始时间", end: "结束时间", status: "状态", deleted: "字幕存删" };
const MERGE_FIELDS = ["translated", "start", "end", "status"] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function formatTime(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  const tenths = Math.floor((value % 1) * 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

function displayValue(field: MergeField, value: string | number): string {
  return field === "start" || field === "end" ? formatTime(Number(value)) : String(value);
}

function cueShallowEqual(a: Cue, b: Cue) {
  return a.translated === b.translated && a.start === b.start && a.end === b.end && a.status === b.status;
}

function trackLocaleOf(cue: Cue) {
  return get(tracks).find((track) => track.id === cue.trackId)?.locale ?? "zh";
}

// 锁定术语校验：原文含锁定术语源词时，译文必须使用锁定译文。
// 基线译文里本就没有锁定译文的（如日语轨道不含英文 target）不算绕过；
// 基线里有、离线改动后被改掉，才算术语锁定被绕过。
export function termViolation(cue: Cue, baseline?: Cue): GlossaryTerm | undefined {
  if (trackLocaleOf(cue) === "zh") return undefined;
  return get(terms).find((term) =>
    term.status === "已锁定" &&
    cue.source.includes(term.source) &&
    !cue.translated.includes(term.target) &&
    (!baseline || baseline.translated.includes(term.target))
  );
}

interface Plan {
  kind: "adopt" | "add" | "remove" | "keep";
  cueId: string;
  cue?: Cue;
}

// 单条字幕三方合并：base（同步点）/ offline（离线快照）/ studio（棚内副本）
function evaluateCue(b: Cue | undefined, o: Cue | undefined, s: Cue | undefined): { result: CueMergeResult; plan: Plan } {
  // 离线新增的字幕
  if (!b && o) {
    const violation = termViolation(o, undefined);
    if (violation) {
      return {
        result: { cueId: o.id, source: o.source, status: "未通过术语校验", conflicts: [], choices: {}, defaults: {}, message: `离线译文包含锁定术语「${violation.source}」却未使用锁定译文「${violation.target}」，该离线字幕不能写入`, termSource: violation.source, termTarget: violation.target },
        plan: { kind: "keep", cueId: o.id }
      };
    }
    return {
      result: { cueId: o.id, source: o.source, status: "已合并", conflicts: [], choices: {}, defaults: { translated: "offline", start: "offline", end: "offline", status: "offline" } },
      plan: { kind: "add", cueId: o.id, cue: o }
    };
  }

  // 离线删除的字幕（拆分/合并会让旧 id 消失）
  if (b && !o) {
    if (s && !cueShallowEqual(b, s)) {
      return {
        result: { cueId: b.id, source: b.source, status: "冲突待选", conflicts: [{ field: "deleted", label: "字幕存删", offline: "离线批次已删除该字幕", studio: "棚内版本保留并修改了该字幕" }], choices: {}, defaults: {} },
        plan: { kind: "keep", cueId: b.id }
      };
    }
    return { result: { cueId: b.id, source: b.source, status: "已跳过", conflicts: [], choices: {}, defaults: {} }, plan: { kind: "remove", cueId: b.id } };
  }

  // b && o：逐字段三方差异
  const conflicts: FieldConflict[] = [];
  const defaults: Partial<Record<MergeField, MergeSide>> = {};
  let offlineChangedAny = false;
  for (const field of MERGE_FIELDS) {
    const baseValue = b![field] as string | number;
    const offlineValue = o![field] as string | number;
    const studioValue = s ? (s[field] as string | number) : baseValue;
    const offlineChanged = baseValue !== offlineValue;
    const studioChanged = s ? baseValue !== studioValue : false;
    if (offlineChanged) offlineChangedAny = true;
    if (offlineChanged && studioChanged && offlineValue !== studioValue) {
      conflicts.push({ field, label: FIELD_LABELS[field], offline: displayValue(field, offlineValue), studio: displayValue(field, studioValue) });
      defaults[field] = "studio"; // 冲突未决前先保留棚内版本
    } else {
      defaults[field] = offlineChanged && !studioChanged ? "offline" : "studio";
    }
  }

  // 棚内删除、离线有改动
  if (!s && offlineChangedAny) {
    conflicts.push({ field: "deleted", label: "字幕存删", offline: "离线批次修改了该字幕", studio: "棚内版本已删除该字幕" });
  }

  const violation = termViolation(o!, b);
  let status: CueMergeStatus = conflicts.length ? "冲突待选" : "已合并";
  let message: string | undefined;
  if (violation) {
    status = "未通过术语校验";
    message = `离线译文包含锁定术语「${violation.source}」却未使用锁定译文「${violation.target}」，译文不能采用离线版本`;
    defaults.translated = "studio"; // 术语锁定不可绕过：译文强制保留棚内
  }
  if (!s && !offlineChangedAny) {
    return { result: { cueId: b!.id, source: b!.source, status: "已跳过", conflicts: [], choices: {}, defaults: {} }, plan: { kind: "remove", cueId: b!.id } };
  }

  const visibleConflicts = violation ? conflicts.filter((item) => item.field !== "translated") : conflicts;
  return {
    result: { cueId: b!.id, source: b!.source, status, conflicts: visibleConflicts, choices: {}, defaults, message, termSource: violation?.source, termTarget: violation?.target },
    plan: { kind: "adopt", cueId: b!.id }
  };
}

function planFor(result: CueMergeResult, batch: OfflineBatch, studio: Cue[]): Plan {
  const inStudio = studio.some((cue) => cue.id === result.cueId);
  if (result.status === "已跳过") return { kind: "remove", cueId: result.cueId };
  if (result.status === "已合并") {
    if (inStudio) return { kind: "adopt", cueId: result.cueId };
    const offlineCue = batch.offline.find((cue) => cue.id === result.cueId);
    return { kind: "add", cueId: result.cueId, cue: offlineCue! };
  }
  if (result.status === "冲突待选") {
    if (result.conflicts.some((item) => item.field === "deleted")) {
      return result.choices.deleted === "offline" ? { kind: "adopt", cueId: result.cueId } : { kind: "keep", cueId: result.cueId };
    }
    return { kind: "adopt", cueId: result.cueId };
  }
  // 未通过术语校验：已有字幕保留棚内版本，离线新增字幕不写入
  return inStudio ? { kind: "adopt", cueId: result.cueId } : { kind: "keep", cueId: result.cueId };
}

function adoptCue(studioCue: Cue, offlineCue: Cue, result: CueMergeResult): Cue {
  const adopted: Cue = { ...studioCue };
  for (const field of MERGE_FIELDS) {
    const side = result.choices[field] ?? result.defaults[field] ?? "studio";
    if (field === "translated") adopted.translated = side === "offline" ? offlineCue.translated : studioCue.translated;
    else if (field === "start") adopted.start = side === "offline" ? offlineCue.start : studioCue.start;
    else if (field === "end") adopted.end = side === "offline" ? offlineCue.end : studioCue.end;
    else adopted.status = (side === "offline" ? offlineCue.status : studioCue.status) as CueStatus;
  }
  return adopted;
}

function applyPlans(batch: OfflineBatch, plans: Plan[]): Cue[] {
  const studio = get(cues);
  const merged: Cue[] = [];
  const handled = new Set<string>();
  for (const studioCue of studio) {
    const plan = plans.find((item) => item.cueId === studioCue.id);
    handled.add(studioCue.id);
    if (!plan || plan.kind === "keep") {
      merged.push(studioCue);
      continue;
    }
    if (plan.kind === "remove") continue;
    const offlineCue = batch.offline.find((cue) => cue.id === studioCue.id);
    const result = batch.results.find((item) => item.cueId === studioCue.id);
    merged.push(offlineCue && result ? adoptCue(studioCue, offlineCue, result) : studioCue);
  }
  for (const plan of plans) {
    if (plan.kind === "add" && !handled.has(plan.cueId) && plan.cue) merged.push(plan.cue);
  }
  return merged;
}

function recomputeStatus(results: CueMergeResult[]): OfflineBatchStatus {
  if (!results.length) return "待合并";
  const done = results.filter((result) => result.status === "已合并" || result.status === "已跳过").length;
  if (done === results.length) return "已合并";
  if (done === 0) return "合并失败";
  return "部分合并";
}

function runMerge(batch: OfflineBatch, onlyPending: boolean): OfflineBatch {
  const studio = get(cues);
  const ids = new Set<string>();
  for (const cue of batch.base) ids.add(cue.id);
  for (const cue of batch.offline) ids.add(cue.id);
  for (const cue of studio) ids.add(cue.id);

  const previous = new Map(batch.results.map((result) => [result.cueId, result]));
  const results: CueMergeResult[] = [];
  for (const cueId of ids) {
    const old = previous.get(cueId);
    if (onlyPending && old && (old.status === "已合并" || old.status === "已跳过")) {
      results.push(old);
      continue;
    }
    const baseCue = batch.base.find((cue) => cue.id === cueId);
    const offlineCue = batch.offline.find((cue) => cue.id === cueId);
    const studioCue = studio.find((cue) => cue.id === cueId);
    const { result } = evaluateCue(baseCue, offlineCue, studioCue);
    if (old) {
      // 保留上一轮已选好的边；冲突已随棚内/离线改动消失的，直接采用
      for (const field of Object.keys(old.choices) as MergeField[]) {
        if (result.conflicts.some((item) => item.field === field)) result.choices[field] = old.choices[field];
      }
      const unresolved = result.conflicts.filter((item) => !(item.field in result.choices));
      if (result.status === "冲突待选" && unresolved.length === 0) result.status = "已合并";
    }
    results.push(result);
  }

  const plans = results.map((result) => planFor(result, batch, get(cues)));
  cues.set(applyPlans({ ...batch, results }, plans));
  return { ...batch, results, status: recomputeStatus(results) };
}

export function batchStats(batch: OfflineBatch) {
  const offlineChanged = batch.offline.filter((offlineCue) => {
    const baseCue = batch.base.find((cue) => cue.id === offlineCue.id);
    return !baseCue || !cueShallowEqual(baseCue, offlineCue);
  }).length;
  return {
    total: batch.results.length,
    merged: batch.results.filter((result) => result.status === "已合并" || result.status === "已跳过").length,
    conflicts: batch.results.filter((result) => result.status === "冲突待选").length,
    failed: batch.results.filter((result) => result.status === "未通过术语校验").length,
    offlineChanged
  };
}

// 下车前创建批次：保存同步点快照，之后断网改动都属于这个离线批次
export function createOfflineBatch(name?: string) {
  const batch: OfflineBatch = {
    id: crypto.randomUUID(),
    name: name ?? `外拍车离线批次 ${new Date().toLocaleString("zh-CN")}`,
    device: "外拍车-02",
    createdAt: new Date().toISOString(),
    status: "离线中",
    base: clone(get(cues)),
    offline: [],
    results: []
  };
  offlineBatches.update((items) => [batch, ...items]);
  logEvent("离线合并", `创建离线批次「${batch.name}」：${batch.base.length} 条字幕进入离线编辑，恢复网络后按字幕条合并`);
}

// 回棚交回：冻结离线快照，棚内副本恢复到同步点（棚内改动可继续模拟）
export function checkInOfflineBatch(id: string) {
  const batch = get(offlineBatches).find((item) => item.id === id);
  if (!batch || batch.status !== "离线中") return;
  const offline = clone(get(cues));
  const changed = offline.filter((offlineCue) => {
    const baseCue = batch.base.find((cue) => cue.id === offlineCue.id);
    return !baseCue || !cueShallowEqual(baseCue, offlineCue);
  }).length;
  cues.set(clone(batch.base));
  offlineBatches.update((items) => items.map((item) => item.id === id ? { ...item, offline, checkedInAt: new Date().toISOString(), status: "待合并" } : item));
  logEvent("离线合并", `离线批次「${batch.name}」已交回：${changed} 条离线改动待合并，棚内副本已恢复到同步点`);
}

// 恢复网络后合并：按字幕条三方合并，冲突逐条选边，术语违规的条目留住重试
export function mergeOfflineBatch(id: string) {
  const batch = get(offlineBatches).find((item) => item.id === id);
  if (!batch || batch.status === "离线中" || batch.status === "已合并") return;
  const next = runMerge(batch, false);
  offlineBatches.update((items) => items.map((item) => item.id === id ? next : item));
  const stats = batchStats(next);
  logEvent("离线合并", `离线批次「${batch.name}」合并完成：${stats.merged} 条已处理，${stats.conflicts} 条冲突待选，${stats.failed} 条未通过术语校验`);
}

// 重试：只处理没合并的部分（冲突/术语违规），已合并的不动
export function retryOfflineBatch(id: string) {
  const batch = get(offlineBatches).find((item) => item.id === id);
  if (!batch || batch.status === "离线中" || batch.status === "已合并") return;
  const next = runMerge(batch, true);
  offlineBatches.update((items) => items.map((item) => item.id === id ? next : item));
  const stats = batchStats(next);
  logEvent("离线合并", `重试离线批次「${batch.name}」未合并部分：${stats.merged}/${stats.total} 条已处理，${stats.conflicts} 条冲突待选，${stats.failed} 条仍未通过术语校验`);
}

// 冲突选边：选好一边再写入
export function resolveOfflineConflict(batchId: string, cueId: string, field: MergeField, side: MergeSide) {
  const batch = get(offlineBatches).find((item) => item.id === batchId);
  if (!batch) return;
  const results = batch.results.map((result) => {
    if (result.cueId !== cueId) return result;
    const next: CueMergeResult = { ...result, choices: { ...result.choices, [field]: side } };
    if (field === "deleted") {
      next.status = next.message ? "未通过术语校验" : "已合并";
    } else {
      const unresolved = next.conflicts.filter((item) => !(item.field in next.choices));
      // 译文仍被锁定术语拦截时，即使其余冲突已选边，该条也不能算合并完成
      next.status = unresolved.length ? "冲突待选" : next.message ? "未通过术语校验" : "已合并";
    }
    return next;
  });
  const plans = results.map((result) => planFor(result, batch, get(cues)));
  cues.set(applyPlans({ ...batch, results }, plans));
  const nextStatus = recomputeStatus(results);
  offlineBatches.update((items) => items.map((item) => item.id === batchId ? { ...item, results, status: nextStatus } : item));
  const detail = field === "deleted"
    ? side === "offline" ? "按离线删除该字幕" : "保留棚内版本"
    : `${FIELD_LABELS[field]}采用${side === "offline" ? "离线版本" : "棚内版本"}`;
  logEvent("离线合并", `离线批次「${batch.name}」冲突 ${cueId} 已选边：${detail}`);
}

// 演示用：模拟外拍车断网期间的离线改动
export function applyOfflineDemoEdits() {
  cues.update((items) => items.map((cue) => {
    if (cue.id === "c2") return { ...cue, translated: "As the wave recedes, the pier emerges once more.", end: 3.4 };
    if (cue.id === "c3") return { ...cue, translated: "The repair team must complete reinforcement before the next tide.", end: 6.8 };
    return cue;
  }));
  logEvent("离线合并", "模拟外拍车断网改动：c2 译文/时间码、c3 译文/时间码已产生，随离线批次记录");
}

// 演示用：模拟审校同事在棚内副本上的改动
export function applyStudioDemoChanges() {
  cues.update((items) => items.map((cue) => {
    if (cue.id === "c2") return { ...cue, translated: "As the tide recedes, the pier slowly emerges again.", end: 3.0 };
    return cue;
  }));
  logEvent("离线合并", "模拟棚内审校改动：c2 译文润色、结束时间调整为 3.0 秒");
}
