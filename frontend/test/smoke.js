/**
 * 轻量冒烟：只验本次改动点（产物区 / 新鲜度 / 交接 / 确认 / 失败空态 / 降级）
 * 运行：NODE_PATH=../.devtools/node_modules node test/smoke.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/');
const XLSX = path.resolve(__dirname, '../../data/宏达精密_订单台账.xlsx');
const SHOT = path.resolve(__dirname, '../../screenshots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + l + (e !== undefined ? '  → ' + e : ''));
  if (!c) fails++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('\n=== 1. 本地离线模式生成 ===');
  await page.goto(URL);
  await page.waitForTimeout(400);
  await page.setInputFiles('#fileInput', XLSX);
  await page.waitForSelector('#fileMeta.ok', { timeout: 15000 });
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(600);

  console.log('\n=== 2. F3 新鲜度行 ===');
  ok(!(await page.locator('#freshness').isHidden()), '新鲜度行可见');
  const ft = await page.locator('#freshTime').textContent();
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ft), '显示本次生成时间', ft);
  const fsrc = await page.locator('#freshSource').textContent();
  ok(/订单台账/.test(fsrc), '显示数据源文件名', fsrc);

  console.log('\n=== 3. F3 产物区（PASS_WITH_WARN）===');
  const cards = await page.locator('#artifacts .art-card').count();
  ok(cards === 5, '五件产物齐全', cards);
  const names = await page.locator('#artifacts .ac-name').allTextContents();
  ok(names.includes('交接说明'), '产物含「交接说明」', names.join(' / '));
  ok(await page.locator('#artifacts .art-warnbar').count() === 1, 'PASS_WITH_WARN 黄色提示条存在');
  const warnTxt = await page.locator('#artifacts .art-warnbar').textContent();
  ok(/可打印/.test(warnTxt) && /须向客户说明代价/.test(warnTxt), '黄条文案正确', warnTxt);
  ok(await page.locator('#artifacts.is-ok').count() === 1, '成功态容器');
  ok(!(await page.locator('#btnExport').isDisabled()), '下载未被禁用');
  ok(!(await page.locator('#btnPrint').isDisabled()), '打印未被禁用');
  await page.screenshot({ path: path.join(SHOT, '20-产物区.png'), fullPage: true });

  console.log('\n=== 4. F1 交接说明（本地无后端字段 → 降级「暂无」）===');
  await page.click('.tab[data-tab="handover"]');
  await page.waitForTimeout(300);
  const hoBody = await page.locator('#handoverBody').textContent();
  ok(/暂无交接说明内容/.test(hoBody), '字段缺失时显示「暂无」而不是白屏', hoBody.slice(0, 40));
  ok(await page.locator('#handoverBody .empty').count() === 1, '降级为空态样式');
  ok(errors.length === 0, '降级过程无 JS 报错', errors.slice(0, 2).join(' | ') || '0');

  console.log('\n=== 5. F2 需求确认（同样降级）===');
  await page.click('.tab[data-tab="confirm"]');
  await page.waitForTimeout(300);
  const cfBody = await page.locator('#confirmBody').textContent();
  ok(/暂无需求确认单/.test(cfBody), '字段缺失时显示「暂无」', cfBody.slice(0, 40));
  ok(await page.locator('#caliberNote').isHidden(), 'confirmed 缺失时口径小字默认隐藏');

  console.log('\n=== 6. F3 失败态：产物区必须清空 ===');
  await page.click('#btnBack');
  await page.waitForTimeout(200);
  const txt = path.join(SHOT, '_smoke.txt');
  fs.writeFileSync(txt, 'not excel');
  await page.setInputFiles('#fileInput', txt);
  await page.waitForTimeout(800);
  ok(await page.locator('#uploadError').isHidden() === false, '上传错误条出现');
  // 关键：产物区被清空
  const artHtml = await page.locator('#artifacts').innerHTML();
  ok(!/01_周排程表|ac-btn" href/.test(artHtml) || artHtml === '', '旧下载链接已清除', artHtml.length + ' 字符');
  ok(await page.locator('#btnExport').isDisabled(), '失败后「下载全部」禁用');
  ok(await page.locator('#btnPrint').isDisabled(), '失败后「打印」禁用');
  fs.unlinkSync(txt);
  await page.screenshot({ path: path.join(SHOT, '21-失败态产物区.png'), fullPage: true });

  console.log('\n=== 7. 控制台 ===');
  ok(errors.length === 0, '全程 0 JS 报错', errors.slice(0, 3).join(' | ') || '0 条');

  await browser.close();
  console.log('\n结果：' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 冒烟通过') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
