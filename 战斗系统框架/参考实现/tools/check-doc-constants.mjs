// 工具：跨章常量一致性检查
// 用法：node tools/check-doc-constants.mjs
//
// 三条规则（也是本框架的常量治理约定）：
//   R1 00 §4 + src/core/constants.mjs 是"核心常量"登记处，被两章以上引用的常量必须在这里。
//   R2 只被单章使用的常量，必须登记在该章末尾的「§N 新增常量」表中（解析时支持 `A-B` / `-C` 简写）。
//   R3 文档里出现的任何 <GROUP>-<KEY> 形式的 ID，都必须能按 R1 或 R2 找到；
//      此外允许"族前缀"写法（`CC-SPD` 指 `CC-SPD-*` 全体）与验收用例编号（`*-AC-NN`，不算常量）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const CONST_FILE = path.join(__dirname, '..', 'src', 'core', 'constants.mjs');
const GROUPS = ['TM', 'CC', 'MM', 'SL', 'CB', 'CAM', 'AI', 'TN', 'SM', 'IN'];
const GROUP_ALT = GROUPS.join('|');
const RE_DECL = new RegExp(`export const (${GROUP_ALT}) = \\{([\\s\\S]*?)\\n\\};`, 'g');
const RE_ID = new RegExp(`\\b(${GROUP_ALT})-[A-Z][A-Z0-9-]*[A-Z0-9]\\b`, 'g');

// ---------- R1：核心常量 ----------
const src = fs.readFileSync(CONST_FILE, 'utf8');
const core = new Set();          // 全部核心常量 ID（dash 形式，尾缀 -MS 已剥）
for (const m of src.matchAll(RE_DECL)) {
  const [grp, body] = [m[1], m[2]];
  // 顶层键：KEY: value（同一行可以写多个键，故用非锚定匹配；嵌套的键是小写，不会误捕）
  for (const km of body.matchAll(/([A-Z][A-Z0-9_]*)\s*:/g)) {
    core.add(`${grp}-${km[1].replace(/_/g, '-')}`.replace(/-MS$/, ''));
  }
  // 嵌套对象：KEY: { ... } → 登记 GRP-KEY-INNER（如 AI.HEAR.walk → AI-HEAR-WALK）
  for (const bm of body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:\s*\{([^}]*)\}/gm)) {
    const [key, inner] = [bm[1], bm[2]];
    for (const im of inner.matchAll(/([a-zA-Z][a-zA-Z0-9_]*)\s*:/g)) {
      core.add(`${grp}-${key}-${im[1]}`.replace(/_/g, '-').toUpperCase());
    }
  }
}

// ---------- R2：章内新增常量表 ----------
const declared = new Map();      // id → 章号
const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'));
for (const f of docs.filter((x) => /^\d\d-.*\.md$/.test(x))) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*\d+\.\s*新增常量/.test(l));
  if (start < 0) continue;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break; }
  let lastFull = null;
  for (let i = start; i < end; i++) {
    for (const m of lines[i].matchAll(/`([A-Za-z-]+)`/g)) {
      const tok = m[1];
      if (/^[A-Z]{2,4}(-[A-Z0-9]+)+$/.test(tok)) {
        lastFull = tok;
        declared.set(tok, f.slice(0, 2));
      } else if (/^-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(tok) && lastFull) {
        const parts = lastFull.split('-');
        declared.set([...parts.slice(0, -1), tok.slice(1)].join('-'), f.slice(0, 2));
      }
    }
  }
}

const registeredSet = new Set([...core, ...declared.keys()]);
const isCaseId = (id) => /-AC-\d+$/.test(id);
const registered = (id) =>
  isCaseId(id) ||
  registeredSet.has(id) ||
  [...registeredSet].some((k) => k.startsWith(id + '-'));   // 族前缀写法

// ---------- R3：扫描文档 ----------
const hits = new Map();
for (const f of docs) {
  const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of txt.matchAll(RE_ID)) {
    const id = m[0];
    if (!hits.has(id)) hits.set(id, new Set());
    hits.get(id).add(f.slice(0, 2));
  }
}

const coreIds = [...hits.keys()].filter((id) => !isCaseId(id) && core.has(id) || (registeredSet.has(id) && core.has(id)));
const declaredIds = [...hits.keys()].filter((id) => !core.has(id) && declared.has(id));
const unknown = [...hits.keys()].filter((id) => !registered(id)).sort();

console.log(`扫描 ${docs.length} 份文档，出现 ${hits.size} 个 ID 形态字符串（含验收用例编号）。`);
console.log(`  R1 核心常量命中：${coreIds.length}`);
console.log(`  R2 章内新增表命中：${declaredIds.length}`);
console.log(`  未登记：${unknown.length}\n`);
if (unknown.length) {
  console.log('未登记（补进某章新增常量表，或改正拼写）：');
  for (const id of unknown) console.log(`  ${id.padEnd(26)} 出现在 ${[...hits.get(id)].sort().join(',')} 章`);
} else {
  console.log('✓ 所有常量 ID 均可追溯到 00 §4 核心表、constants.mjs 或章内新增常量表');
}
process.exitCode = unknown.length ? 1 : 0;
