import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
const subtitles = await server.ssrLoadModule("/src/lib/stores/subtitles.ts");
const offline = await server.ssrLoadModule("/src/lib/stores/offline.ts");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
const cue = (id) => get(subtitles.cues).find((c) => c.id === id);
const batch = (id) => get(offline.offlineBatches).find((b) => b.id === id);
const get = (store) => {
  let v;
  store.subscribe((x) => (v = x))();
  return v;
};
function reset() {
  subtitles.cues.set(structuredClone(subtitles.seedCues));
  subtitles.terms.set(structuredClone(subtitles.seedTerms));
  subtitles.tracks.set(structuredClone(subtitles.seedTracks));
  subtitles.reviewEvents.set([]);
  subtitles.snapshots.set([]);
  offline.offlineBatches.set([]);
}

console.log("== 场景1：离线改动 + 棚内改动，c2 译文违规且时间码冲突，c3 仅离线改动 ==");
reset();
offline.createOfflineBatch("测试批次-外拍车02");
const b1 = get(offline.offlineBatches)[0];
offline.applyOfflineDemoEdits();
offline.checkInOfflineBatch(b1.id);
assert(get(subtitles.cues).find((c) => c.id === "c2").end === 2.8, "交回后棚内副本恢复到同步点");
offline.applyStudioDemoChanges();
offline.mergeOfflineBatch(b1.id);
let b = batch(b1.id);
assert(b.status === "部分合并", `批次状态为部分合并（实际 ${b.status}）`);
const c2 = cue("c2");
assert(c2.translated === "As the tide recedes, the pier slowly emerges again.", "c2 译文采用棚内版本（离线译文违规被拦截）");
assert(c2.end === 3.0, "c2 时间码冲突未决前保留棚内 3.0s");
const r2 = b.results.find((r) => r.cueId === "c2");
assert(r2.status === "未通过术语校验", "c2 结果状态=未通过术语校验");
assert(r2.conflicts.length === 1 && r2.conflicts[0].field === "end", "c2 仅时间码冲突待选（译文违规不提供选择）");
assert(r2.message.includes("tide"), "违规提示包含锁定术语 tide");
const c3 = cue("c3");
assert(c3.translated === "The repair team must complete reinforcement before the next tide.", "c3 仅离线改过译文，直接采用离线版本");
assert(c3.end === 6.8, "c3 仅离线改过时间码，直接采用");
const r3 = b.results.find((r) => r.cueId === "c3");
assert(r3.status === "已合并", "c3 结果状态=已合并");

console.log("== 场景2：冲突选边写入 ==");
offline.resolveOfflineConflict(b1.id, "c2", "end", "offline");
assert(cue("c2").end === 3.4, "选边后 c2 时间码写入离线 3.4s");
b = batch(b1.id);
assert(b.status === "部分合并", "译文仍被锁定术语拦截，批次留住为部分合并（解锁后重试可合并）");

console.log("== 场景3：纯冲突（两边都改译文），重试机制 ==");
reset();
offline.createOfflineBatch("测试批次-纯冲突");
const b2 = get(offline.offlineBatches)[0];
offline.applyOfflineDemoEdits();
offline.checkInOfflineBatch(b2.id);
offline.applyStudioDemoChanges();
// 手动把 c3 也改成棚内不同译文，制造纯冲突
subtitles.cues.update((items) => items.map((c) => c.id === "c3" ? { ...c, translated: "The repair team must finish reinforcing before the next tide." } : c));
offline.mergeOfflineBatch(b2.id);
b = batch(b2.id);
assert(b.status === "部分合并", "纯冲突批次为部分合并");
const r3b = b.results.find((r) => r.cueId === "c3");
assert(r3b.status === "冲突待选" && r3b.conflicts.some((c) => c.field === "translated"), "c3 译文冲突待选");
offline.retryOfflineBatch(b2.id);
b = batch(b2.id);
assert(b.status === "部分合并", "未选边时重试仍为部分合并（失败批次留住）");
offline.resolveOfflineConflict(b2.id, "c3", "translated", "studio");
assert(cue("c3").translated === "The repair team must finish reinforcing before the next tide.", "c3 选棚内译文后写入棚内版本");
b = batch(b2.id);
assert(b.status === "部分合并", `c2 违规仍未解决，批次留住为部分合并（实际 ${b.status}）`);

console.log("== 场景4：离线新增字幕直接采用；离线删除同步 ==");
reset();
offline.createOfflineBatch("测试批次-增删");
const b3 = get(offline.offlineBatches)[0];
const newCue = { id: "c9", trackId: "en", start: 7, end: 9, source: "新到的补给船带来了备用零件。", translated: "The supply ship arriving brings spare parts.", status: "翻译中", translator: "林岚", reviewerNote: "" };
subtitles.cues.update((items) => [...items, newCue]);
subtitles.cues.update((items) => items.filter((c) => c.id !== "c4"));
offline.checkInOfflineBatch(b3.id);
offline.mergeOfflineBatch(b3.id);
assert(cue("c9")?.translated === "The supply ship arriving brings spare parts.", "离线新增字幕合并后存在");
assert(cue("c4") === undefined, "离线删除的字幕已同步删除");
b = batch(b3.id);
assert(b.status === "已合并", `增删批次已合并（实际 ${b.status}）`);

console.log("== 场景5：锁定术语变更，已通过字幕失效退回待审 ==");
reset();
subtitles.cues.update((items) => items.map((c) => c.id === "c2" ? { ...c, status: "已通过" } : c));
subtitles.updateTermTarget("g2", "wharf");
assert(cue("c2").status === "待审", `c2 用到码头→pier，术语改为 wharf 后退回待审（实际 ${cue("c2").status}）`);
assert(cue("c2").reviewerNote.includes("wharf"), "退回备注包含新锁定译文");
subtitles.updateTermTarget("g2", "pier");
assert(cue("c2").status === "待审", "改回 pier 后不自动复审，仍待审");
subtitles.cues.update((items) => items.map((c) => c.id === "c3" ? { ...c, status: "已通过" } : c));
subtitles.updateTermTarget("g1", "tide");
assert(cue("c3").status === "已通过", "c3 不含潮汐源词，锁定变更不影响");

console.log("== 场景6：术语锁定后离线违规不可绕过 ==");
reset();
subtitles.cues.update((items) => items.map((c) => c.id === "c2" ? { ...c, status: "翻译中", translated: "As the tide recedes, the pier emerges again.", end: 2.8 } : c));
offline.createOfflineBatch("测试批次-术语锁定");
const b4 = get(offline.offlineBatches)[0];
offline.applyOfflineDemoEdits();
offline.checkInOfflineBatch(b4.id);
offline.mergeOfflineBatch(b4.id);
b = batch(b4.id);
const r2d = b.results.find((r) => r.cueId === "c2");
assert(r2d.status === "未通过术语校验", "违规译文合并失败、批次留住");
assert(cue("c2").translated === "As the tide recedes, the pier emerges again.", "违规离线译文未写入");
subtitles.terms.update((items) => items.map((t) => t.id === "g1" ? { ...t, status: "建议" } : t));
offline.retryOfflineBatch(b4.id);
b = batch(b4.id);
const r2e = b.results.find((r) => r.cueId === "c2");
assert(r2e.status === "已合并", "术语解锁后重试，违规消失，离线改动仅一边改直接采用");
assert(cue("c2").translated === "As the wave recedes, the pier emerges once more.", "解锁后离线译文写入");
assert(cue("c2").end === 3.4, "离线时间码直接采用");
assert(batch(b4.id).status === "已合并", "批次最终已合并");

await server.close();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed ? 1 : 0);
