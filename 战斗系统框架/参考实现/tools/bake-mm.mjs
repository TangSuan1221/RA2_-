// 战斗系统框架 · 动画烘焙器（bake）
// 用法：
//   node tools/bake-mm.mjs              # 生成 anim/*.bin 与 mm.locomotion.mmdb
//   node tools/bake-mm.mjs --check      # 只校验已生成的 mmdb 头（magic/version/sampleHz/dims/KDTree）
//   node tools/bake-mm.mjs --synthetic  # 显式声明使用程序化合成姿态（默认行为，便于自证管线）
//
// 重要：本工具生成的是**程序化合成**的骨骼姿态（正弦摆腿 + 根位移），目的是让
// MMDB 二进制布局、PCA、KDTree 与加载链路可被端到端验证。**它不是动捕素材。**
// 换成真实素材时只替换 readClipFrames() 的实现，二进制布局与后续流程完全不变。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MM } from '../src/core/constants.mjs';
import { makeFeature, pcaFromFeatures, projectAll, FEATURE_LEN, SAMPLE_TIMES, TRAJ_SCALE } from '../src/anim/mm.mjs';
import { buildKdTree, treeDepth } from '../src/anim/kdtree.mjs';
import { fnv1a } from '../src/core/math.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const ANIM_DIR = path.join(DATA, 'anim');
const MMDB_PATH = path.join(DATA, 'mm.locomotion.mmdb');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');

const manifest = JSON.parse(fs.readFileSync(path.join(ANIM_DIR, 'manifest.json'), 'utf8'));
const bones = manifest.skeleton.bones;
const boneCount = bones.length;
const sampleHz = manifest.sampleHz;

// ---------------- 1. 合成姿态（替换点：真实素材在这里读 .glb/.fbx 采样） ----------------
function readClipFrames(clip) {
  const frameCount = Math.floor(clip.durationSec * sampleHz) + 1;
  const out = [];
  const speed = clip.speed ?? 0;
  const isLocomotion = ['idle', 'walk', 'jog', 'sprint', 'crouch'].includes(clip.tag);
  // 步频随速度提高；蹲姿更慢
  const strideHz = clip.tag === 'crouch' ? 1.0 : 0.9 + speed * 0.28;
  for (let f = 0; f < frameCount; f++) {
    const t = f / sampleHz;
    const phase = 2 * Math.PI * strideHz * t;
    const quat = new Float32Array(boneCount * 4);
    const trans = new Float32Array(boneCount * 3);
    for (let b = 0; b < boneCount; b++) {
      const name = bones[b];
      let angle = 0;
      if (name.startsWith('upperleg')) angle = 0.42 * Math.sin(phase + (name.endsWith('_l') ? 0 : Math.PI));
      else if (name.startsWith('lowerleg')) angle = 0.28 * Math.max(0, Math.sin(phase + (name.endsWith('_l') ? 0.6 : Math.PI + 0.6)));
      else if (name.startsWith('upperarm')) angle = -0.35 * Math.sin(phase + (name.endsWith('_l') ? Math.PI : 0));
      else if (name === 'chest' || name === 'spine') angle = 0.06 * Math.sin(2 * phase);
      const half = angle / 2;
      quat[b * 4 + 0] = Math.sin(half);  // 绕 X 轴摆动（前后）
      quat[b * 4 + 1] = 0;
      quat[b * 4 + 2] = 0;
      quat[b * 4 + 3] = Math.cos(half);
      // 根骨带前进位移，其余骨骼给固定局部偏移
      const localY = b === 1 ? 0.95 : bones[b].startsWith('foot') ? 0.08 : 0.0;
      trans[b * 3 + 0] = b === 0 ? 0 : (bones[b].endsWith('_l') ? 0.09 : -0.09) * (b > 5 ? 1 : 0);
      trans[b * 3 + 1] = localY;
      trans[b * 3 + 2] = b === 0 ? speed * t : 0.0;
    }
    out.push({ t, quat, trans, rootDelta: [0, 0, isLocomotion ? speed / sampleHz : 0] });
  }
  return out;
}

// ---------------- 2. ANIM 二进制（对齐 10 章 §8）----------------
function writeAnimBin(clip) {
  const frames = readClipFrames(clip);
  const n = frames.length;
  const header = 4 + 2 + 4 + 2 + 4 + 4 + 1;         // magic+ver+skeletonId+boneCount+frameCount+fps+loop
  const notifyCount = (clip.notifies ?? []).length;
  const notifyBytes = 4 + notifyCount * 8;          // u32 count + n×(f32 time,u16 type,u16 param)
  const size = header + n * boneCount * 4 * 4 + n * boneCount * 3 * 4 + notifyBytes + n * 3 * 4;
  const buf = Buffer.alloc(size);
  let o = 0;
  buf.write('ANIM', o, 4, 'ascii'); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt32LE(fnv1a(manifest.skeleton.id), o); o += 4;
  buf.writeUInt16LE(boneCount, o); o += 2;
  buf.writeUInt32LE(n, o); o += 4;
  buf.writeFloatLE(sampleHz, o); o += 4;
  buf.writeUInt8(clip.loop ? 1 : 0, o); o += 1;
  for (const fr of frames) for (let i = 0; i < boneCount * 4; i++) { buf.writeFloatLE(fr.quat[i], o); o += 4; }
  for (const fr of frames) for (let i = 0; i < boneCount * 3; i++) { buf.writeFloatLE(fr.trans[i], o); o += 4; }
  buf.writeUInt32LE(notifyCount, o); o += 4;
  for (const nf of clip.notifies ?? []) {
    buf.writeFloatLE(nf.t, o); o += 4;
    buf.writeUInt16LE(fnv1a(nf.type) & 0xffff, o); o += 2;
    buf.writeUInt16LE(fnv1a(String(nf.param ?? '')) & 0xffff, o); o += 2;
  }
  for (const fr of frames) for (let i = 0; i < 3; i++) { buf.writeFloatLE(fr.rootDelta[i], o); o += 4; }
  fs.writeFileSync(path.join(ANIM_DIR, `${clip.id}.bin`), buf);
  return { frames: n, bytes: size };
}

// ---------------- 3. 特征提取（只处理 locomotion 片段） ----------------
function buildFeatureFrames() {
  const loco = manifest.clips.filter((c) => ['idle', 'walk', 'jog', 'sprint', 'crouch'].includes(c.tag));
  const frames = [];
  loco.forEach((clip, clipIndex) => {
    const n = Math.floor(clip.durationSec * sampleHz) + 1;
    const speed = clip.speed ?? 0;
    for (let f = 0; f < n; f++) {
      const t = f / sampleHz;
      const strideHz = clip.tag === 'crouch' ? 1.0 : 0.9 + speed * 0.28;
      const phase = 2 * Math.PI * strideHz * t;
      const traj = SAMPLE_TIMES.map((s) => ({
        pos: [0.02 * Math.sin(phase + s * 3), speed * s],   // 局部 +Z 前进的轨迹
        facing: [0, 1],
      }));
      const pose = [
        0.02 + 0.012 * Math.sin(phase), 0.02 + 0.012 * Math.cos(phase),
        0.95 + speed * 0.004,
        Math.sin(phase * 0.5) * 0.12, Math.cos(phase * 0.5),
        speed * 0.075, -speed * 0.075,
        speed / MM.MAX_DB_SPEED,
      ];
      frames.push({
        clipIndex, clipId: clip.id, tag: fnv1a(clip.tag) & 0xff, time: t,
        feature: makeFeature({ traj, pose, heading: [0, 1], velocity: [0, speed] }),
        footPhase: [Math.round(127.5 + 127.5 * Math.sin(phase)), Math.round(127.5 + 127.5 * Math.sin(phase + Math.PI))],
      });
    }
  });
  return { loco, frames };
}

// ---------------- 4. MMDB 二进制（对齐 10 章 §7，flags=7 含 rawFeatures）----------------
function writeMMDB() {
  const { loco, frames } = buildFeatureFrames();
  const count = frames.length;
  const dims = FEATURE_LEN;
  const features = new Float32Array(count * dims);
  const clipIndexOfFrame = new Uint32Array(count);
  const timeOfFrame = new Float32Array(count);
  const tagOfFrame = new Uint8Array(count);
  const footPhase = new Uint8Array(count * 2);
  frames.forEach((fr, i) => {
    features.set(fr.feature, i * dims);
    clipIndexOfFrame[i] = fr.clipIndex;
    timeOfFrame[i] = fr.time;
    tagOfFrame[i] = fr.tag;
    footPhase[i * 2] = fr.footPhase[0];
    footPhase[i * 2 + 1] = fr.footPhase[1];
  });

  const pca = pcaFromFeatures(features, count, dims, MM.PCA_DIMS, 30);
  const projected = projectAll(features, count, pca);
  const tree = buildKdTree(projected, pca.k, count, MM.KD_LEAF);

  // clipTable：每个片段在帧序列里的起始帧与长度
  const clipTable = [];
  for (let c = 0; c < loco.length; c++) {
    const idx = [];
    for (let i = 0; i < count; i++) if (clipIndexOfFrame[i] === c) idx.push(i);
    clipTable.push({ hash: fnv1a(loco[c].id), startFrame: idx[0] ?? 0, frameCount: idx.length, durationSec: loco[c].durationSec });
  }

  // 计算总字节
  const HEAD = 4 + 2 + 2 + 4 + 4 + 4 + 4 + 4;                  // magic,ver,flags,frameCount,dims,pcaDims,sampleHz,clipCount
  const clipBytes = clipTable.length * (4 + 4 + 4 + 4);
  const pcaBytes = dims * 4 + dims * pca.k * 4;
  const projBytes = count * pca.k * 4;
  const nodeBytes = 4 + tree.nodes.length * (4 + 4 + 4 + 4 + 4 + 4);   // nodeCount + 每节点 24B
  const idxBytes = count * 4 + count * 4 + count * 1 + count * 2;
  const rawBytes = count * dims * 4;
  const total = HEAD + clipBytes + pcaBytes + projBytes + nodeBytes + idxBytes + rawBytes;
  const buf = Buffer.alloc(total);
  let o = 0;
  buf.write('MMDB', o, 4, 'ascii'); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(0b111, o); o += 2;                          // bit0 PCA, bit1 KDTree, bit2 rawFeatures
  buf.writeUInt32LE(count, o); o += 4;
  buf.writeUInt32LE(dims, o); o += 4;
  buf.writeUInt32LE(pca.k, o); o += 4;
  buf.writeUInt32LE(sampleHz, o); o += 4;
  buf.writeUInt32LE(clipTable.length, o); o += 4;
  for (const c of clipTable) {
    buf.writeUInt32LE(c.hash, o); o += 4;
    buf.writeUInt32LE(c.startFrame, o); o += 4;
    buf.writeUInt32LE(c.frameCount, o); o += 4;
    buf.writeFloatLE(c.durationSec, o); o += 4;
  }
  for (let i = 0; i < dims; i++) { buf.writeFloatLE(pca.mean[i], o); o += 4; }
  for (let i = 0; i < dims * pca.k; i++) { buf.writeFloatLE(pca.basis[i], o); o += 4; }
  for (let i = 0; i < count * pca.k; i++) { buf.writeFloatLE(projected[i], o); o += 4; }
  buf.writeUInt32LE(tree.nodes.length, o); o += 4;
  for (const nd of tree.nodes) {
    buf.writeUInt32LE(nd.dim >>> 0, o); o += 4;
    buf.writeFloatLE(nd.val, o); o += 4;
    buf.writeInt32LE(nd.left, o); o += 4;
    buf.writeInt32LE(nd.right, o); o += 4;
    buf.writeUInt32LE(nd.start >>> 0, o); o += 4;
    buf.writeUInt32LE(nd.count >>> 0, o); o += 4;
  }
  for (let i = 0; i < count; i++) { buf.writeUInt32LE(clipIndexOfFrame[i], o); o += 4; }
  for (let i = 0; i < count; i++) { buf.writeFloatLE(timeOfFrame[i], o); o += 4; }
  for (let i = 0; i < count; i++) { buf.writeUInt8(tagOfFrame[i], o); o += 1; }
  for (let i = 0; i < count * 2; i++) { buf.writeUInt8(footPhase[i], o); o += 1; }
  for (let i = 0; i < count * dims; i++) { buf.writeFloatLE(features[i], o); o += 4; }

  fs.writeFileSync(MMDB_PATH, buf);
  return { count, dims, pcaK: pca.k, clips: clipTable.length, nodes: tree.nodes.length, depth: treeDepth(tree), bytes: total, written: o };
}

// ---------------- 5. 校验 ----------------
function checkMMDB() {
  if (!fs.existsSync(MMDB_PATH)) return { ok: false, detail: 'mmdb 不存在，先跑一次烘焙' };
  const st = fs.statSync(MMDB_PATH);
  const head = Buffer.alloc(28);
  const fd = fs.openSync(MMDB_PATH, 'r');
  fs.readSync(fd, head, 0, 28, 0);
  fs.closeSync(fd);
  const magic = head.toString('ascii', 0, 4);
  const version = head.readUInt16LE(4);
  const flags = head.readUInt16LE(6);
  const frameCount = head.readUInt32LE(8);
  const dims = head.readUInt32LE(12);
  const pcaDims = head.readUInt32LE(16);
  const hz = head.readUInt32LE(20);
  const clipCount = head.readUInt32LE(24);
  const problems = [];
  if (magic !== 'MMDB') problems.push(`magic=${magic}`);
  if (version !== 1) problems.push(`version=${version}`);
  if (hz !== 30) problems.push(`sampleHz=${hz}`);
  if (dims !== FEATURE_LEN) problems.push(`dims=${dims}≠${FEATURE_LEN}`);
  if (pcaDims !== MM.PCA_DIMS) problems.push(`pcaDims=${pcaDims}≠${MM.PCA_DIMS}`);
  if ((flags & 4) === 0) problems.push('flags bit2（rawFeatures）未置位：粗筛后无法回原空间精算');
  if (frameCount < 6000) problems.push(`frameCount=${frameCount} < 6000`);
  if (st.size <= 28) problems.push('文件长度异常');
  return {
    ok: problems.length === 0,
    detail: problems.length
      ? problems.join('; ')
      : `MMDB OK frames=${frameCount} dims=${dims} pca=${pcaDims} hz=${hz} clips=${clipCount} flags=${flags} size=${(st.size / 1024).toFixed(0)}KB`,
  };
}

// ---------------- 执行 ----------------
if (CHECK_ONLY) {
  const r = checkMMDB();
  console.log(r.ok ? `✓ ${r.detail}` : `✗ ${r.detail}`);
  process.exitCode = r.ok ? 0 : 1;
} else {
  let totalFrames = 0, totalBytes = 0;
  for (const clip of manifest.clips) {
    const r = writeAnimBin(clip);
    totalFrames += r.frames; totalBytes += r.bytes;
  }
  const m = writeMMDB();
  const chk = checkMMDB();
  console.log(`\n=== 烘焙完成（程序化合成姿态，非动捕素材）===`);
  console.log(`ANIM bin：${manifest.clips.length} 个片段 / ${totalFrames} 帧 / ${(totalBytes / 1024 / 1024).toFixed(2)} MB → public/data/anim/`);
  console.log(`MMDB：${m.count} 帧 × ${m.dims} 维 → PCA ${m.pcaK} → KDTree ${m.nodes} 节点（深度 ${m.depth}）/ ${(m.bytes / 1024).toFixed(0)} KB`);
  console.log(`校验：${chk.ok ? '✓ ' + chk.detail : '✗ ' + chk.detail}`);
  console.log(`提示：换真实素材只需替换 tools/bake-mm.mjs 里的 readClipFrames()，二进制布局不变。\n`);
  process.exitCode = chk.ok ? 0 : 1;
}
