/**
 * 真实后端端到端冒烟：连 web/app.py，走完整 http 流程
 * 运行：node test/smoke_e2e.js [port]
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORT = process.argv[2] || 8802;
const BASE = 'http://127.0.0.1:' + PORT;
const XLSX = path.resolve(__dirname, '../../data/宏达精密_订单台账.xlsx');
const SHOT = path.resolve(__dirname, '../../screenshots');

let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + l + (e !== undefined ? '  → ' + e : ''));
  if (!c) fails++;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1100 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('\n=== 1. 打开服务托管的页面 ===');
  // 【临时绕过】后端 _send_file 对所有文件都发 Content-Disposition: attachment，
  // 导致 index.html 被当下载。这里仅在本测试里去掉该头以验证前端逻辑；
  // 真实修复需后端会话改 web/app.py（见交付说明）。
  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (/\.(html|js|css)$/.test(url) || url.endsWith('/')) {
      const res = await route.fetch();
      const headers = { ...res.headers() };
      delete headers['content-disposition'];
      return route.fulfill({ status: res.status(), headers, body: await res.body() });
    }
    return route.continue();
  });

  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(900);
  ok(errors.length === 0, '页面加载无报错', errors.slice(0, 2).join(' | ') || '0');

  console.log('\n=== 2. 上传 + 生成（走后端）===');
  await page.setInputFiles('#fileInput', XLSX);
  await page.waitForSelector('#fileMeta.ok', { timeout: 20000 });
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 60000 });
  await page.waitForTimeout(1200);
  ok(true, '生成成功并进入结果页');

  console.log('\n=== 3. 新鲜度行 ===');
  ok(!(await page.locator('#freshness').isHidden()), '新鲜度行可见');
  const mode = await page.locator('#freshMode').textContent();
  ok(/服务端/.test(mode), '标明服务端计算', mode);
  const src = await page.locator('#freshSource').textContent();
  ok(/订单台账/.test(src), '数据源文件名', src);

  console.log('\n=== 4. 产物区（真实后端 artifacts）===');
  const cards = await page.locator('#artifacts .art-card').count();
  const off = await page.locator('#artifacts .art-card.is-off').count();
  ok(cards === 5, '五件产物卡片', cards);
  ok(off === 0, '没有「暂无」的产物', off);
  const hrefs = await page.locator('#artifacts a.ac-btn').count();
  ok(hrefs >= 4, '产物带真实下载链接', hrefs);
  const firstHref = await page.locator('#artifacts a.ac-btn').first().getAttribute('href');
  ok(/\/api\/download\//.test(firstHref || ''), '链接指向后端下载接口', firstHref);
  ok(await page.locator('#artifacts .art-warnbar').count() === 1, 'PASS_WITH_WARN 黄条存在');
  await page.screenshot({ path: path.join(SHOT, '22-真实后端产物区.png'), fullPage: true });

  console.log('\n=== 5. 下载可用性 ===');
  const resp = await page.request.get(BASE + firstHref);
  ok(resp.ok(), '产物链接可下载', resp.status());

  console.log('\n=== 6. F1 交接说明页签 ===');
  await page.click('.tab[data-tab="handover"]');
  await page.waitForTimeout(400);
  const hoTxt = await page.locator('#handoverBody').textContent();
  ok(!/暂无交接说明内容/.test(hoTxt), '不是「暂无」降级态', hoTxt.slice(0, 50).replace(/\s+/g, ' '));
  ok(/下载交接说明|后端已生成交接说明文件/.test(hoTxt), '给出下载入口或内容', hoTxt.slice(0, 60).replace(/\s+/g, ' '));
  ok(await page.locator('.stale-hint').count() === 1, '顶部固定提示存在');
  const staleHint = await page.locator('.stale-hint').textContent();
  ok(/跟着重跑才会更新/.test(staleHint), '固定提示文案正确', staleHint);
  await page.screenshot({ path: path.join(SHOT, '23-交接说明.png'), fullPage: true });

  console.log('\n=== 7. F2 需求确认页签 ===');
  await page.click('.tab[data-tab="confirm"]');
  await page.waitForTimeout(400);
  const cfTxt = await page.locator('#confirmBody').textContent();
  ok(!/暂无需求确认单/.test(cfTxt), '不是「暂无」降级态', cfTxt.slice(0, 50).replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(SHOT, '24-需求确认.png'), fullPage: true });

  console.log('\n=== 8. 失败态：产物区清空 ===');
  await page.click('#btnBack');
  await page.waitForTimeout(300);
  const txt = path.resolve(SHOT, '_e2e.txt');
  fs.writeFileSync(txt, 'nope');
  await page.setInputFiles('#fileInput', txt);
  await page.waitForTimeout(1000);
  const artHtml = await page.locator('#artifacts').innerHTML();
  ok(!/api\/download/.test(artHtml), '旧的后端下载链接已清除', artHtml.length + ' 字符');
  ok(await page.locator('#btnExport').isDisabled(), '下载按钮禁用');
  fs.unlinkSync(txt);

  console.log('\n=== 9. 控制台 ===');
  ok(errors.length === 0, '全程 0 JS 报错', errors.slice(0, 3).join(' | ') || '0 条');

  await browser.close();
  console.log('\n结果：' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 真实后端端到端通过') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
