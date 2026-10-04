<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, createSnapshot, cues, lockTerm, mergeConflicts, mergeNext, nudgeCue, offlineBatches, offlineMode, pendingOfflineCueIds, removeBatch, resolveConflict, resolveMergeConflict, restoreSnapshot, retryPending, reviewCue, reviewEvents, reviewer, selectedCueId, setCueStatus, snapshots, splitCue, syncOfflineBatch, terms, toggleOfflineMode, tracks, updateCue, updateLockedTerm } from "$lib/stores/subtitles";
  import type { Cue, MergeConflict, OfflineBatch } from "$lib/stores/subtitles";

  const cueSchema = z.object({ source: z.string().min(2), translated: z.string().min(2), start: z.coerce.number().min(0), duration: z.coerce.number().min(0.5).max(30) });
  const defaults = { source: "", translated: "", start: 0, duration: 2.5 };
  const { form, errors, enhance } = superForm(defaults, {
    validators: zod4(cueSchema),
    onSubmit: async ({ formData }) => {
      const start = Number(formData.get("start") ?? 0);
      const item: Cue = { id: crypto.randomUUID(), trackId: $activeTrackId, start, end: start + Number(formData.get("duration") ?? 2.5), source: String(formData.get("source") ?? ""), translated: String(formData.get("translated") ?? ""), status: "翻译中", translator: "当前译者", reviewerNote: "" };
      cues.update((items) => [...items, item]);
      selectedCueId.set(item.id);
    }
  });
  const queryOptions = derived(activeTrackId, ($trackId) => ({ queryKey: ["cues", $trackId] as const, queryFn: async (): Promise<Cue[]> => get(activeCues) }));
  const query = createQuery(queryOptions);
  const activeTrack = $derived($tracks.find((track) => track.id === $activeTrackId));
  const selected = $derived($cues.find((cue) => cue.id === $selectedCueId));
  let reviewNote = $state("");
  let termEditId = $state("");
  let termEditTarget = $state("");

  /** 当前未合并批次里每条字幕最新的离线暂存值 */
  const offlineDrafts = $derived.by(() => {
    const map = new Map<string, { translated: string; start: number; end: number }>();
    for (const batch of $offlineBatches.filter((item) => item.mergedAt === null)) {
      for (const index of batch.pending) {
        const op = batch.ops[index];
        if (op) map.set(op.cueId, op.local);
      }
    }
    return map;
  });
  const selectedDraft = $derived(selected ? offlineDrafts.get(selected.id) : undefined);
  const pendingBatchCount = $derived($offlineBatches.filter((batch) => batch.mergedAt === null).length);

  function doSync(batchId?: string) {
    const reports = batchId ? [syncOfflineBatch(batchId)] : retryPending();
    const total = reports.reduce((sum, report) => sum + report.applied, 0);
    const blocked = reports.reduce((sum, report) => sum + report.failed.length, 0);
    if (total) createSnapshot(`合并离线改动 ${new Date().toLocaleString("zh-CN")}`);
    return { total, blocked };
  }

  function fmtRange(value: MergeConflict["offlineValue"]) {
    return typeof value === "string" ? value : `${formatTime(value.start)}–${formatTime(value.end)}`;
  }

  function batchStats(batch: OfflineBatch) {
    return { pending: batch.pending.length, total: batch.ops.length, done: batch.ops.length - batch.pending.length };
  }

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  onMount(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.tagName === "TEXTAREA" || (event.target as HTMLElement)?.tagName === "INPUT") return;
      const list = $activeCues;
      const index = list.findIndex((cue) => cue.id === $selectedCueId);
      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") selectedCueId.set(list[Math.min(list.length - 1, index + 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") selectedCueId.set(list[Math.max(0, index - 1)]?.id ?? $selectedCueId);
      if (event.key.toLowerCase() === "s") splitCue($selectedCueId);
      if (event.key.toLowerCase() === "m") mergeNext($selectedCueId);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); createSnapshot(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
</script>

<svelte:head><title>多语言字幕时间轴协作</title></svelte:head>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><b>SUBFLOW</b><span>字幕协作台</span></div>
    <nav><button class="active">时间轴编辑</button><button>审校队列</button><button>术语库</button><button>版本快照</button></nav>
    <div class="keyboard"><b>键盘操作</b><span>J / K 选择字幕</span><span>S 拆分 · M 合并</span><span>⌘S 保存快照</span></div>
  </aside>
  <main>
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校反馈在同一时间轴协作。</p></div><div class="header-actions"><button class="btn" class:variant-filled-error={$offlineMode} onclick={() => toggleOfflineMode()} title="外拍车断网时开启：译文和时间码改动进入离线批次，回棚后再按条合并">{$offlineMode ? "● 离线改翻译中" : "在线模式"}</button>{#if pendingBatchCount > 0}<button class="btn variant-filled-primary" onclick={() => doSync()}>合并 {pendingBatchCount} 个离线批次</button>{/if}<select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>拖动或点击选择，所有修改保存到浏览器本地</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              {@const draft = offlineDrafts.get(cue.id)}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small>{#if draft && (draft.start !== cue.start || draft.end !== cue.end)}<em class="offline-time">离线 {formatTime(draft.start)}–{formatTime(draft.end)}</em>{/if}</time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p>{#if draft && draft.translated !== cue.translated}<em class="offline-text">离线暂存：{draft.translated || "（空）"}</em>{/if}{#if $pendingOfflineCueIds.has(cue.id)}<span class="chip offline-chip">离线改动待合并</span>{/if}</div>
                <span class={`chip ${cue.status}`}>{cue.status}</span>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, -0.2); }}>−0.2s</button>
                <button class="btn btn-sm" onclick={(event) => { event.stopPropagation(); nudgeCue(cue.id, 0.2); }}>+0.2s</button>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="right-stack">
        <section class="panel">
          <div class="panel-head"><h2>字幕编辑</h2>{#if selected}<span class={`chip ${selected.status}`}>{selected.status}</span>{/if}</div>
          {#if $offlineMode}<p class="offline-banner">离线模式：译文与时间码改动只写入离线批次，恢复网络合并前不会覆盖主时间轴。</p>{/if}
          {#if selected}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文{#if selectedDraft}（离线暂存）{/if}</span><textarea class="textarea" value={selectedDraft?.translated ?? selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒{#if selectedDraft}（离线）{/if}</span><input class="input" type="number" step="0.1" value={selectedDraft?.start ?? selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒{#if selectedDraft}（离线）{/if}</span><input class="input" type="number" step="0.1" value={selectedDraft?.end ?? selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定译文改动后，用到它的已通过字幕退回待审</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> → {term.target}</span>
              {#if term.status === "已锁定"}
                {#if termEditId === term.id}
                  <span class="term-edit"><input class="input input-sm" bind:value={termEditTarget} /><button class="btn btn-sm variant-filled-primary" onclick={() => { updateLockedTerm(term.id, termEditTarget); termEditId = ""; }}>改锁</button><button class="btn btn-sm" onclick={() => termEditId = ""}>取消</button></span>
                {:else}
                  <span class="actions"><button class="btn btn-sm" onclick={() => { termEditId = term.id; termEditTarget = term.target; }}>改译文 v{term.lockVersion}</button><span class="chip 已通过">已锁定</span></span>
                {/if}
              {:else}
                <button class="btn btn-sm" onclick={() => lockTerm(term.id)}>{term.status}</button>
              {/if}
            </div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>离线批次</h2><small>合并失败会保留批次，稍后只重试未合并部分</small></div>
          {#each $offlineBatches as batch}
            {@const stats = batchStats(batch)}
            <article class="batch" class:done={batch.mergedAt !== null}>
              <b>{batch.mergedAt ? "已合并批次" : "待合并批次"} · {stats.total} 条字幕（{stats.done} 已合并{#if stats.pending}/{stats.pending} 待处理{/if}）</b>
              <p><small>断网于 {new Date(batch.createdAt).toLocaleString("zh-CN")}{#if batch.mergedAt} · 合并完成 {new Date(batch.mergedAt).toLocaleString("zh-CN")}{/if}</small></p>
              {#if batch.lastError}<p class="error-text">⚠ {batch.lastError}</p>{/if}
              <div class="actions">
                {#if batch.mergedAt === null}
                  <button class="btn btn-sm variant-filled-primary" onclick={() => doSync(batch.id)}>重试未合并（{stats.pending}）</button>
                {/if}
                <button class="btn btn-sm" disabled={stats.pending > 0 || $mergeConflicts.some((item) => item.batchId === batch.id && !item.chosen)} onclick={() => removeBatch(batch.id)}>{stats.pending > 0 ? "批次保留中" : "清除批次"}</button>
              </div>
            </article>
          {/each}
          {#if !$offlineBatches.length}<p>{$offlineMode ? "离线编辑后会在这里形成批次。" : "暂无离线批次。"}</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>合并差异与协作冲突</h2><small>两边都改过：两份都保留，选定一边才写入</small></div>
          {#each $mergeConflicts as conflict}
            {@const cue = $cues.find((item) => item.id === conflict.cueId)}
            <article class="conflict merge">
              <b>{cue?.source ? cue.source + " · " : ""}{conflict.kind}差异</b>
              <div class="diff-grid">
                <label class:chosen={conflict.chosen === "离线"}><input type="radio" name={conflict.id} disabled={conflict.chosen !== null} checked={conflict.chosen === "离线"} onchange={() => {
                  const err = resolveMergeConflict(conflict.id, "离线");
                  if (err) alert(err);
                }} /><span class="side-tag offline">离线版</span><p>{fmtRange(conflict.offlineValue)}</p></label>
                <label class:chosen={conflict.chosen === "审校"}><input type="radio" name={conflict.id} disabled={conflict.chosen !== null} checked={conflict.chosen === "审校"} onchange={() => resolveMergeConflict(conflict.id, "审校")} /><span class="side-tag remote">审校版</span><p>{fmtRange(conflict.remoteValue)}</p></label>
              </div>
              {#if conflict.chosen}<span class="chip 已通过">已采用{conflict.chosen === "离线" ? "离线" : "审校"}版本</span>{:else}<span class="chip 待审">待选定，暂不写入</span>{/if}
            </article>
          {/each}
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
          {#if !$mergeConflicts.length && !$conflicts.length}<p>暂无冲突。</p>{/if}
        </section>
      </aside>
    </div>

    <div class="bottom-grid">
      <section class="panel">
        <div class="panel-head"><h2>新增字幕</h2></div>
        <form class="cue-form" method="POST" use:enhance>
          <label class="label"><span>原文</span><input class="input" name="source" bind:value={$form.source} /><small>{$errors.source?.[0]}</small></label>
          <label class="label"><span>译文</span><input class="input" name="translated" bind:value={$form.translated} /><small>{$errors.translated?.[0]}</small></label>
          <label class="label"><span>开始秒</span><input class="input" name="start" type="number" step="0.1" bind:value={$form.start} /></label>
          <label class="label"><span>持续秒</span><input class="input" name="duration" type="number" step="0.1" bind:value={$form.duration} /></label>
          <button class="btn variant-filled-primary" type="submit">新增到当前轨道</button>
        </form>
      </section>
      <section class="panel"><div class="panel-head"><h2>审校记录</h2></div><div class="events">{#each $reviewEvents as item}<article><b>{item.action}</b><p>{item.detail}</p><small>{item.actor} · {new Date(item.time).toLocaleTimeString("zh-CN")}</small></article>{/each}{#if !$reviewEvents.length}<p>暂无审校操作。</p>{/if}</div></section>
      <section class="panel"><div class="panel-head"><h2>版本快照</h2></div><div class="events">{#each $snapshots as item}<article><b>{item.name}</b><p>{item.cues.length} 条字幕 · {new Date(item.time).toLocaleString("zh-CN")}</p><button class="btn btn-sm" onclick={() => restoreSnapshot(item.id)}>恢复</button></article>{/each}{#if !$snapshots.length}<p>使用 ⌘S 或顶部按钮创建快照。</p>{/if}</div></section>
    </div>
  </main>
</div>
