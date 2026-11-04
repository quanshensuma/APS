/**
 * 前后端一致性对比
 * 前端：web/engine.js（纯 JS 引擎）
 * 后端：web/app.py 的 /api/generate（Python 引擎）
 * 逐项比关键数字，任何不一致都打印出来。
 *
 * 运行：node test/parity_check.js
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const E = require('../engine.js');
const reader = require('../xlsx-lite.js');

const ROOT = path.resolve(__dirname, '..', '..');
// 台账优先取 data/，其次取 文件/
const CANDIDATES = [
  path.resolve(ROOT, 'data', '宏达精密_订单台账.xlsx'),
  path.resolve(ROOT, '..', '文件', '宏达精密_订单台账.xlsx'),
];
const XLSX_PATH = CANDIDATES.find(p => fs.existsSync(p)) || CANDIDATES[0];
const HOST = process.env.APS_HOST || '127.0.0.1';
const PORT = process.env.APS_PORT || 8801;

let fails = 0;
function cmp(label, fe, be, tol) {
  const a = typeof fe === 'number' ? fe : fe;
  const b = typeof be === 'number' ? be : be;
  let same;
  if (typeof a === 'number' && typeof b === 'number') {
    same = Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol);
  } else {
    same = String(a) === String(b);
  }
  if (!same) fails++;
  console.log((same ? '  ✓ ' : '  ✗ ') + label + '  前端=' + fe + '  后端=' + be);
  return same;
}

function post(port, fileBuf, filename, options) {
  return new Promise((resolve, reject) => {
    const boundary = '----APS' + Date.now();
    const optsJson = JSON.stringify(options || {});
    const parts = [];
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="options"\r\n\r\n' +
      optsJson + '\r\n'));
    parts.push(Buffer.from(
      '--' + boundary + '\r\n' +
      'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n' +
      'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'));
    parts.push(fileBuf);
    parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
    const body = Buffer.concat(parts);

    const req = http.request({
      host: HOST, port: port, path: '/api/generate', method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => (buf += c));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('返回不是 JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('══════════════ 前后端一致性对比 ══════════════');
  if (!fs.existsSync(XLSX_PATH)) {
    console.log('跳过：找不到台账 ' + XLSX_PATH);
    return;
  }
  const buf = fs.readFileSync(XLSX_PATH);
  const sheets = await reader.readWorkbook(buf);

  const FE_OPTS = {
    allowSwap: true, enableGrd02: false, enableCnc03: false,
    lotSize: 20, flowOn: true, flowGap: 30, threeShift: false,
  };
  const BE_OPTS = {
    allowSwap: true, enableGrd02: false, enableCnc03: false,
    lotSize: 20, flowOn: true, flowGap: 30, threeShift: false,
  };

  const R = E.run(sheets, FE_OPTS);

  let B;
  try {
    B = await post(PORT, buf, '宏达精密_订单台账.xlsx', BE_OPTS);
  } catch (e) {
    console.log('后端连不上（' + HOST + ':' + PORT + '）：' + e.message);
    console.log('请先启动：python web/app.py --port ' + PORT);
    process.exitCode = 2;
    return;
  }
  if (!B.ok) {
    console.log('后端返回失败：' + B.error_code + ' ' + B.error_msg);
    process.exitCode = 2;
    return;
  }

  // ---------- 1. 订单数 ----------
  console.log('\n── 1. 订单与工序 ──');
  cmp('台账有效订单数', R.meta.counts.ordersTotal, B.meta.rows_read > 0
      ? B.metrics.orders_total : null);
  cmp('可排订单数', R.meta.counts.ordersOk, B.metrics.orders_ok);
  cmp('待复核订单数', R.meta.counts.ordersBlocked, B.metrics.orders_blocked);

  // ---------- 2. 窗口 ----------
  console.log('\n── 2. 窗口与原点 ──');
  cmp('窗口起点', R.meta.horizon.start, B.meta.window_start);
  cmp('窗口终点', R.meta.horizon.end, B.meta.window_end);
  cmp('单台窗口容量', R.meta.horizon.capacity || 5760, B.meta.capacity_per_machine);

  // ---------- 3. 负荷与缺口（核心）----------
  console.log('\n── 3. 负荷与缺口（核心）──');
  const feG = {};
  R.capacity.groups.forEach(x => (feG[x.group] = x));
  const beG = {};
  (B.capacity || []).forEach(x => (beG[x.group] = x));

  ['下料', '车', '铣', '钻', '磨'].forEach(g => {
    if (!feG[g] || !beG[g]) { console.log('  · ' + g + ' 缺一组数据'); return; }
    cmp(g + ' 负荷', feG[g].load, beG[g].load_minutes, 0.1);
    cmp(g + ' 缺口', feG[g].gap, beG[g].gap_minutes, 0.1);
  });

  // 总负荷
  const feTotal = R.capacity.groups.reduce((s, x) => s + (x.load || 0), 0);
  cmp('总负荷', feTotal, B.metrics.total_load_min, 0.5);

  // ---------- 4. 校验 ----------
  console.log('\n── 4. 校验结果 ──');
  const feLines = (R.verify && R.verify.lines) || [];
  const feMap = {};
  feLines.forEach(l => { feMap[l.code] = l.ok; });
  ['H1', 'H2', 'H3', 'H4', 'H5'].forEach(code => {
    const fv = feMap[code];
    const bv = B.verify[code.toLowerCase()];
    const norm = v => (v === true || v === 'PASS' ? 'PASS' : 'FAIL');
    cmp(code, norm(fv), norm(bv));
  });
  const feOverall = R.verify && R.verify.result;
  console.log('  · 前端总体: ' + feOverall + '  | 后端总体: ' + B.verify.result);

  // ---------- 5. 风险分类 ----------
  console.log('\n── 5. 风险清单分类 ──');
  const feRisk = {};
  const feRows = (R.risk && R.risk.rows) || [];
  feRows.forEach(r => {
    const k = r.type || r.status || r.kind || 'unknown';
    feRisk[k] = (feRisk[k] || 0) + 1;
  });
  if (typeof global.__printedRiskKeys === 'undefined' && feRows.length) {
    global.__printedRiskKeys = true;
    console.log('  · 前端风险行样本: ' + JSON.stringify(feRows[0]).slice(0, 220));
  }
  const beRisk = {};
  (B.risks || []).forEach(r => { beRisk[r.type] = (beRisk[r.type] || 0) + 1; });

  ['delayed', 'at_risk', 'not_scheduled_in_horizon', 'unplannable'].forEach(k => {
    cmp('风险「' + k + '」条数', feRisk[k] || 0, beRisk[k] || 0);
  });

  // ---------- 6. 体检 ----------
  console.log('\n── 6. 数据体检 ──');
  const feCats = (R.meta.counts && (R.meta.counts.issueCategories
      || R.meta.counts.categories)) || null;
  cmp('问题类别数', feCats, B.meta.issue_categories);

  // ---------- 汇总 ----------
  console.log('\n══════════════════════════════════════════════');
  if (fails === 0) {
    console.log('✅ 前后端数字完全一致');
  } else {
    console.log('⚠️  有 ' + fails + ' 项不一致（见上方 ✗）');
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('对比脚本异常：' + e.message);
  console.error(e.stack);
  process.exitCode = 2;
});
