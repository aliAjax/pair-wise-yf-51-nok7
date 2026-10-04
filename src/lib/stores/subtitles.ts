import { browser } from "$app/environment";
import { derived, get, writable } from "svelte/store";

export type TrackStatus = "草稿" | "审校中" | "已通过" | "需修改";
export type CueStatus = "待译" | "翻译中" | "待审" | "已通过" | "退回";
export type TermStatus = "建议" | "已锁定";

export interface Track {
  id: string;
  name: string;
  locale: "zh" | "en" | "ja";
  status: TrackStatus;
}

export interface Cue {
  id: string;
  trackId: string;
  start: number;
  end: number;
  source: string;
  translated: string;
  status: CueStatus;
  translator: string;
  reviewerNote: string;
}

export interface GlossaryTerm {
  id: string;
  source: string;
  target: string;
  status: TermStatus;
  owner: string;
  /** 锁定/改锁时的序号，用到该术语且此前已通过的字幕凭它失效重算 */
  lockVersion: number;
}

export interface ReviewEvent {
  id: string;
  cueId: string;
  action: "提交审校" | "审校通过" | "退回修改" | "术语锁定" | "离线同步";
  detail: string;
  actor: string;
  time: string;
}

export interface Snapshot {
  id: string;
  name: string;
  time: string;
  cues: Cue[];
}

export interface TimelineConflict {
  id: string;
  cueId: string;
  message: string;
  remoteStart: number;
  remoteEnd: number;
  status: "待处理" | "采用本地" | "采用协作版本";
}

/** 离线期间逐条字幕记录的改动（本地基线 = 断网那一刻的版本） */
export interface OfflineOp {
  cueId: string;
  base: Pick<Cue, "translated" | "start" | "end">;
  local: Pick<Cue, "translated" | "start" | "end">;
  time: string;
}

export interface OfflineBatch {
  id: string;
  createdAt: string;
  /** 同步成功（含冲突全部解决）后置 true，批次方可删除 */
  mergedAt: string | null;
  ops: OfflineOp[];
  /** 尚未合并的 op 下标（合并失败时保留，供稍后只重试这部分） */
  pending: number[];
  lastError: string;
}

export type MergeKind = "译文" | "时间码";
export type MergeSide = "离线" | "审校";

/** 同一字幕两边都改过译文或时间码时保留的逐字段差异 */
export interface MergeConflict {
  id: string;
  batchId: string;
  opIndex: number;
  cueId: string;
  kind: MergeKind;
  offlineValue: string | { start: number; end: number };
  remoteValue: string | { start: number; end: number };
  chosen: MergeSide | null;
  createdAt: string;
}

export interface SyncReport {
  applied: number;
  conflicts: MergeConflict[];
  failed: { cueId: string; reason: string }[];
}

const KEY = "pair-wise-yf-51/subtitles-v2";
const seedTracks: Track[] = [
  { id: "zh", name: "中文原字幕", locale: "zh", status: "已通过" },
  { id: "en", name: "English 翻译", locale: "en", status: "审校中" },
  { id: "ja", name: "日本語訳", locale: "ja", status: "草稿" }
];
const seedCues: Cue[] = [
  { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "" },
  { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "" },
  { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "" },
  { id: "c4", trackId: "ja", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮が引くと、桟橋が再び姿を現す。", status: "待译", translator: "周野", reviewerNote: "" }
];
const seedTerms: GlossaryTerm[] = [
  { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", lockVersion: 1 },
  { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", lockVersion: 1 },
  { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", lockVersion: 0 }
];
const initial = browser && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
export const tracks = writable<Track[]>(initial?.tracks ?? seedTracks);
export const cues = writable<Cue[]>(initial?.cues ?? seedCues);
export const terms = writable<GlossaryTerm[]>(initial?.terms ?? seedTerms);
export const reviewEvents = writable<ReviewEvent[]>(initial?.events ?? []);
export const snapshots = writable<Snapshot[]>(initial?.snapshots ?? []);
export const conflicts = writable<TimelineConflict[]>([{ id: "x1", cueId: "c2", message: "协作者将结束时间调整为3.0秒，与本机存在0.2秒差异。", remoteStart: 0, remoteEnd: 3, status: "待处理" }]);
/** 断网期间累积、尚未成功合并的离线批次 */
export const offlineBatches = writable<OfflineBatch[]>(initial?.batches ?? []);
/** 逐条字幕的合并差异，选定一边后才正式写入 */
export const mergeConflicts = writable<MergeConflict[]>(initial?.mergeConflicts ?? []);
/** 离线模式开关：开启后译文/时间码修改进入离线批次，不直接进主时间轴 */
export const offlineMode = writable<boolean>(initial?.offlineMode ?? false);
export const activeTrackId = writable("en");
export const selectedCueId = writable("c2");
export const reviewer = writable("审校-顾宁");

function persist() {
  if (!browser) return;
  localStorage.setItem(KEY, JSON.stringify({
    tracks: get(tracks),
    cues: get(cues),
    terms: get(terms),
    events: get(reviewEvents),
    snapshots: get(snapshots),
    batches: get(offlineBatches),
    mergeConflicts: get(mergeConflicts),
    offlineMode: get(offlineMode)
  }));
}
[tracks, cues, terms, reviewEvents, snapshots, offlineBatches, mergeConflicts, offlineMode].forEach((store) => store.subscribe(persist));

function logEvent(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  reviewEvents.update((items) => [{ id: crypto.randomUUID(), cueId: cue?.id ?? "", action, detail, actor: get(reviewer), time: new Date().toISOString() }, ...items]);
}

function event(cue: Cue | undefined, action: ReviewEvent["action"], detail: string) {
  logEvent(cue, action, detail);
}

/** 锁定术语的译文不能被绕过：原文用到的锁定词，译文必须包含其锁定译法 */
function violatesLock(sourceText: string, translatedText: string, $terms: GlossaryTerm[]): string | null {
  const haystack = translatedText.toLowerCase();
  const missing = $terms.filter((term) => term.status === "已锁定"
    && sourceText.includes(term.source)
    && !haystack.includes(term.target.toLowerCase()));
  return missing.length ? `锁定术语未按术语库翻译：${missing.map((term) => `${term.source}→${term.target}`).join("、")}` : null;
}

/** 某条字幕尚未合并的离线暂存值（没有则 undefined） */
function draftFor(cueId: string) {
  for (const batch of get(offlineBatches)) {
    if (batch.mergedAt !== null) continue;
    const op = batch.ops.find((item) => item.cueId === cueId);
    if (op) return op.local;
  }
  return undefined;
}

export function updateCue(id: string, patch: Partial<Cue>, log = false) {
  const tracked = ["translated", "start", "end"].filter((key) => key in patch) as (keyof Pick<Cue, "translated" | "start" | "end">)[];
  if (get(offlineMode) && tracked.length) {
    recordOfflineEdit(id, { translated: patch.translated, start: patch.start, end: patch.end });
    // 非译文/时间码字段（状态、备注、原文等）不参与离线合并，照常写入
    const rest: Partial<Cue> = { ...patch };
    tracked.forEach((key) => delete rest[key]);
    if (Object.keys(rest).length) cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...rest } : cue));
    return;
  }
  cues.update((items) => items.map((cue) => cue.id === id ? { ...cue, ...patch } : cue));
  if (log) event(get(cues).find((cue) => cue.id === id), "退回修改", "编辑字幕内容或时间码");
}

/** 把一条离线编辑记入当前批次；同一字幕连续修改只保留首版基线与最新结果 */
function recordOfflineEdit(id: string, patch: Partial<Pick<Cue, "translated" | "start" | "end">>) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  const now = new Date().toISOString();
  offlineBatches.update((batches) => {
    let batch = batches.find((item) => item.mergedAt === null);
    if (!batch) {
      batch = { id: crypto.randomUUID(), createdAt: now, mergedAt: null, ops: [], pending: [], lastError: "" };
      batches = [...batches, batch];
    }
    let op = batch.ops.find((item) => item.cueId === id);
    if (!op) {
      op = {
        cueId: id,
        base: { translated: cue.translated, start: cue.start, end: cue.end },
        local: { translated: cue.translated, start: cue.start, end: cue.end },
        time: now
      };
      batch.ops.push(op);
      batch.pending.push(batch.ops.length - 1);
    }
    op.local = {
      translated: patch.translated ?? op.local.translated,
      start: patch.start ?? op.local.start,
      end: patch.end ?? op.local.end
    };
    op.time = now;
    return [...batches];
  });
}

export function nudgeCue(id: string, delta: number) {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  const basis = get(offlineMode) ? (draftFor(id) ?? cue) : cue;
  updateCue(id, { start: Math.max(0, Number((basis.start + delta).toFixed(1))), end: Math.max(basis.start + 0.5, Number((basis.end + delta).toFixed(1))) });
}

export function splitCue(id: string) {
  const list = get(cues);
  const cue = list.find((item) => item.id === id);
  if (!cue || cue.end - cue.start < 1) return;
  const middle = Number(((cue.start + cue.end) / 2).toFixed(1));
  const first = { ...cue, end: middle, translated: `${cue.translated}`, status: "翻译中" as CueStatus };
  const second = { ...cue, id: crypto.randomUUID(), start: middle, translated: "", status: "待译" as CueStatus };
  cues.set(list.flatMap((item) => item.id === id ? [first, second] : item));
  selectedCueId.set(second.id);
}

export function mergeNext(id: string) {
  const list = [...get(cues)].sort((a, b) => a.start - b.start).filter((item) => item.trackId === get(activeTrackId));
  const index = list.findIndex((item) => item.id === id);
  const current = list[index];
  const next = list[index + 1];
  if (!current || !next) return;
  cues.update((items) => items.filter((item) => item.id !== next.id).map((item) => item.id === id ? { ...item, end: next.end, translated: `${item.translated} ${next.translated}`.trim(), status: "翻译中" } : item));
}

export function setCueStatus(id: string, status: CueStatus) {
  updateCue(id, { status });
  const cue = get(cues).find((item) => item.id === id);
  event(cue, status === "待审" ? "提交审校" : status === "已通过" ? "审校通过" : "退回修改", cue?.translated ?? "");
}

export function reviewCue(id: string, approved: boolean, note = "") {
  const cue = get(cues).find((item) => item.id === id);
  if (!cue) return;
  updateCue(id, { status: approved ? "已通过" : "退回", reviewerNote: note });
  event(cue, approved ? "审校通过" : "退回修改", note || cue.translated);
}

export function lockTerm(id: string) {
  const term = get(terms).find((item) => item.id === id);
  if (!term) return;
  const locking = term.status !== "已锁定";
  const nextVersion = term.lockVersion + 1;
  terms.update((items) => items.map((item) => item.id === id ? { ...item, status: "已锁定", owner: "术语管理员", lockVersion: nextVersion } : item));
  const cue = get(cues).find((item) => item.id === get(selectedCueId));
  event(cue, "术语锁定", `${term.source} → ${term.target}`);
  if (locking) invalidateApprovedCuesForTerm(term);
}

/**
 * 术语锁定一变（新锁定 / 锁定译文被改），用到它的已通过字幕立即失效：
 * 按新术语重算提示，退回待审；离线译文同样不能绕过，在差异里标出锁定冲突。
 */
export function invalidateApprovedCuesForTerm(term: GlossaryTerm) {
  const hit = get(cues).filter((cue) => cue.status === "已通过"
    && (cue.source.includes(term.source) || cue.translated.toLowerCase().includes(term.target.toLowerCase())));
  if (!hit.length) return;
  const note = `术语锁定变更（${term.source}→${term.target}），请核对后重新提交审校`;
  cues.update((list) => list.map((cue) => hit.some((item) => item.id === cue.id)
    ? { ...cue, status: "待审", reviewerNote: note }
    : cue));
  hit.forEach((cue) => logEvent(cue, "退回修改", note));
}

/** 修改已锁定术语的译文：术语锁定一变，用到它的已通过字幕失效、退回待审 */
export function updateLockedTerm(id: string, target: string) {
  const term = get(terms).find((item) => item.id === id);
  if (!term || term.status !== "已锁定" || target.trim() === term.target) return;
  const next: GlossaryTerm = { ...term, target: target.trim(), lockVersion: term.lockVersion + 1 };
  terms.update((items) => items.map((item) => item.id === id ? next : item));
  logEvent(undefined, "术语锁定", `锁定译文变更：${term.source} ${term.target} → ${next.target}`);
  invalidateApprovedCuesForTerm(next);
}

export function createSnapshot(name = `时间轴快照 ${get(snapshots).length + 1}`) {
  snapshots.update((items) => [{ id: crypto.randomUUID(), name, time: new Date().toISOString(), cues: structuredClone(get(cues)) }, ...items].slice(0, 12));
}

export function restoreSnapshot(id: string) {
  const snapshot = get(snapshots).find((item) => item.id === id);
  if (snapshot) cues.set(structuredClone(snapshot.cues));
}

export function resolveConflict(id: string, resolution: TimelineConflict["status"]) {
  conflicts.update((items) => items.map((item) => item.id === id ? { ...item, status: resolution } : item));
  if (resolution === "采用协作版本") {
    const conflict = get(conflicts).find((item) => item.id === id);
    if (conflict) updateCue(conflict.cueId, { start: conflict.remoteStart, end: conflict.remoteEnd });
  }
}

function sameTime(a: { start: number; end: number }, b: { start: number; end: number }) {
  return a.start === b.start && a.end === b.end;
}

/**
 * 恢复网络后按字幕条合并一个离线批次：
 * - 只在离线端改过的译文/时间码直接采用（仍受锁定术语约束）；
 * - 两边都改过则两份都留下、标出差异，选好一边后才写入；
 * - 合并失败的 op 留在批次 pending 中，稍后只重试未合并部分。
 * 当前主时间轴即"回棚后的协作版本"（审校同事的改动在上面）。
 */
export function syncOfflineBatch(batchId = get(offlineBatches).find((item) => item.mergedAt === null)?.id ?? ""): SyncReport {
  const report: SyncReport = { applied: 0, conflicts: [], failed: [] };
  const batch = get(offlineBatches).find((item) => item.id === batchId);
  if (!batch) return report;
  const $terms = get(terms);
  const stillPending: number[] = [];

  for (const index of batch.pending) {
    const op = batch.ops[index];
    if (!op) continue;
    const cue = get(cues).find((item) => item.id === op.cueId);
    if (!cue) {
      stillPending.push(index);
      report.failed.push({ cueId: op.cueId, reason: "字幕条已不存在，等待人工处理" });
      continue;
    }
    try {
      const remote = { translated: cue.translated, start: cue.start, end: cue.end };
      const textChangedOffline = op.local.translated !== op.base.translated;
      const textChangedRemote = remote.translated !== op.base.translated;
      const timeChangedOffline = !sameTime(op.local, op.base);
      const timeChangedRemote = !sameTime(remote, op.base);
      const now = new Date().toISOString();
      const patch: Partial<Cue> = {};
      const newConflicts: MergeConflict[] = [];

      if (textChangedOffline && textChangedRemote && op.local.translated !== remote.translated) {
        newConflicts.push({ id: crypto.randomUUID(), batchId: batch.id, opIndex: index, cueId: cue.id, kind: "译文", offlineValue: op.local.translated, remoteValue: remote.translated, chosen: null, createdAt: now });
      } else if (textChangedOffline) {
        const violation = violatesLock(cue.source, op.local.translated, $terms);
        if (violation) {
          newConflicts.push({ id: crypto.randomUUID(), batchId: batch.id, opIndex: index, cueId: cue.id, kind: "译文", offlineValue: op.local.translated, remoteValue: remote.translated, chosen: null, createdAt: now });
          report.failed.push({ cueId: cue.id, reason: violation });
        } else {
          patch.translated = op.local.translated;
        }
      }

      if (timeChangedOffline && timeChangedRemote && !sameTime(op.local, remote)) {
        newConflicts.push({ id: crypto.randomUUID(), batchId: batch.id, opIndex: index, cueId: cue.id, kind: "时间码", offlineValue: { start: op.local.start, end: op.local.end }, remoteValue: { start: remote.start, end: remote.end }, chosen: null, createdAt: now });
      } else if (timeChangedOffline) {
        if (op.local.end <= op.local.start) throw new Error("离线时间码无效：结束时间必须晚于开始时间");
        patch.start = op.local.start;
        patch.end = op.local.end;
      }

      if (newConflicts.length) {
        mergeConflicts.update((list) => [...list, ...newConflicts]);
        report.conflicts.push(...newConflicts);
        stillPending.push(index);
      } else {
        if (Object.keys(patch).length) {
          cues.update((list) => list.map((item) => item.id === cue.id ? { ...item, ...patch } : item));
        }
        report.applied += 1;
        logEvent(cue, "离线同步", Object.keys(patch).length ? `离线改动已合并：${Object.keys(patch).join("、")}` : "离线改动与当前版本一致，无需写入");
      }
    } catch (error) {
      // 合并失败：留住这条离线改动，稍后重试
      stillPending.push(index);
      report.failed.push({ cueId: cue.id, reason: error instanceof Error ? error.message : "未知合并错误" });
    }
  }

  offlineBatches.update((list) => list.map((item) => item.id === batch.id ? {
    ...item,
    pending: stillPending,
    lastError: report.failed.map((failure) => `${failure.cueId}：${failure.reason}`).join("；")
  } : item));
  return report;
}

/** 差异选定一边后写入对应字段；译文选择离线版本时仍要过锁定术语校验 */
export function resolveMergeConflict(conflictId: string, side: MergeSide): string | null {
  const conflict = get(mergeConflicts).find((item) => item.id === conflictId);
  if (!conflict || conflict.chosen) return null;
  const cue = get(cues).find((item) => item.id === conflict.cueId);
  if (!cue) return "字幕条已不存在";
  const value = side === "离线" ? conflict.offlineValue : conflict.remoteValue;

  if (conflict.kind === "译文") {
    const text = String(value);
    if (side === "离线") {
      const violation = violatesLock(cue.source, text, get(terms));
      if (violation) return violation;
    }
    cues.update((list) => list.map((item) => item.id === cue.id ? { ...item, translated: text } : item));
  } else {
    const range = value as { start: number; end: number };
    if (range.end <= range.start) return "结束时间必须晚于开始时间";
    cues.update((list) => list.map((item) => item.id === cue.id ? { ...item, start: range.start, end: range.end } : item));
  }

  mergeConflicts.update((list) => list.map((item) => item.id === conflict.id ? { ...item, chosen: side } : item));
  logEvent(cue, "离线同步", `${conflict.kind}差异已选定${side === "离线" ? "离线版本" : "审校版本"}`);
  finalizeBatchIfDone(conflict.batchId);
  return null;
}

/** 同一条字幕的译文、时间码差异可能各一条，全部选定后该 op 才算合并完成 */
function finalizeBatchIfDone(batchId: string) {
  const batch = get(offlineBatches).find((item) => item.id === batchId);
  if (!batch || batch.mergedAt) return;
  const related = get(mergeConflicts).filter((item) => item.batchId === batchId);
  const unresolvedIndices = new Set(related.filter((item) => !item.chosen).map((item) => item.opIndex));
  const nextPending = batch.pending.filter((index) => unresolvedIndices.has(index));
  const mergedAt = nextPending.length ? null : new Date().toISOString();
  offlineBatches.update((list) => list.map((item) => item.id === batchId ? { ...item, pending: nextPending, mergedAt, lastError: mergedAt ? "" : item.lastError } : item));
}

/** 重试批次中还没合并的部分（失败条目与待裁决差异） */
export function retryPending(batchId?: string) {
  const reports: SyncReport[] = [];
  const targets = batchId
    ? get(offlineBatches).filter((item) => item.id === batchId && item.mergedAt === null)
    : get(offlineBatches).filter((item) => item.mergedAt === null);
  for (const batch of targets) reports.push(syncOfflineBatch(batch.id));
  return reports;
}

/** 合并完成（无待处理差异）的批次才允许清理 */
export function removeBatch(batchId: string) {
  const batch = get(offlineBatches).find((item) => item.id === batchId);
  if (!batch) return;
  const hasUnresolved = get(mergeConflicts).some((item) => item.batchId === batchId && !item.chosen);
  if (batch.pending.length || hasUnresolved) {
    offlineBatches.update((list) => list.map((item) => item.id === batchId ? { ...item, lastError: "仍有未合并内容，不能删除离线批次" } : item));
    return;
  }
  offlineBatches.update((list) => list.filter((item) => item.id !== batchId));
  mergeConflicts.update((list) => list.filter((item) => item.batchId !== batchId));
}

export function toggleOfflineMode(value = !get(offlineMode)) {
  offlineMode.set(value);
}

export const activeCues = derived([cues, activeTrackId, selectedCueId], ([$cues, $activeTrackId, $selectedCueId]) => $cues.filter((cue) => cue.trackId === $activeTrackId).sort((a, b) => a.start - b.start).map((cue) => ({ ...cue, selected: cue.id === $selectedCueId })));

/** 离线批次里某条字幕的暂存改动，供时间轴上做标记 */
export const pendingOfflineCueIds = derived(offlineBatches, ($batches) => {
  const ids = new Set<string>();
  $batches.filter((batch) => batch.mergedAt === null).forEach((batch) => batch.pending.forEach((index) => {
    const op = batch.ops[index];
    if (op) ids.add(op.cueId);
  }));
  return ids;
});
