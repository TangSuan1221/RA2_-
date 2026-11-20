// 战斗系统框架 · 参考实现 · KDTree（PCA 投影空间上的粗筛）
// 契约：buildKdTree(points, dims, count, leafSize) / knnSearch(tree, query, k) → [{index, dist2}]
// 说明：这是"粗筛"，之后必须回到原始 32 维特征做全代价精算（见 mm.mjs match 的 candidates 阶段）。
// 实现取舍：递归 + 严格剪枝（深度 ≤ log2(N/leaf) ≈ 9），比迭代栈更好验证。

export function buildKdTree(points, dims, count, leafSize = 16) {
  const idx = new Int32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  const nodes = [];

  function variance(d, lo, hi) {
    let s = 0, s2 = 0;
    const n = hi - lo;
    for (let i = lo; i < hi; i++) { const v = points[idx[i] * dims + d]; s += v; s2 += v * v; }
    const m = s / n;
    return s2 / n - m * m;
  }
  function selectDim(lo, hi) {
    let best = 0, bestVar = -1;
    for (let d = 0; d < dims; d++) { const v = variance(d, lo, hi); if (v > bestVar) { bestVar = v; best = d; } }
    return best;
  }
  // 原地分区，使 [lo,mid) 小于等于 [mid,hi)
  function nthElement(lo, hi, mid, d) {
    let l = lo, r = hi - 1;
    while (l < r) {
      const pivot = points[idx[(l + r) >> 1] * dims + d];
      let i = l, j = r;
      while (i <= j) {
        while (points[idx[i] * dims + d] < pivot) i++;
        while (points[idx[j] * dims + d] > pivot) j--;
        if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
      }
      if (mid <= j) r = j;
      else if (mid >= i) l = i;
      else return;
    }
  }

  function build(lo, hi) {
    const node = { dim: 0, val: 0, left: -1, right: -1, start: 0, count: 0 };
    const ni = nodes.length;
    nodes.push(node);
    const n = hi - lo;
    const d = selectDim(lo, hi);
    node.dim = d;
    if (n <= leafSize) {
      node.start = lo; node.count = n;
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += points[idx[i] * dims + d];
      node.val = sum / n;
      return ni;
    }
    const mid = lo + (n >> 1);
    nthElement(lo, hi, mid, d);
    node.val = points[idx[mid] * dims + d];
    node.left = build(lo, mid);
    node.right = build(mid, hi);
    return ni;
  }
  const root = build(0, count);
  return { nodes, root, points, dims, count, leafSize, idx };
}

export function knnSearch(tree, query, k) {
  const { nodes, points, dims, idx } = tree;
  const res = [];
  const worst = () => (res.length < k ? Infinity : res[res.length - 1].dist2);

  function push(i, d2) {
    if (res.length >= k && d2 >= res[res.length - 1].dist2) return;
    let pos = res.length;
    while (pos > 0 && res[pos - 1].dist2 > d2) pos--;
    res.splice(pos, 0, { index: i, dist2: d2 });
    if (res.length > k) res.pop();
  }
  function dist2At(i) {
    const base = i * dims;
    let s = 0;
    for (let d = 0; d < dims; d++) { const df = points[base + d] - query[d]; s += df * df; }
    return s;
  }
  function visit(ni) {
    const node = nodes[ni];
    if (node.count > 0) {
      for (let i = node.start; i < node.start + node.count; i++) push(idx[i], dist2At(idx[i]));
      return;
    }
    const diff = query[node.dim] - node.val;
    const near = diff < 0 ? node.left : node.right;
    const far = diff < 0 ? node.right : node.left;
    if (near >= 0) visit(near);
    if (far >= 0 && diff * diff <= worst()) visit(far);
  }
  if (tree.count > 0) visit(tree.root);
  return res;
}

// 树的最大深度（用于断言"树没有退化成一维列表"）
export function treeDepth(tree) {
  let max = 0;
  const stack = [[tree.root, 0]];
  while (stack.length) {
    const [ni, d] = stack.pop();
    const node = tree.nodes[ni];
    if (d > max) max = d;
    if (node.left >= 0) stack.push([node.left, d + 1]);
    if (node.right >= 0) stack.push([node.right, d + 1]);
  }
  return max;
}
