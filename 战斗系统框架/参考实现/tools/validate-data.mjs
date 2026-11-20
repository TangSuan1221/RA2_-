// 战斗系统框架 · 数据包校验器
// 用法：node tools/validate-data.mjs [--data <dir>]
// 作用：把 10 章 §0 的 9 条校验断言变成可执行代码，外加 1 条跨文件一致性断言（P10）。
// 纪律：只读数据、不改数据；任何一条失败即 exit 1。数量上限（如槽位数）不在此处校验。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CB, SL } from '../src/core/constants.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const DATA = dataIdx >= 0 ? path.resolve(args[dataIdx + 1]) : path.join(__dirname, '..', 'public', 'data');

const read = (rel) => JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));

const moveset = read('moveset.json');
const combo = read('combo.json');
const reactions = read('reactions.json');
const slots = read('slots.json');
const roles = read('ai_roles.json');
const camera = read('camera_profile.json');
const manifest = read(path.join('anim', 'manifest.json'));

const clipById = new Map(manifest.clips.map((c) => [c.id, c]));
const bones = new Set(manifest.skeleton.bones);
const anchors = new Set(Object.keys(manifest.skeleton.anchors ?? {}));
const actionById = new Map(moveset.actions.map((a) => [a.id, a]));

const results = [];
const check = (id, desc, fn) => {
  const bad = [];
  try { fn(bad); } catch (e) { bad.push(`EXC ${e.message}`); }
  results.push({ id, desc, bad });
};

// ---------- P1 相位总时长 == 片段时长 / playRate（±16ms）----------
check('P1', 'phases 之和 == clip 时长 / playRate（±16ms）', (bad) => {
  for (const a of moveset.actions) {
    const clip = clipById.get(a.anim.clip);
    if (!clip) { bad.push(`${a.id}: 片段 ${a.anim.clip} 不在 manifest`); continue; }
    const ph = a.phases.windupMs + a.phases.activeMs + a.phases.recoveryMs;
    const want = (clip.durationSec * 1000) / (a.anim.playRate ?? 1);
    if (Math.abs(ph - want) > 16) bad.push(`${a.id}: 相位和 ${ph}ms vs 片段 ${want.toFixed(1)}ms（差 ${(ph - want).toFixed(1)}）`);
  }
});

// ---------- P2 tell 提前量 ≥80ms 且 ≤ windup ----------
check('P2', 'tell.leadMs ≥ 80 且 ≤ windupMs', (bad) => {
  for (const a of moveset.actions) {
    if (!a.tell) { bad.push(`${a.id}: 缺 tell`); continue; }
    if (a.tell.leadMs < 80) bad.push(`${a.id}: leadMs ${a.tell.leadMs} < 80`);
    if (a.tell.leadMs > a.phases.windupMs) bad.push(`${a.id}: leadMs ${a.tell.leadMs} > windup ${a.phases.windupMs}`);
  }
});

// ---------- P3 hitbox 百分比落在 active 段内 ----------
check('P3', 'hitbox 的 [startPct,endPct] ∈ [0,1] 且 start ≤ end', (bad) => {
  for (const a of moveset.actions) {
    for (const [i, hb] of (a.hitboxes ?? []).entries()) {
      if (hb.startPct < 0 || hb.endPct > 1 || hb.startPct > hb.endPct) bad.push(`${a.id}#hb${i}: [${hb.startPct},${hb.endPct}]`);
    }
    if ((a.category === 'light' || a.category === 'heavy' || a.category === 'execution') && (a.hitboxes ?? []).length === 0) {
      bad.push(`${a.id}: category=${a.category} 但无 hitbox`);
    }
  }
});

// ---------- P4 取消点 ≥ CB-CANCEL-POINT 或显式 allowEarly ----------
check('P4', `cancel.into 的 fromPct ≥ CB-CANCEL-POINT(${CB.CANCEL_POINT}) 或 allowEarly:true`, (bad) => {
  for (const a of moveset.actions) {
    for (const c of a.cancel?.into ?? []) {
      if (c.fromPct < CB.CANCEL_POINT && c.allowEarly !== true) bad.push(`${a.id} → ${c.action}: fromPct ${c.fromPct}`);
      if (c.inputWindow && (c.inputWindow[0] > c.inputWindow[1] || c.inputWindow[1] > 1)) bad.push(`${a.id} → ${c.action}: inputWindow ${JSON.stringify(c.inputWindow)}`);
    }
  }
});

// ---------- P5 引用闭合：combo 边 / replacesTo / attackTable / additive.clip ----------
check('P5', '所有引用闭合：combo 边、context.replacesTo、attackTable、additive.clip', (bad) => {
  for (const [gname, g] of Object.entries(combo.graphs)) {
    if (!actionById.has(g.entry)) bad.push(`graph ${gname}: entry ${g.entry} 不存在`);
    for (const [from, node] of Object.entries(g.nodes)) {
      if (!actionById.has(from)) bad.push(`graph ${gname}: 节点 ${from} 不存在`);
      for (const e of node.edges ?? []) if (!actionById.has(e.to)) bad.push(`graph ${gname}: ${from} → ${e.to} 悬空边`);
    }
  }
  for (const a of moveset.actions) {
    for (const [tag, target] of Object.entries(a.context?.replacesTo ?? {})) {
      if (!actionById.has(target)) bad.push(`${a.id}: replacesTo.${tag} → ${target} 不存在`);
    }
  }
  for (const r of roles.roles) {
    for (const id of r.melee?.attackTable ?? []) if (!actionById.has(id)) bad.push(`${r.id}: attackTable ${id} 不存在`);
    for (const id of r.melee?.finisherTable ?? []) if (!actionById.has(id)) bad.push(`${r.id}: finisherTable ${id} 不存在`);
  }
  for (const r of reactions.reactions) {
    if (!clipById.has(r.additive.clip)) bad.push(`${r.id}: additive.clip ${r.additive.clip} 不在 manifest`);
  }
});

// ---------- P6 execution 只能打低血/硬直目标 ----------
check('P6', `execution 的 targetHpPct ≤ CB-EXEC-HP-PCT(${CB.EXEC_HP_PCT})`, (bad) => {
  for (const a of moveset.actions.filter((x) => x.category === 'execution')) {
    const pct = a.requirements?.targetHpPct;
    if (pct === undefined) bad.push(`${a.id}: 缺 requirements.targetHpPct`);
    else if (pct > CB.EXEC_HP_PCT) bad.push(`${a.id}: targetHpPct ${pct} > ${CB.EXEC_HP_PCT}`);
  }
});

// ---------- P7 采样率与帧数公式、总帧数下限 ----------
check('P7', 'manifest.sampleHz=30、frameCount=floor(dur*30)+1、总帧数 ≥6000', (bad) => {
  if (manifest.sampleHz !== 30) bad.push(`sampleHz ${manifest.sampleHz} ≠ 30`);
  let total = 0;
  for (const c of manifest.clips) {
    const want = Math.floor(c.durationSec * manifest.sampleHz) + 1;
    total += want;
    if (c.frames !== undefined && c.frames !== want) bad.push(`${c.id}: frames ${c.frames} ≠ ${want}`);
  }
  if (total < 6000) bad.push(`总采样帧 ${total} < 6000（运动匹配会退化为永远选中同一段）`);
  results.push({ id: 'P7+', desc: `总采样帧 = ${total}`, bad: [] });
});

// ---------- P8 骨骼名与锚点存在 ----------
check('P8', 'hitbox.bone ∈ 骨骼表；rootMotion.warpTarget ∈ 锚点表', (bad) => {
  for (const a of moveset.actions) {
    for (const hb of a.hitboxes ?? []) if (!bones.has(hb.bone)) bad.push(`${a.id}: bone ${hb.bone} 不在骨骼表`);
    const wt = a.rootMotion?.warpTarget;
    if (a.rootMotion?.mode === 'warp' && wt && !anchors.has(wt) && !bones.has(wt)) bad.push(`${a.id}: warpTarget ${wt} 不在锚点/骨骼表`);
  }
});

// ---------- P9 无 NaN ----------
check('P9', '数据内无 NaN / Infinity', (bad) => {
  const walk = (v, p) => {
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${p} = ${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
  };
  [moveset, combo, reactions, slots, roles, camera, manifest].forEach((o, i) => walk(o, `file${i}`));
});

// ---------- P10 跨文件与常量一致性 ----------
check('P10', '跨文件一致性：token 上限、tellScale、lockLowerBody、inherit 语义', (bad) => {
  if (slots.maxAttackers !== SL.MAX_ATTACKERS) bad.push(`slots.maxAttackers ${slots.maxAttackers} ≠ SL.MAX_ATTACKERS ${SL.MAX_ATTACKERS}`);
  if (slots.maxApproach !== SL.MAX_APPROACH) bad.push(`slots.maxApproach ${slots.maxApproach} ≠ ${SL.MAX_APPROACH}`);
  if (slots.lines !== SL.LINES) bad.push(`slots.lines ${slots.lines} ≠ ${SL.LINES}`);
  if (slots.reserveTtlMs !== SL.RESERVE_TTL_MS) bad.push(`slots.reserveTtlMs ${slots.reserveTtlMs} ≠ ${SL.RESERVE_TTL_MS}`);
  for (const r of reactions.reactions) {
    if (r.lockLowerBody === true && r.trigger.poiseBreak !== true) bad.push(`${r.id}: lockLowerBody=true 但非破防（违反不变量 I4）`);
  }
  const vet = roles.roles.find((r) => r.id === 'veteran');
  if (vet && vet.melee.tellScale !== SL.TELL_SCALE.vet) bad.push(`veteran.tellScale ${vet.melee.tellScale} ≠ ${SL.TELL_SCALE.vet}`);
  for (const r of roles.roles) {
    if (r.slotRole && !slots.roleReservations[r.slotRole]) bad.push(`${r.id}: slotRole ${r.slotRole} 不在 slots.roleReservations`);
  }
  if (!camera.profiles.default) bad.push('camera_profile 缺 default');
  for (const [name, p] of Object.entries(camera.profiles)) {
    if (name !== 'default' && p.inherit !== true) bad.push(`profile ${name}: 非 default 必须 inherit:true`);
  }
});

// ---------- 输出 ----------
console.log('\n=== 数据包校验（10 章 §0 九条 + 跨文件一致性）===\n');
let fail = 0;
for (const r of results) {
  const ok = r.bad.length === 0;
  if (!ok) fail++;
  console.log(`${(ok ? 'PASS' : 'FAIL').padEnd(5)} ${r.id.padEnd(4)} ${r.desc}`);
  for (const b of r.bad.slice(0, 8)) console.log(`         └─ ${b}`);
  if (r.bad.length > 8) console.log(`         └─ …还有 ${r.bad.length - 8} 条`);
}
console.log('');
console.log(`动作 ${moveset.actions.length} 个 / 反应 ${reactions.reactions.length} 条 / 片段 ${manifest.clips.length} 个 / 角色 ${roles.roles.length} 种`);
console.log(`结果：${results.length - fail}/${results.length} 通过`);
console.log('');
process.exitCode = fail ? 1 : 0;
