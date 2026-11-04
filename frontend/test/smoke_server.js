/**
 * 后端模式冒烟：用 mock 响应验证 F1/F2 面板能渲染后端字段，
 * 以及字段缺失时优雅降级。不依赖真实后端（后端正在并行改）。
 * 运行：NODE_PATH=../.devtools/node_modules node test/smoke_server.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PAGE = 'file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/');
const SHOT = path.resolve(__dirname, '../../screenshots');
let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + l + (e !== undefined ? '  → ' + e : ''));
  if (!c) fails++;
};

/** 假健康检查 + 假 generate 响应 */
function mockPayload(withFields, realShape) {
  const rs = realShape || {};
  const base = {
    ok: true,
    meta: { version: '1.0.0', sourceFile: '宏达精密_订单台账.xlsx', rows_read: 14, elapsed_ms: 800 },
    metrics: rs.metrics || {
      orders_total: 14, orders_ok: 13, orders_blocked: 1, delayed: 4, at_risk: 1
    },
    risks: rs.risks || [
      { orderId: 'HD-2026-101', type: 'delayed', dueMd: '11-10', plannedEndLabel: '11-17 16:00', bottleneckMachine: 'GRD-01', bottleneckOp: '磨', qty: 40 }
    ],
    // 【真实契约】server/app.py 的 schedule 是数组；本地 engine 才是 {operations:[]}
    schedule: rs.scheduleArray ? new Array(65).fill(0).map((_, i) => ({ seq: i + 1 }))
      : { operations: [] },
    unplannable: [],
    capacity: [{ group: '磨', machines: ['GRD-01'], load_minutes: 12350, capacity_minutes: 5760, gap_minutes: 6590, over: true }],
    verify: {
      h1: 'PASS', h2: 'PASS', h3: 'PASS', h4: 'PASS', h5: 'FAIL',
      checked: { h1: 65, h2: 65, h3: 21, h4: 65, h5: 10 },
      violations: [{ rule: 'h5', message: 'HD-2026-103-L1 车间隔 3125 min > 30' }],
      result: 'PASS_WITH_WARN',
      resultCn: '硬约束通过 / 流水条件未达成'
    }
  };
  if (withFields) {
    // 真实后端契约（server/app.py 已落地）：handover/confirm 是产物描述，不是内联正文
    base.artifacts = [
      { name: '排单表.xlsx', title: '周排单表', available: true, stale: false, downloadUrl: '/api/download/%E6%8E%92%E5%8D%95%E8%A1%A8.xlsx' },
      { name: '甘特图.html', title: '甘特图', available: true, stale: false, downloadUrl: '/api/download/gantt' },
      { name: '风险清单.xlsx', title: '交期风险清单', available: true, stale: false, downloadUrl: '/api/download/risk' },
      { name: '体检报告.md', title: '数据体检报告', available: true, stale: false, downloadUrl: '/api/download/health' },
      { name: '交接说明.md', title: '交接说明', available: true, stale: false, downloadUrl: '/api/download/handover' }
    ];
    base.handover = { name: '交接说明.md', title: '交接说明', desc: '假设/局限/怎么重跑', available: true, stale: false, downloadUrl: '/api/download/handover' };
    base.confirm = { name: '需求确认单.md', title: '需求确认单', desc: '三件事/不要的/问答', available: true, stale: false, downloadUrl: '/api/download/confirm' };
    base.staleArchived = [
      { name: '排单表.xlsx', title: '上一版排单表', available: true, stale: true, downloadUrl: null }
    ];
  }
  return base;
}

async function run(withFields, realShape) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const payload = mockPayload(withFields, realShape);

  // 用 route 拦截：让探测认为后端在线，并返回 mock
  await page.route('**/api/health', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, version: '1.0.0', mode: 'server' })
  }));
  await page.route('**/api/generate', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(payload)
  }));

  // 关键：必须从 http 源加载，否则 location.origin 为 null、canUseServer 为 false
  // 用一个静态托管把页面挂到 http://127.0.0.1:<port>/ 上，route 拦截同一个源
  const http = require('http');
  const ROOT = path.resolve(__dirname, '..');
  const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: '1.0.0', mode: 'server' }));
    }
    if (req.url === '/api/generate') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }
    const f = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await page.goto('http://127.0.0.1:' + port + '/index.html');
  await page.waitForTimeout(500);

  // 直接注入 sheet 数据，绕过文件选择，聚焦面板渲染
  await page.evaluate(() => {
    const sheet = [
      ['宏达精密 · 待排产订单（样例数据，仅用于测试渲染）'],
      ['单号', '客户', '接单日期', '交期', '产品', '数量', '备注'],
      ['HD-2026-101', '客户甲', '2026/11/3', '2026-11-10', '阀体A', 40, ''],
    ];
    window.__mockSheets = { 订单: sheet, 设备: sheet, 工艺路线: sheet };
  });

  return { browser, page, errors, server };
}

(async () => {
  console.log('\n=== A. 后端字段齐全：F1/F2 正常渲染 ===');
  {
    const { browser, page, errors, server } = await run(true);
    // 直接调渲染函数验证（页面已加载 mock 后端）
    const r = await page.evaluate(async () => {
      const out = await window.APSData.runViaServer(new Blob(['x']), {});
      const u = window.APSData.unify(out.mode, out.payload, { fileName: '宏达精密_订单台账.xlsx', now: new Date().toISOString() });
      // 用 app.js 同款语义从 artifacts 里取
      const raw = u.raw || {};
      const arr = raw.artifacts || [];
      const keys = arr.map(x => {
        const n = String(x.name || '');
        if (/排单|排程表/.test(n)) return 'orders';
        if (/甘特/.test(n)) return 'gantt';
        if (/风险/.test(n)) return 'risk';
        if (/体检/.test(n)) return 'health';
        if (/交接/.test(n)) return 'handover';
        return '';
      }).filter(Boolean);
      return {
        mode: u.mode,
        hasHandover: !!u.handover,
        fileOnly: u.handover ? u.handover.fileOnly : null,
        href: u.handover ? u.handover.files.md : '',
        hrefOk: !!(u.handover && u.handover.files && u.handover.files.md),
        artCount: arr.length,
        artKeys: keys,
        staleStale: Array.isArray(raw.staleArchived) ? !!raw.staleArchived[0].stale : null
      };
    });
    ok(r.mode === 'server', '识别为 server 模式', r.mode);
    ok(r.hasHandover, 'handover 已规整为 fileOnly（真实契约）', r.hasHandover);
    ok(r.fileOnly === true, 'handover 判定为「正文在文件里」', r.fileOnly);
    ok(r.hrefOk === true, '拿到了 md 下载链接', r.href);
    ok(r.artCount === 5, 'artifacts 数组解析出 5 件产物', r.artCount);
    ok(r.artKeys.join(',') === 'orders,gantt,risk,health,handover', '产物语义键映射正确', r.artKeys.join(','));
    ok(r.staleStale === true, 'staleArchived 项标记 stale=true', r.staleStale);
    ok(errors.length === 0, '无 JS 报错', errors.slice(0, 2).join(' | ') || '0');
    await browser.close(); server.close();
  }

  console.log('\n=== B. 后端字段缺失：优雅降级 ===');
  {
    const { browser, page, errors, server } = await run(false);
    const r = await page.evaluate(async () => {
      const out = await window.APSData.runViaServer(new Blob(['x']), {});
      const u = window.APSData.unify(out.mode, out.payload, { fileName: 'x.xlsx', now: new Date().toISOString() });
      return {
        handover: u.handover === null,
        confirm: u.confirm === null,
        unconf: u.unconfirmed ? u.unconfirmed.confirmed : 'n/a',
        Rverify: u.R.verify ? u.R.verify.result : null,
        groups: u.R.verify ? u.R.verify.groups.map(g => g.title) : []
      };
    });
    ok(r.handover === true, 'handover 缺失 → null（不抛错）');
    ok(r.confirm === true, 'confirm 缺失 → null（不抛错）');
    ok(r.Rverify === 'PASS_WITH_WARN', 'verify 结论仍按后端 result 透传', r.Rverify);
    ok(r.groups.join('/') === '硬约束/客户流水条件', '校验分组映射正常', r.groups.join(' / '));
    ok(errors.length === 0, '降级全程无 JS 报错', errors.slice(0, 2).join(' | ') || '0');
    await browser.close(); server.close();
  }

  /* ─────────────────────────────────────────────────────────────
   * C. 真实契约形状：蛇形 metrics + risks、schedule 为**数组**
   *
   * 【为什么必须单独测】上面 A/B 两组的 mock 是驼峰 + schedule:{operations:[]}，
   * 那是本地 engine 的形状，不是 server/app.py 的真实返回。用旧 mock 测，
   * 「风险表整张显示 —」「横幅已排 0/0 道」「准时 0」这三类映射 bug 一个都测不出来。
   * 这一组按 server 真实字段命名，防止回归。
   * ───────────────────────────────────────────────────────────── */
  console.log('\n=== C. 真实后端字段形状（蛇形 + schedule 数组）===');
  {
    const { browser, page, errors, server } = await run(true, {
      realShape: true,
      metrics: {
        orders_total: 14, orders_ok: 13, orders_blocked: 1,
        ops_planned: 65, ops_total: 65, ops_unplanned: 0,
        delayed_count: 4, at_risk_count: 0,
        not_in_horizon_count: 6, unplannable_count: 1, ok_count: 3,
        best_rule: 'FIFO', on_time_pct: 9.1
      },
      risks: [
        { order_id: 'HD-2026-101', type: 'delayed', type_cn: '延期',
          due: '2026-11-10', planned_end: '2026-11-17 16:00', delay_days: 7.6,
          bottleneck_machine: 'GRD-01', bottleneck_op: '磨', qty: 40,
          action: '卡在 GRD-01：启用闲置磨床 / 与客户协商顺延 7.6 天 / 调大 --lot-size' },
        { order_id: 'HD-2026-106', type: 'not_in_horizon', type_cn: '未排入本周',
          due: '2026-11-20', planned_end: '2026-11-11 11:40', delay_days: null,
          bottleneck_machine: 'DRL-01', bottleneck_op: '钻', qty: 25,
          action: '交期在窗口外，建议顺延下一窗口，本周不排' },
        // 新状态：急单·无交期（后端已落地，验证前端能吃下蛇形字段）
        { order_id: 'HD-2026-103', type: 'urgent_no_due', type_cn: '急单·无交期',
          due: null, planned_end: '11-18 10:30', delay_days: null,
          bottleneck_machine: 'GRD-01', bottleneck_op: '磨', qty: 120,
          action: '无硬交期但客户催过；已排 11-18 10:30 完工，需回客户确认具体哪天要' }
      ],
      scheduleArray: true
    });
    const r = await page.evaluate(async () => {
      const out = await window.APSData.runViaServer(new Blob(['x']), {});
      const u = window.APSData.unify(out.mode, out.payload, { fileName: 'x.xlsx', now: new Date().toISOString() });
      const R = u.R;
      const row0 = (R.risk.rows || [])[0] || {};
      return {
        opsPlanned: R.meta.counts.opsPlanned,
        opsTotal: R.meta.counts.opsTotal,
        ruleCn: R.meta.ruleCn,
        t: {
          delayed: R.risk.totals.delayed,
          notInHorizon: R.risk.totals.notInHorizon,
          unplannable: R.risk.totals.unplannable,
          ok: R.risk.totals.ok,
          urgentNoDue: R.risk.totals.urgentNoDue
        },
        row0: {
          orderId: row0.orderId, statusCn: row0.statusCn,
          dueMd: row0.dueMd, plannedEndLabel: row0.plannedEndLabel,
          bottleneckMachine: row0.bottleneckMachine, bottleneckOp: row0.bottleneckOp,
          suggestion: row0.suggestion
        },
        urgentRow: (function () {
          var x = (R.risk.rows || []).filter(function (y) { return y.status === 'urgent_no_due'; })[0];
          return x ? { orderId: x.orderId, statusCn: x.statusCn, suggestion: x.suggestion } : null;
        })()
      };
    });
    ok(r.opsPlanned === 65, 'schedule 是数组时 opsPlanned 仍为 65', r.opsPlanned);
    ok(r.opsTotal === 65, 'opsTotal 取 metrics.ops_total', r.opsTotal);
    ok(r.ruleCn === 'FIFO', '规则名从 metrics.best_rule 补上', r.ruleCn);
    ok(r.t.delayed === 4, '风险合计 延期=4（蛇形 delayed_count）', r.t.delayed);
    ok(r.t.notInHorizon === 6, '风险合计 未排入本周=6', r.t.notInHorizon);
    ok(r.t.unplannable === 1, '风险合计 排不进=1', r.t.unplannable);
    ok(r.t.ok === 3, '风险合计 准时=3（后端 ok_count）', r.t.ok);
    ok(r.t.urgentNoDue === 1, '风险合计 急单·无交期=1（蛇形 urgent_no_due_count）', r.t.urgentNoDue);
    ok(r.urgentRow && r.urgentRow.orderId === 'HD-2026-103', '急单·无交期行能取到', r.urgentRow && r.urgentRow.orderId);
    ok(r.urgentRow && r.urgentRow.statusCn === '急单·无交期', '中文由 type_cn 兜底显示', r.urgentRow && r.urgentRow.statusCn);
    ok(r.urgentRow && /需回客户确认/.test(r.urgentRow.suggestion || ''), '建议动作原样透传（前端不改写）',
      r.urgentRow && (r.urgentRow.suggestion || '').slice(0, 30));
    ok(r.row0.orderId === 'HD-2026-101', '风险行 单号 不为空', r.row0.orderId);
    ok(r.row0.statusCn === '延期', '风险行 类型 不为空', r.row0.statusCn);
    ok(r.row0.plannedEndLabel !== '—' && !!r.row0.plannedEndLabel,
      '风险行 预计完工 不为「—」', r.row0.plannedEndLabel);
    ok(r.row0.bottleneckMachine === 'GRD-01', '风险行 卡在哪台机 不为「—」', r.row0.bottleneckMachine);
    ok(r.row0.bottleneckOp === '磨', '风险行 卡在哪个工序 不为「—」', r.row0.bottleneckOp);
    ok(/GRD-01/.test(r.row0.suggestion || ''), '风险行 建议动作 取到 action', (r.row0.suggestion || '').slice(0, 30));
    ok(errors.length === 0, '真实字段形状下无 JS 报错', errors.slice(0, 2).join(' | ') || '0');
    await browser.close(); server.close();
  }

  console.log('\n结果：' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 后端模式冒烟通过') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
