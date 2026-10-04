<script lang="ts">
  import { onMount } from "svelte";
  import { derived, get } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import { superForm } from "sveltekit-superforms";
  import { zod4 } from "sveltekit-superforms/adapters";
  import { z } from "zod";
  import * as m from "$lib/paraglide/messages.js";
  import { setLocale } from "$lib/paraglide/runtime.js";
  import { activeCues, activeTrackId, conflicts, createSnapshot, cues, lockTerm, mergeNext, nudgeCue, resolveConflict, restoreSnapshot, reviewCue, reviewEvents, reviewer, selectedCueId, setCueStatus, snapshots, splitCue, terms, tracks, updateCue, updateTermTarget } from "$lib/stores/subtitles";
  import type { Cue } from "$lib/stores/subtitles";
  import { activeOfflineBatch, applyOfflineDemoEdits, applyStudioDemoChanges, batchStats, checkInOfflineBatch, createOfflineBatch, mergeOfflineBatch, offlineBatches, resolveOfflineConflict, retryOfflineBatch } from "$lib/stores/offline";
  import type { MergeField, MergeSide, OfflineBatch } from "$lib/stores/offline";
  import { diffChars } from "$lib/diff";

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

  function formatTime(value: number) {
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    const tenths = Math.floor((value % 1) * 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
  }

  const FIELD_LABELS: Record<MergeField, string> = { translated: "译文", start: "开始时间", end: "结束时间", status: "状态", deleted: "字幕存删" };
  const statsOf = (batch: OfflineBatch) => batchStats(batch);
  const diffSegs = (studio: string, offline: string) => diffChars(studio, offline);
  const unresolvedCount = (batch: OfflineBatch) => batch.results.filter((r) => r.status === "冲突待选" || r.status === "未通过术语校验").length;

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
    <header><div><small>纪录片《潮汐线》 · 第 3 集</small><h1>{m.title()}</h1><p>多语种轨道、术语锁定与审校反馈在同一时间轴协作。</p></div><div class="header-actions">{#if $activeOfflineBatch}<span class="offline-badge">离线模式 · {$activeOfflineBatch.name}（断网改动随批次带回）</span>{/if}<select value={$activeTrackId} onchange={(event) => activeTrackId.set(event.currentTarget.value)}>{#each $tracks as track}<option value={track.id}>{track.name}</option>{/each}</select><button onclick={() => setLocale("en")}>EN</button><button onclick={() => setLocale("zh")}>中文</button></div></header>

    <section class="metrics"><article><span>当前轨道</span><b>{activeTrack?.name}</b></article><article><span>字幕条数</span><b>{$activeCues.length}</b></article><article><span>待审</span><b>{$activeCues.filter((cue) => cue.status === "待审").length}</b></article><article><span>已锁定术语</span><b>{$terms.filter((term) => term.status === "已锁定").length}</b></article></section>

    <div class="editor-grid">
      <section class="panel timeline">
        <div class="panel-head"><div><h2>时间轴</h2><small>拖动或点击选择，所有修改保存到浏览器本地</small></div><button class="btn variant-filled-primary" onclick={() => createSnapshot()}>保存快照</button></div>
        {#if $query.isPending}<p>正在加载字幕轨道…</p>{:else}
          <div class="cue-list">
            {#each $activeCues as cue}
              <div role="button" tabindex="0" class:selected={cue.id === $selectedCueId} class={`cue ${cue.status}`} onclick={() => selectedCueId.set(cue.id)} onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") selectedCueId.set(cue.id); }}>
                <time>{formatTime(cue.start)}<small>{formatTime(cue.end)}</small></time>
                <div><b>{cue.source}</b><p>{cue.translated || "尚未填写译文"}</p></div>
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
          {#if selected}
            <label class="label"><span>原文字幕</span><input class="input" value={selected.source} oninput={(event) => updateCue(selected.id, { source: event.currentTarget.value })} /></label>
            <label class="label"><span>译文</span><textarea class="textarea" value={selected.translated} oninput={(event) => updateCue(selected.id, { translated: event.currentTarget.value })}></textarea></label>
            <div class="time-fields"><label class="label"><span>开始秒</span><input class="input" type="number" step="0.1" value={selected.start} oninput={(event) => updateCue(selected.id, { start: Number(event.currentTarget.value) })} /></label><label class="label"><span>结束秒</span><input class="input" type="number" step="0.1" value={selected.end} oninput={(event) => updateCue(selected.id, { end: Number(event.currentTarget.value) })} /></label></div>
            <div class="actions"><button class="btn" onclick={() => setCueStatus(selected.id, "待审")}>提交审校</button><button class="btn variant-filled-success" onclick={() => reviewCue(selected.id, true)}>审校通过</button><button class="btn variant-filled-error" onclick={() => reviewCue(selected.id, false, reviewNote || "请核对术语和断句")}>退回修改</button></div>
            <label class="label"><span>审校备注</span><input class="input" bind:value={reviewNote} placeholder="退回时填写具体原因" /></label>
          {:else}<p>请先选择一条字幕。</p>{/if}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>术语锁定</h2><small>锁定术语不会被离线改动绕过；变更锁定译文会退回已通过字幕</small></div>
          {#each $terms as term}
            <div class="term"><span><b>{term.source}</b> →<input class="input term-target" value={term.target} oninput={(event) => updateTermTarget(term.id, event.currentTarget.value)} /></span><button class="btn btn-sm" disabled={term.status === "已锁定"} onclick={() => lockTerm(term.id)}>{term.status}</button></div>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><h2>协作冲突</h2></div>
          {#each $conflicts as conflict}
            <article class="conflict"><b>{conflict.message}</b><p>协作版本：{formatTime(conflict.remoteStart)}–{formatTime(conflict.remoteEnd)}</p><div class="actions"><button class="btn btn-sm" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用本地")}>保留本机</button><button class="btn btn-sm variant-filled-primary" disabled={conflict.status !== "待处理"} onclick={() => resolveConflict(conflict.id, "采用协作版本")}>采用协作版本</button><span class="chip">{conflict.status}</span></div></article>
          {/each}
        </section>

        <section class="panel">
          <div class="panel-head"><div><h2>离线批次 · 外拍车</h2><small>断网改动按字幕条三方合并，术语锁定不可绕过</small></div></div>
          <div class="actions">
            <button class="btn btn-sm" onclick={() => createOfflineBatch()}>创建离线批次</button>
            {#if $activeOfflineBatch}
              <button class="btn btn-sm" onclick={() => applyOfflineDemoEdits()}>模拟外拍车离线改动</button>
              <button class="btn btn-sm variant-filled-primary" onclick={() => checkInOfflineBatch($activeOfflineBatch.id)}>恢复网络并交回批次</button>
            {/if}
            <button class="btn btn-sm" onclick={() => applyStudioDemoChanges()}>模拟棚内审校改动</button>
          </div>
          {#if $activeOfflineBatch}<p class="offline-note">离线模式中：改动记录在批次「{$activeOfflineBatch.name}」，不会覆盖棚内版本。</p>{/if}
          {#each $offlineBatches as batch}
            <article class="batch">
              <div class="batch-head"><b>{batch.name}</b><span class={`chip batch-${batch.status}`}>{batch.status}</span></div>
              <small>{batch.device} · 创建于 {new Date(batch.createdAt).toLocaleString("zh-CN")}{#if batch.checkedInAt} · 交回于 {new Date(batch.checkedInAt).toLocaleString("zh-CN")}{/if}</small>
              {#if batch.status !== "离线中"}
                <div class="batch-stats">
                  <span>离线改动 {statsOf(batch).offlineChanged} 条</span>
                  <span>已处理 {statsOf(batch).merged}/{statsOf(batch).total}</span>
                  {#if statsOf(batch).conflicts}<span class="stat-conflict">冲突待选 {statsOf(batch).conflicts}</span>{/if}
                  {#if statsOf(batch).failed}<span class="stat-failed">术语未过 {statsOf(batch).failed}</span>{/if}
                </div>
              {/if}
              {#if batch.status === "待合并" || batch.status === "部分合并" || batch.status === "合并失败"}
                <div class="actions">
                  <button class="btn btn-sm variant-filled-primary" onclick={() => mergeOfflineBatch(batch.id)}>{batch.status === "待合并" ? "合并离线批次" : "重新合并全部"}</button>
                  {#if unresolvedCount(batch) > 0}<button class="btn btn-sm" onclick={() => retryOfflineBatch(batch.id)}>重试未合并部分</button>{/if}
                </div>
              {/if}
              {#if batch.status === "已合并"}<p class="offline-note ok">批次已全部合并完成，离线改动已按字幕条写入。</p>{/if}
              {#each batch.results.filter((result) => result.status === "冲突待选" || result.status === "未通过术语校验") as result}
                <div class="merge-card">
                  <b>{result.source}</b>
                  {#if result.message}<p class="violation">⚠ {result.message}</p>{/if}
                  {#each result.conflicts as conflict}
                    {@const segs = diffSegs(conflict.studio, conflict.offline)}
                    <div class="field-conflict">
                      <span class="field-label">{FIELD_LABELS[conflict.field]}</span>
                      {#if conflict.field === "deleted"}
                        <div class="versions">
                          <div class="version studio" class:chosen={result.choices[conflict.field] === "studio"}><small>棚内版本</small><p>{conflict.studio}</p></div>
                          <div class="version offline" class:chosen={result.choices[conflict.field] === "offline"}><small>离线版本</small><p>{conflict.offline}</p></div>
                        </div>
                      {:else}
                        <div class="versions">
                          <div class="version studio" class:chosen={result.choices[conflict.field] === "studio"}>
                            <small>棚内版本{result.choices[conflict.field] === "studio" ? " · 已采用" : ""}</small>
                            <p>{#each segs as seg}{#if seg.type !== "add"}{#if seg.type === "del"}<mark class="diff-del">{seg.text}</mark>{:else}{seg.text}{/if}{/if}{/each}</p>
                          </div>
                          <div class="version offline" class:chosen={result.choices[conflict.field] === "offline"}>
                            <small>离线版本{result.choices[conflict.field] === "offline" ? " · 已采用" : ""}</small>
                            <p>{#each segs as seg}{#if seg.type !== "del"}{#if seg.type === "add"}<mark class="diff-add">{seg.text}</mark>{:else}{seg.text}{/if}{/if}{/each}</p>
                          </div>
                        </div>
                      {/if}
                      <div class="actions">
                        <button class="btn btn-sm" disabled={!!result.choices[conflict.field]} onclick={() => resolveOfflineConflict(batch.id, result.cueId, conflict.field, "studio")}>采用棚内</button>
                        <button class="btn btn-sm variant-filled-primary" disabled={!!result.choices[conflict.field]} onclick={() => resolveOfflineConflict(batch.id, result.cueId, conflict.field, "offline")}>采用离线</button>
                      </div>
                    </div>
                  {/each}
                </div>
              {/each}
            </article>
          {/each}
          {#if !$offlineBatches.length}<p class="offline-note">暂无离线批次。外拍车前创建批次，断网期间的改动会在恢复网络后按字幕条合并。</p>{/if}
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
