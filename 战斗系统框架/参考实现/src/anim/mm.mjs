// 战斗系统框架 · 参考实现 · 运动匹配（特征 / 归一化 / PCA / 代价 / 检索）
// 契约见 03 §4.2：match(query: MMQuery, db, settings, continuing, recent) → MatchResult
//
// 特征布局（32 维，与 04 章 §2 一致）：
//   traj   [0..19]  5 个采样点 × (posX, posZ, facingX, facingZ)
//                   采样时刻 = MM.TRAJ_PAST(-0.20,-0.40s) + MM.TRAJ_FUTURE(0.20,0.40,0.67s)
//   pose   [20..27] 8 维（足高/髋高/胸朝向/步幅等，数据库内已归一到 0..1）
//   heading[28..29] 当前朝向 (x,z)
//   velocity[30..31] 当前速度 (x,z) / MM.MAX_DB_SPEED
//
// 代价 = Σ_c w_c · mean_i( (q_i − d_i)² )   ← 通道内取均值，避免"维度多的通道压死别的通道"

import { MM } from '../core/constants.mjs';
import { buildKdTree, knnSearch } from './kdtree.mjs';

export const FEATURE_LEN = 32;
export const TRAJ_SCALE = 4.0;           // 位置归一化分母（米）
const OFFS = { traj: 0, pose: 20, heading: 28, velocity: 30 };
const LENS = { traj: 20, pose: 8, heading: 2, velocity: 2 };
export const SAMPLE_TIMES = [...MM.TRAJ_PAST, ...MM.TRAJ_FUTURE];

export function makeFeature({ traj, pose, heading, velocity }) {
  const f = new Float32Array(FEATURE_LEN);
  for (let i = 0; i < 5; i++) {
    const p = traj[i];
    f[OFFS.traj + i * 4 + 0] = p.pos[0] / TRAJ_SCALE;
    f[OFFS.traj + i * 4 + 1] = p.pos[1] / TRAJ_SCALE;
    f[OFFS.traj + i * 4 + 2] = p.facing[0];
    f[OFFS.traj + i * 4 + 3] = p.facing[1];
  }
  for (let i = 0; i < 8; i++) f[OFFS.pose + i] = pose[i];
  f[OFFS.heading + 0] = heading[0];
  f[OFFS.heading + 1] = heading[1];
  f[OFFS.velocity + 0] = velocity[0] / MM.MAX_DB_SPEED;
  f[OFFS.velocity + 1] = velocity[1] / MM.MAX_DB_SPEED;
  return f;
}

// ---------- 通道加权代价 ----------
export function cost(q, d, weights = MM) {
  const out = { traj: 0, pose: 0, heading: 0, velocity: 0, total: 0 };
  for (const ch of ['traj', 'pose', 'heading', 'velocity']) {
    let s = 0;
    for (let i = 0; i < LENS[ch]; i++) {
      const df = q[OFFS[ch] + i] - d[OFFS[ch] + i];
      s += df * df;
    }
    out[ch] = s / LENS[ch];
  }
  out.total =
    weights.W_TRAJ * out.traj +
    weights.W_POSE * out.pose +
    weights.W_HEADING * out.heading +
    weights.W_VELOCITY * out.velocity;
  return out;
}

// ---------- PCA（协方差 + 幂迭代 + 收缩）----------
export function pcaFromFeatures(features, count, dims = FEATURE_LEN, k = MM.PCA_DIMS, iters = 40) {
  const mean = new Float32Array(dims);
  for (let i = 0; i < count; i++) for (let d = 0; d < dims; d++) mean[d] += features[i * dims + d];
  for (let d = 0; d < dims; d++) mean[d] /= count;

  const cov = new Float32Array(dims * dims);
  for (let i = 0; i < count; i++) {
    const base = i * dims;
    for (let a = 0; a < dims; a++) {
      const va = features[base + a] - mean[a];
      for (let b = a; b < dims; b++) {
        cov[a * dims + b] += va * (features[base + b] - mean[b]);
      }
    }
  }
  for (let a = 0; a < dims; a++) for (let b = a; b < dims; b++) {
    const v = cov[a * dims + b] / count;
    cov[a * dims + b] = v; cov[b * dims + a] = v;
  }

  const basis = new Float32Array(k * dims);
  const work = new Float32Array(cov);       // 收缩用副本
  const v = new Float64Array(dims);
  for (let c = 0; c < k; c++) {
    for (let d = 0; d < dims; d++) v[d] = 1 / Math.sqrt(dims); // 初值
    for (let it = 0; it < iters; it++) {
      const w = new Float64Array(dims);
      for (let a = 0; a < dims; a++) {
        let s = 0;
        for (let b = 0; b < dims; b++) s += work[a * dims + b] * v[b];
        w[a] = s;
      }
      let n = 0;
      for (let d = 0; d < dims; d++) n += w[d] * w[d];
      n = Math.sqrt(n) || 1;
      for (let d = 0; d < dims; d++) v[d] = w[d] / n;
    }
    // Rayleigh 商 → 特征值
    let ev = 0;
    for (let a = 0; a < dims; a++) { let s = 0; for (let b = 0; b < dims; b++) s += work[a * dims + b] * v[b]; ev += v[a] * s; }
    for (let d = 0; d < dims; d++) basis[c * dims + d] = v[d];
    // 收缩：work -= ev * v vᵀ
    for (let a = 0; a < dims; a++) for (let b = 0; b < dims; b++) work[a * dims + b] -= ev * v[a] * v[b];
  }
  return { mean, basis, dims, k };
}

export function projectOne(f, pca) {
  const out = new Float32Array(pca.k);
  for (let c = 0; c < pca.k; c++) {
    let s = 0;
    const base = c * pca.dims;
    for (let d = 0; d < pca.dims; d++) s += pca.basis[base + d] * (f[d] - pca.mean[d]);
    out[c] = s;
  }
  return out;
}

export function projectAll(features, count, pca) {
  const out = new Float32Array(count * pca.k);
  for (let i = 0; i < count; i++) {
    const p = projectOne(features.subarray(i * pca.dims, (i + 1) * pca.dims), pca);
    out.set(p, i * pca.k);
  }
  return out;
}

// ---------- 建库（离线烘焙结果的内存形态）----------
export function buildMMDB(frames, opts = {}) {
  const count = frames.length;
  const dims = FEATURE_LEN;
  const features = new Float32Array(count * dims);
  const clipIndexOfFrame = new Int32Array(count);
  const timeOfFrame = new Float32Array(count);
  const tagOfFrame = new Uint8Array(count);
  const footPhase = new Uint8Array(count * 2);
  const clips = [];

  for (let i = 0; i < count; i++) {
    const fr = frames[i];
    features.set(fr.feature, i * dims);
    clipIndexOfFrame[i] = fr.clipIndex;
    timeOfFrame[i] = fr.time;
    tagOfFrame[i] = fr.tag ?? 0;
    footPhase[i * 2] = fr.footPhase?.[0] ?? 0;
    footPhase[i * 2 + 1] = fr.footPhase?.[1] ?? 0;
  }
  for (const f of frames) {
    if (!clips[f.clipIndex]) clips[f.clipIndex] = { index: f.clipIndex, id: f.clipId, tag: f.tag ?? 0, duration: 0 };
    clips[f.clipIndex].duration = Math.max(clips[f.clipIndex].duration, f.time);
  }

  const usePca = opts.usePca !== false;
  const pca = usePca ? pcaFromFeatures(features, count, dims) : null;
  const treePoints = usePca ? projectAll(features, count, pca) : features;
  const treeDims = usePca ? pca.k : dims;
  const tree = buildKdTree(treePoints, treeDims, count, opts.leafSize ?? MM.KD_LEAF);

  return {
    features, count, dims, clipIndexOfFrame, timeOfFrame, tagOfFrame, footPhase,
    clips, pca, tree, treePoints, treeDims,
    degraded: count < 2000,               // 10 §9：< 2000 帧视为退化库
    sampleHz: MM.SAMPLE_HZ,
  };
}

// ---------- 检索 ----------
export const TAG = { idle: 0, walk: 1, jog: 2, sprint: 3, crouch: 4 };

/**
 * @param {Float32Array} query 32 维特征
 * @param {object} db buildMMDB 产物
 * @param {object} settings MM 权重（默认 MM）
 * @param {{clipIndex:number, frameIndex:number, time:number}|null} continuing
 * @param {Map<number,number>} recent frameIndex → 被选中时的逻辑时间（秒），用于 RESELECT_T
 * @param {number} nowSec 当前逻辑时间（秒）
 */
export function match(query, db, settings = MM, continuing = null, recent = new Map(), nowSec = 0) {
  const q = db.pca ? projectOne(query, db.pca) : query;
  const cands = knnSearch(db.tree, q, MM.KNN);
  const rej = { poseJump: 0, reselect: 0, fallback: 0 };

  const evaluate = (allowFiltered) => {
    let best = null;
    for (const c of cands) {
      const i = c.index;
      const clipIdx = db.clipIndexOfFrame[i];
      const t = db.timeOfFrame[i];
      let filteredHere = false;

      // 同段内不许跳太近（MM.POSE_JUMP_T）
      if (continuing && clipIdx === continuing.clipIndex && Math.abs(t - continuing.time) < MM.POSE_JUMP_T) {
        if (!allowFiltered) { rej.poseJump++; continue; }
        filteredHere = true;
      }
      // 禁选最近选中过的帧（MM.RESELECT_T）
      const lastSel = recent.get(i);
      if (lastSel !== undefined && nowSec - lastSel < MM.RESELECT_T) {
        if (!allowFiltered) { rej.reselect++; continue; }
        filteredHere = true;
      }
      if (filteredHere) rej.fallback++;

      const br = cost(query, db.features.subarray(i * db.dims, (i + 1) * db.dims), settings);
      let total = br.total;
      // 继续播放折扣（负值 = 鼓励不换帧）
      const isContinuing = continuing && clipIdx === continuing.clipIndex && t >= continuing.time;
      if (isContinuing && t - continuing.time <= 0.5) total += settings.CONTINUING_BIAS;
      br.total = total;

      if (!best || total < best.cost) {
        best = {
          frameIndex: i, clipIndex: clipIdx,
          clipId: db.clips[clipIdx]?.id ?? String(clipIdx),
          time: t, tag: db.tagOfFrame[i], cost: total, breakdown: br, usedFallback: filteredHere,
        };
      }
    }
    return best;
  };

  // 第一遍：严格过滤；若候选被过滤干净（转向剧烈时的常见情况），第二遍允许受罚候选
  let best = evaluate(false);
  const fallbackUsed = best === null;
  if (!best) best = evaluate(true);
  if (!best) return null;

  return {
    ...best,
    stats: {
      candidates: cands.length,
      filtered: rej.poseJump + rej.reselect,
      rejectedByPoseJump: rej.poseJump,
      rejectedByReselect: rej.reselect,
      fallback: fallbackUsed,
    },
  };
}

// 把"最优帧"换算成"该片段内的播放时间"，供蒙太奇/层混合使用
export function frameToClipTime(db, frameIndex) {
  const clipIdx = db.clipIndexOfFrame[frameIndex];
  return { clipIndex: clipIdx, clipId: db.clips[clipIdx]?.id, time: db.timeOfFrame[frameIndex] };
}
