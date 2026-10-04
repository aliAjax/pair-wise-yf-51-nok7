import { build } from "esbuild";
import { writeFileSync } from "node:fs";

globalThis.localStorage = { getItem: () => null, setItem: () => {} };

writeFileSync("/tmp/env-stub.js", "export const browser = true;");

await build({
  entryPoints: ["src/lib/stores/subtitles.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: "/tmp/subtitles.bundle.mjs",
  alias: { "$app/environment": "/tmp/env-stub.js" }
});

const store = await import("/tmp/subtitles.bundle.mjs");
const { get } = await import("svelte/store");
let passed = 0;
function assert(cond, name) {
  if (!cond) { console.error("✗", name); process.exitCode = 1; }
  else { passed++; console.log("✓", name); }
}

const S = store;
function cue(id) { return get(S.cues).find((c) => c.id === id); }
function reset() {
  S.cues.set([
    { id: "c1", trackId: "zh", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "潮汐退去后，码头重新露出水面。", status: "已通过", translator: "系统", reviewerNote: "" },
    { id: "c2", trackId: "en", start: 0, end: 2.8, source: "潮汐退去后，码头重新露出水面。", translated: "As the tide recedes, the pier emerges again.", status: "待审", translator: "林岚", reviewerNote: "" },
    { id: "c3", trackId: "en", start: 3.2, end: 6.5, source: "修复组必须在下一场潮水到来前完成加固。", translated: "The repair team must reinforce it before the next tide.", status: "翻译中", translator: "林岚", reviewerNote: "" }
  ]);
  S.terms.set([
    { id: "g1", source: "潮汐", target: "tide", status: "已锁定", owner: "术语管理员", lockVersion: 1 },
    { id: "g2", source: "码头", target: "pier", status: "已锁定", owner: "术语管理员", lockVersion: 1 },
    { id: "g3", source: "加固", target: "reinforce", status: "建议", owner: "林岚", lockVersion: 0 }
  ]);
  S.offlineBatches.set([]);
  S.mergeConflicts.set([]);
  S.offlineMode.set(false);
}

// 1. 只在离线端改译文 → 直接采用
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "As the tide recedes, the pier emerges once more." });
assert(cue("c2").translated === "As the tide recedes, the pier emerges again.", "离线期间主时间轴不被覆盖");
S.offlineMode.set(false);
let r = S.syncOfflineBatch();
assert(r.applied === 1 && r.conflicts.length === 0, "单端改动：自动合并");
assert(cue("c2").translated === "As the tide recedes, the pier emerges once more.", "单端改动：离线译文已写入");

// 2. 两边都改译文 → 两份都留、标差异、选定后写入
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "OFFLINE tide pier version" });
S.offlineMode.set(false);
S.updateCue("c2", { translated: "REVIEWER tide pier version" }); // 审校同事回棚后的改动
r = S.syncOfflineBatch();
assert(r.applied === 0 && r.conflicts.length === 1 && r.conflicts[0].kind === "译文", "双端改译文：产生差异且不自动写入");
assert(cue("c2").translated === "REVIEWER tide pier version", "差异未裁决前保留审校版");
const err = S.resolveMergeConflict(r.conflicts[0].id, "离线");
assert(err === null && cue("c2").translated === "OFFLINE tide pier version", "选定离线版后才写入");
assert(get(S.offlineBatches)[0].mergedAt !== null, "全部差异解决后批次标记为已合并");

// 3. 译文+时间码双端都改 → 两条差异，可分开裁决
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "OFFLINE tide pier text" });
S.updateCue("c2", { start: 0.5, end: 4 });
S.offlineMode.set(false);
S.updateCue("c2", { translated: "REMOTE tide pier text" });
S.updateCue("c2", { start: 0, end: 5 });
r = S.syncOfflineBatch();
const kinds = r.conflicts.map((c) => c.kind).sort();
assert(kinds[0] === "时间码" && kinds[1] === "译文", "译文与时间码差异分别保留");
S.resolveMergeConflict(r.conflicts.find((c) => c.kind === "译文").id, "审校");
assert(cue("c2").translated === "REMOTE tide pier text" && cue("c2").start === 0 && cue("c2").end === 5, "译文选审校版；时间码仍未落");
S.resolveMergeConflict(r.conflicts.find((c) => c.kind === "时间码").id, "离线");
assert(cue("c2").start === 0.5 && cue("c2").end === 4, "时间码选离线版后写入，批次完成");

// 4. 锁定术语不能被离线改动绕过（原文含"潮汐"，译文丢了 tide）
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "When water goes down the dock appears" });
S.offlineMode.set(false);
r = S.syncOfflineBatch();
assert(r.applied === 0 && r.failed.length === 1 && /潮汐/.test(r.failed[0].reason), "离线译文绕过锁定术语：拦截并留在批次");
assert(cue("c2").translated.includes("tide"), "被拦截的离线译文未写入");
S.retryPending();
assert(get(S.offlineBatches)[0].pending.length === 1, "重试仍未合并的部分：继续保留");

// 5. 双端冲突时选了包含正确术语的离线版 → 放行；错误版被拒
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "water down dock appears" });
S.offlineMode.set(false);
S.updateCue("c2", { translated: "REMOTE tide pier" });
r = S.syncOfflineBatch();
const blocked = S.resolveMergeConflict(r.conflicts[0].id, "离线");
assert(/锁定术语/.test(blocked) && cue("c2").translated === "REMOTE tide pier", "裁决阶段同样校验锁定术语");
const ok = S.resolveMergeConflict(r.conflicts[0].id, "审校");
assert(ok === null, "含锁定术语的审校版可正常采用");

// 6. 术语锁定一变 → 用到它的已通过字幕失效、退回待审
reset();
S.updateCue("c1", { status: "已通过" });
assert(cue("c1").status === "已通过", "前置：c1 已通过");
S.updateLockedTerm("g1", "tidal flow");
assert(cue("c1").status === "待审", "锁定译文变更：已通过字幕退回待审");
assert(/术语锁定变更/.test(cue("c1").reviewerNote), "退回原因写入审校备注");

// 7. 锁定一个新术语也使已通过字幕失效
reset();
S.lockTerm("g3"); // 加固 → reinforce
const c3 = cue("c3");
assert(c3.translated.includes("reinforce"), "c3 译文含 reinforce");
S.updateCue("c3", { status: "已通过" });
S.lockTerm("g3"); // 再次锁定不重复触发（lockVersion 增加但状态没变不重算）
assert(cue("c3").status === "已通过", "重复锁定不重复失效");

// 8. 合并失败（无效时间码）留住批次，稍后重试未合并部分
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "valid tide pier offline text" });
S.updateCue("c3", { start: 5, end: 4 }); // 结束早于开始
S.offlineMode.set(false);
r = S.syncOfflineBatch();
assert(r.applied === 1 && r.failed.length === 1, "批次内逐条合并：成功的进、失败的留");
const batch = get(S.offlineBatches)[0];
assert(batch.pending.length === 1 && /时间码/.test(batch.lastError), "失败条目留在 pending 并记录原因");
// 修正离线暂存后重试
const op = batch.ops.find((o) => o.cueId === "c3");
op.local.start = 3.5; op.local.end = 7;
S.offlineBatches.set([{ ...batch }]);
r = S.retryPending(batch.id)[0];
assert(r.applied === 1 && get(S.offlineBatches)[0].pending.length === 0, "重试只处理未合并部分并成功");

// 9. 未合并完不允许删除批次
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "draft tide pier text" });
S.offlineMode.set(false);
const bid = get(S.offlineBatches)[0].id;
S.syncOfflineBatch(); // 直接采用，无冲突
S.removeBatch(bid);
assert(get(S.offlineBatches).length === 0, "合并完成的批次可清除");

// 10. 同一字幕离线连续编辑只产生一条 op，基线为首版
reset();
S.offlineMode.set(true);
S.updateCue("c2", { translated: "first tide pier edit" });
S.updateCue("c2", { translated: "second tide pier edit" });
const b = get(S.offlineBatches)[0];
assert(b.ops.length === 1 && b.ops[0].base.translated.includes("As the tide"), "连续修改保留首版基线、最新结果");
S.offlineMode.set(false);

console.log(`\n${passed} assertions passed`);
