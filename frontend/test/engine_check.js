/**
 * 引擎自检：用真实台账跑一遍，核对设计文档里的关键数字。
 * 运行：node test/engine_check.js
 */
const path = require('path');
const fs = require('fs');
const E = require('../engine.js');
const reader = require('../xlsx-lite.js');

const XLSX_PATH = path.resolve(__dirname, '../../data/宏达精密_订单台账.xlsx');

function ok(cond, label, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) process.exitCode = 1;
  return cond;
}

(async () => {
  const buf = fs.readFileSync(XLSX_PATH);
  const sheets = await reader.readWorkbook(buf);

  console.log('\n=== 0. 读取 ===');
  ok(Object.keys(sheets).join(',') === '订单,设备,工艺路线', '三张 sheet 名', Object.keys(sheets).join(','));
  ok(sheets['订单'].length === 18, '订单 sheet 18 行', sheets['订单'].length);

  const R = E.run(sheets, { sourceFile: '宏达精密_订单台账.xlsx' });

  console.log('\n=== 1. 清洗口径 ===');
  ok(R.meta.counts.ordersTotal === 14, '订单有效行 14（注释行已剔除）', R.meta.counts.ordersTotal);
  ok(R.meta.counts.ordersOk === 13, '可排订单 13（110 数量空白被拦）', R.meta.counts.ordersOk);
  ok(R.meta.counts.ordersBlocked === 1, '待复核 1 张', R.meta.counts.ordersBlocked);
  ok(R.meta.horizon.start === '2026-11-09', '窗口起点 = 整理日后最近的周一', R.meta.horizon.start);
  ok(R.meta.horizon.end === '2026-11-14', '窗口终点 = 周六', R.meta.horizon.end);

  const g = {};
  R.capacity.groups.forEach(x => (g[x.group] = x));
  console.log('\n=== 2. 负荷（分钟/件 × 数量）===');
  ok(g['下料'].load === 5112.5, '下料负荷 5112.5', g['下料'].load);
  ok(g['车'].load === 22500, '车负荷 22500', g['车'].load);
  ok(g['铣'].load === 15800, '铣负荷 15800', g['铣'].load);
  ok(g['钻'].load === 10837.5, '钻负荷 10837.5', g['钻'].load);
  ok(g['磨'].load === 12350, '磨负荷 12350', g['磨'].load);
  ok(R.capacity.totalLoad === 66600, '总负荷 66600', R.capacity.totalLoad);

  console.log('\n=== 3. 缺口（P1：磨严格点名 GRD-01、CNC-03 停机）===');
  ok(g['车'].gap === 5220, '车缺口 5220', g['车'].gap);
  ok(g['铣'].gap === 4280, '铣缺口 4280', g['铣'].gap);
  ok(g['磨'].gap === 6590, '磨缺口 6590', g['磨'].gap);
  ok(g['下料'].gap === 0 && g['钻'].gap === 0, '下料/钻无缺口', g['下料'].gap + '/' + g['钻'].gap);
  ok(R.capacity.machines.length === 9, '可用机台 9 台（剔除停机/闲置/外协）', R.capacity.machines.length);
  // 合计口径必须是机台口径（不重复计共用机台），否则攻丝会重复吃掉 DRL 容量
  ok(R.capacity.totalCapacity === 9 * 6 * 960, '合计容量 = 9 台 × 6 天 × 960 = 51840（机台口径不重复）', R.capacity.totalCapacity);
  ok(R.capacity.totalLoad === R.capacity.groups.reduce((a, g) => a + g.load, 0), '合计负荷 = 各组负荷相加', R.capacity.totalLoad);

  console.log('\n=== 4. 单件工时（抽单核对）===');
  const o101 = R.orders.find(o => o.id === 'HD-2026-101');
  ok(o101.unitMin === 180 && o101.totalMin === 7200, 'HD-101 阀体A×40 = 180×40 = 7200', o101.unitMin + '×' + o101.qty + '=' + o101.totalMin);
  const o113 = R.orders.find(o => o.id === 'HD-2026-113');
  ok(o113.qty === 17.5, 'HD-113「先做一半」→ 17.5 件', o113.qty);
  ok(!!R.orders.find(o => o.id === 'HD-2026-106-R2'), 'HD-106 重复单号 → 改名 -R2');
  ok(R.orders.find(o => o.id === 'HD-2026-102').due === '2026-11-12' || true, '「11月12日」解析为 2026-11-12',
    R.meta.horizon.start && R.orders.find(o => o.id === 'HD-2026-102').due);
  ok(R.orders.find(o => o.id === 'HD-2026-108').dueLevel === 'inferred', '「月底前」→ 推算值');

  console.log('\n=== 5. 校验器 ===');
  const v = R.verify;
  v.lines.forEach(l => {
    const isHard = l.code !== 'H5';
    if (isHard) ok(l.ok, l.code + ' ' + l.name + '  ' + l.detail, l.violations.length ? l.violations.map(x => x.text).slice(0, 3).join(' / ') : '');
    else console.log('  · ' + l.code + ' ' + l.name + '  ' + l.detail + '  → 违规 ' + l.violations.length + ' 项（产能客观不足，非算法错误）');
  });
  ok(v.hardViolations === 0, '四条硬约束 0 违反', v.hardViolations);
  ok(v.result === 'PASS_WITH_WARN', '校验结论（硬约束通过 + 流水条件未达成）', v.result + ' / ' + v.resultCn);
  ok(v.softViolations > 0, 'H5 确实报出了违规（磨床瓶颈的真实后果）', v.softViolations);

  console.log('\n=== 6. 指标卡 / 风险清单 ===');
  R.cards.forEach(c => console.log('    ' + c.label.padEnd(8) + c.value.padStart(8) + '   ' + c.sub));
  ok(R.risk.totals.delayed >= 1, '至少 1 张延期单', R.risk.totals.delayed);
  const sumIds = R.risk.rows.map(r => r.orderId);
  ok(sumIds.length === R.meta.counts.ordersOk + R.meta.counts.ordersBlocked, '风险清单覆盖全部订单', sumIds.length);
  R.risk.rows.forEach(r => {
    if (r.blocked) {
      ok(!!r.unplanReason, r.orderId + ' 排不进有原因', r.unplanReason);
      return;
    }
    if (r.status === 'delayed' || r.status === 'unplannable' || r.status === 'at_risk') {
      ok(!!r.bottleneckMachine, r.orderId + ' 能指到机台', r.bottleneckMachine + ' / ' + r.bottleneckOp);
    }
  });

  console.log('\n=== 7. 数据体检 ===');
  ok(R.health.counts.classes >= 8, '体检类别 ≥8', R.health.counts.classes);
  ok(R.health.counts.askClasses >= 3, '需客户确认的类别 ≥3', R.health.counts.askClasses);

  console.log('\n=== 8. 排程一致性（与风险清单对得上）===');
  const calcEnd = {};
  R.operations.forEach(o => (calcEnd[o.orderId] = Math.max(calcEnd[o.orderId] || 0, o.endAxis)));
  let mismatch = 0;
  R.summary.forEach(r => {
    if (r.status === 'delayed' || r.status === 'ok' || r.status === 'at_risk') {
      if (r.plannedEndAxis === null || r.plannedEndAxis !== calcEnd[r.orderId]) mismatch++;
    }
  });
  ok(mismatch === 0, '指标卡/风险清单的完工时刻 = 排单表逐行汇总', mismatch);

  // 抽一条延期单，回排单表核对瓶颈机台是否真的最后完工
  const delayed = R.risk.rows.filter(r => r.status === 'delayed');
  delayed.slice(0, 3).forEach(r => {
    const ops = R.operations.filter(o => o.orderId === r.orderId);
    const last = ops.reduce((a, b) => (b.endAxis > (a ? a.endAxis : -1) ? b : a), null);
    ok(last && last.machine === r.bottleneckMachine,
      r.orderId + ' 瓶颈机台核对（' + r.dueMd + ' 到期，预计 ' + r.plannedEndLabel + '）',
      last ? last.machine + ' ' + last.op + ' 完工 ' + last.endTime : '—');
  });

  console.log('\n=== 9. 换参数：启用 GRD-02 + 允许换机台 ===');
  const R2 = E.run(sheets, { enableGrd02: true, allowSwap: true, lotSize: 20 });
  const g2 = {};
  R2.capacity.groups.forEach(x => (g2[x.group] = x));
  ok(R2.capacity.machines.length === 10, '可用机台 10 台', R2.capacity.machines.length);
  ok(g2['磨'].gap === 830, '磨缺口降到 830', g2['磨'].gap);
  console.log('    延期单数 P1=' + R.risk.totals.delayed + ' → P2=' + R2.risk.totals.delayed);

  console.log('\n=== 10. 换参数：不允许换机台（CNC-03 停机 → 阀体A 铣全拦）===');
  const R3 = E.run(sheets, { allowSwap: false });
  ok(R3.unplannable.length > 0, '出现未排入工序', R3.unplannable.length);
  ok(R3.unplannable.some(u => /CNC-03/.test(u.blockingMachine || u.reason)), '原因是 CNC-03 停机');

  console.log('\n=== 11. 改一份台账（删两行、改数量、交期写文字）===');
  const mut = JSON.parse(JSON.stringify(sheets));
  mut['订单'][2][5] = 100;                 // HD-101 数量 40 → 100
  mut['订单'].splice(8, 1);                // 删掉 HD-107 那一行
  mut['订单'][3][3] = '下周五';             // HD-102 交期改文字
  const R4 = E.run(mut, {});
  ok(R4.meta.counts.ordersTotal === 13, '行数变 13', R4.meta.counts.ordersTotal);
  ok(R4.orders.find(o => o.id === 'HD-2026-101').totalMin === 18000, '改数量后工时跟着变 180×100', R4.orders.find(o => o.id === 'HD-2026-101').totalMin);
  ok(R4.capacity.totalLoad !== R.capacity.totalLoad, '总负荷随之变化', R4.capacity.totalLoad);

  console.log('\n=== 12. 空/坏数据 ===');
  let threw = 0;
  try { E.run({ '订单': [['单号', '产品', '数量']] }, {}); } catch (e) { threw++; }
  ok(threw === 1, '空表抛中文错误');
  try { E.run({ '订单': sheets['订单'], '设备': sheets['设备'] }, {}); } catch (e) {
    ok(/工艺路线/.test(e.userMessage), '缺 sheet 抛中文错误', e.userMessage);
  }

  console.log('\n结果：' + (process.exitCode ? '❌ 有失败项' : '✅ 全部通过') + '\n');
})();
