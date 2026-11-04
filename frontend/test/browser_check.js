/**
 * 浏览器端全流程实测（Playwright）
 * 覆盖：空态 → 选文件 → 生成 → 五个页签 → 悬停/点击交互 → 换参数 → 错误文件
 * 运行：node test/browser_check.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/');
const XLSX = path.resolve(__dirname, '../../data/宏达精密_订单台账.xlsx');
const SHOT = path.resolve(__dirname, '../../screenshots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

let fails = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) fails++;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: 1.5 });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('\n=== A. 打开页面（空态）===');
  await page.goto(URL);
  await page.waitForTimeout(400);
  ok(await page.locator('#btnRun').isDisabled(), '未选文件时「开始排程」是禁用的');
  ok(await page.locator('#optStart').isDisabled(), '未选文件时起始日禁用');
  ok((await page.locator('#statusText').textContent()).includes('请先选择'), '空态文案', await page.locator('#statusText').textContent());
  ok(await page.locator('#uploadError').isHidden(), '没有残留错误条');
  await page.screenshot({ path: path.join(SHOT, '01-空态.png'), fullPage: true });

  console.log('\n=== B. 选择台账 ===');
  await page.setInputFiles('#fileInput', XLSX);
  await page.waitForSelector('#fileMeta.ok', { timeout: 15000 });
  const meta = await page.locator('#fileMeta').textContent();
  ok(/14 张订单/.test(meta), '解析出 14 张订单', meta);
  ok(/12 台设备/.test(meta), '解析出 12 台设备', meta);
  ok(/5 个产品工艺/.test(meta), '解析出 5 个产品工艺', meta);
  ok(!(await page.locator('#btnRun').isDisabled()), '「开始排程」已可用');
  ok((await page.locator('#optStart').inputValue()) === '2026-11-09', '自动算出起点 2026-11-09', await page.locator('#optStart').inputValue());
  await page.screenshot({ path: path.join(SHOT, '02-已选文件.png'), fullPage: true });

  console.log('\n=== C. 生成 ===');
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(600);
  const banner = await page.locator('#verifyBanner').textContent();
  ok(/0 违反/.test(banner), '校验横幅显示 0 违反', banner.slice(0, 90).replace(/\s+/g, ' '));
  const cardCount = await page.locator('.card-metric').count();
  ok(cardCount === 6, '六张指标卡', cardCount);
  const cardTexts = await page.locator('.card-metric .cm-value').allTextContents();
  ok(cardTexts[0] === '14', '订单总数 14', cardTexts.join(' / '));
  ok(cardTexts[1] === '13', '可排订单 13', cardTexts[1]);

  console.log('\n=== D. 甘特图 ===');
  const bars = await page.locator('#gantt .bar').count();
  ok(bars > 50, '甘特图色块数 = 已排工序数', bars);
  const rows = await page.locator('#gantt .gantt-row:not(.gantt-headrow)').count();
  ok(rows === 9, '纵轴 9 台可用机', rows);
  const bottle = await page.locator('#gantt .gantt-mach.is-bottle').count();
  ok(bottle >= 1, '瓶颈机台有红边标记', bottle);
  await page.locator('#gantt .bar').first().hover();
  await page.waitForTimeout(300);
  const tip = await page.locator('.gantt-tip').textContent();
  ok(tip.length > 8 && /min/.test(tip), '色块悬停显示单号/工序/起止', tip.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(SHOT, '03-甘特图.png'), fullPage: true });

  console.log('\n=== E. 排单表 ===');
  await page.click('.tab[data-tab="orders"]');
  await page.waitForTimeout(300);
  const orderRows = await page.locator('#ordersTable tbody tr').count();
  ok(orderRows > 50, '排单表行数', orderRows);
  const headers = await page.locator('#ordersTable thead th').allTextContents();
  const needCols = ['日期', '班次', '机台', '单号', '工序', '数量', '开工', '工时'];
  needCols.forEach(c => ok(headers.some(h => h.includes(c)), '列名含「' + c + '」'));
  await page.screenshot({ path: path.join(SHOT, '04-排单表.png'), fullPage: true });

  console.log('\n=== F. 风险清单 + 回查交互 ===');
  await page.click('.tab[data-tab="risk"]');
  await page.waitForTimeout(300);
  const chips = await page.locator('#riskFilters .chip').count();
  ok(chips === 7, '七类筛选（新增「急单·无交期」）', chips);
  const delayedChip = await page.locator('#riskFilters .chip[data-filter="delayed"]').textContent();
  ok(/4/.test(delayedChip), '延期 4 张', delayedChip.replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(SHOT, '05-风险清单.png'), fullPage: true });

  /* ── F1. 「急单·无交期」状态（后端 urgent_no_due 的前端呈现） ──
     【为什么必测】HD-2026-103（客户催）与 HD-2026-105（尽快）原本被误判为「准时」，
     客户最催的单显示绿色「准时」会让计划员直接回客户「没问题」。
     这条是 PPT 第 9 页「回客户电话」的核心价值，必须有自动化守护。 */
  console.log('\n=== F1. 急单·无交期（urgent_no_due）===');
  const chipTexts = await page.locator('#riskFilters .chip').allTextContents();
  const urgentIdx = chipTexts.findIndex(c => /急单·无交期/.test(c));
  const warnIdx = chipTexts.findIndex(c => /预警/.test(c));
  const nihIdx = chipTexts.findIndex(c => /未排入本周/.test(c));
  ok(urgentIdx > -1, '存在「急单·无交期」筛选 chip', urgentIdx);
  ok(urgentIdx > warnIdx && urgentIdx < nihIdx,
    'chip 位置在「预警」之后、「未排入本周」之前',
    '预警#' + warnIdx + ' 急单#' + urgentIdx + ' 未排入#' + nihIdx);
  ok(/🟠/.test(chipTexts[urgentIdx] || ''), '用橙色标识（非红色）', chipTexts[urgentIdx]);
  ok(/2/.test(chipTexts[urgentIdx] || ''), 'chip 计数为 2', chipTexts[urgentIdx]);

  const riskRowTotal = await page.locator('#riskTable tbody tr').count();
  ok(riskRowTotal === 14, '风险清单共 14 行', riskRowTotal);

  await page.click('#riskFilters .chip[data-filter="urgent_no_due"]');
  await page.waitForTimeout(350);
  const urgentRows = await page.locator('#riskTable tbody tr').count();
  ok(urgentRows === 2, '筛选后恰好 2 行', urgentRows);
  const urgentIds = (await page.locator('#riskTable tbody tr td:first-child').allTextContents()).join(' ');
  ok(/HD-2026-103/.test(urgentIds), '含 HD-2026-103（客户催，越早越好）', urgentIds.trim());
  ok(/HD-2026-105/.test(urgentIds), '含 HD-2026-105（尽快）', urgentIds.trim());
  const urgentTypes = await page.locator('#riskTable tbody tr td:nth-child(2)').allTextContents();
  ok(urgentTypes.every(t => /急单·无交期/.test(t)), '类型列显示中文', urgentTypes.join(' / '));
  ok(!urgentTypes.some(t => /urgent_no_due/.test(t)), '不把英文状态码暴露给用户');

  // 配色必须是橙色系，不能和「延期」的红混为一谈
  const pillBg = await page.locator('#riskTable tbody tr .pill.urgent_no_due').first()
    .evaluate(el => getComputedStyle(el).backgroundColor).catch(() => '');
  const redPillBg = await page.evaluate(() => {
    const d = document.createElement('span'); d.className = 'pill delayed';
    document.body.appendChild(d);
    const c = getComputedStyle(d).backgroundColor; d.remove(); return c;
  });
  ok(pillBg && pillBg !== redPillBg, '配色不是延期红', 'urgent=' + pillBg + ' / delayed=' + redPillBg);

  // 建议动作必须带实际完工日 + 「需回客户确认」，且不得编造交期
  const urgentSugg = (await page.locator('#riskTable tbody tr td.risk-suggestion').allTextContents()).join(' ');
  ok(/需回客户确认/.test(urgentSugg), '建议动作写明「需回客户确认」', urgentSugg.slice(0, 60).replace(/\s+/g, ' '));
  ok(/\d{2}-\d{2}\s+\d{2}:\d{2}/.test(urgentSugg), '给出实际完工日期时间', (urgentSugg.match(/\d{2}-\d{2}\s+\d{2}:\d{2}/) || [''])[0]);
  await page.screenshot({ path: path.join(SHOT, '13-急单无交期.png'), fullPage: true });

  /* ── F2. 建议动作文案与机台产能是否对得上 ──
     【为什么必测】曾有 bug：HD-2026-107 卡在 DRL-01（钻组利用率 94%，无缺口），
     却给「启用闲置机台」的建议 —— 指错了原因，等于给计划员错误信息。 */
  console.log('\n=== F2. 建议动作与机台产能一致性 ===');
  await page.click('#riskFilters .chip[data-filter="all"]');
  await page.waitForTimeout(350);
  const allSugg = await page.locator('#riskTable tbody tr td.risk-suggestion').allTextContents();
  const drlSugg = allSugg.filter(s => /DRL/.test(s));
  ok(drlSugg.some(s => /产能够/.test(s)), '卡 DRL 的行写明「本组产能够」', (drlSugg[0] || '').slice(0, 50));
  ok(!drlSugg.some(s => /启用闲置机台/.test(s)), '卡 DRL 的行不再误报「启用闲置机台」');
  const grdSugg = allSugg.filter(s => /GRD-01/.test(s));
  ok(grdSugg.some(s => /启用闲置机台/.test(s)), '卡 GRD-01（有缺口）仍提示「启用闲置机台」', (grdSugg[0] || '').slice(0, 40));
  ok(allSugg.every(s => s.trim().length > 0), '没有空白建议动作');

  // 长文案不能被裁切或撑破表格
  const tblFit = await page.locator('#riskTable table').first().evaluate(el => {
    const wrap = el.closest('.table-wrap') || el.parentElement || el;
    return { sw: wrap.scrollWidth, cw: wrap.clientWidth };
  });
  ok(tblFit.sw <= tblFit.cw + 2, '表格无横向溢出', 'scrollW=' + tblFit.sw + ' clientW=' + tblFit.cw);
  const clip = await page.locator('#riskTable tbody tr td.risk-suggestion').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { h: el.scrollHeight, ch: el.clientHeight, ov: cs.overflow };
  });
  ok(clip.ov === 'visible' || clip.h <= clip.ch + 2, '长文案未被裁切',
    'scrollH=' + clip.h + ' clientH=' + clip.ch);
  await page.screenshot({ path: path.join(SHOT, '14-建议动作长文案.png'), fullPage: true });

  // 点第一条延期行 → 应跳到排单表并高亮
  const firstRow = page.locator('#riskTable tbody tr').first();
  const orderId = await firstRow.getAttribute('data-order');
  await firstRow.click();
  await page.waitForTimeout(500);
  ok(await page.locator('.panel[data-panel="orders"].is-active').count() === 1, '点风险行跳到排单表');
  const hit = await page.locator('#ordersTable tr.is-hit').count();
  ok(hit >= 1, '排单表里该单被高亮（' + orderId + '）', hit + ' 行');
  await page.screenshot({ path: path.join(SHOT, '06-风险跳转排单.png'), fullPage: true });

  console.log('\n=== F3. 校验页签：分组展示 ===');
  await page.click('.tab[data-tab="verify"]');
  await page.waitForTimeout(300);
  const vgroups = await page.locator('#verifyBody .hgroup').count();
  ok(vgroups === 2, '校验区恰好两个分组', vgroups);
  const vheads = await page.locator('#verifyBody .hgroup h4').allTextContents();
  ok(vheads[0] === '硬约束', '第一组 = 硬约束', vheads.join(' / '));
  ok(vheads[1] === '客户流水条件', '第二组 = 客户流水条件', vheads[1]);
  const grpCodes = await page.locator('#verifyBody .hgroup').evaluateAll(els =>
    els.map(e => Array.from(e.querySelectorAll('.hitem-loc')).map(x => x.textContent.trim())));
  ok(grpCodes[0].slice(0, 4).join(',') === 'H1,H2,H3,H4', '硬约束组列出 H1~H4', grpCodes[0].slice(0, 4).join(','));
  ok(grpCodes[1].some(c => c.startsWith('H5')), '流水条件组列出 H5', grpCodes[1][0]);
  const flowNote = await page.locator('#verifyBody .verify-note').textContent();
  ok(/磨床是瓶颈，产能客观不足导致断档/.test(flowNote), 'H5 分组下有固定说明', flowNote.slice(0, 30) + '…');
  ok(/硬约束 0 违反，这份排程可以交/.test(flowNote), '固定说明含「可以交」口径');
  ok(/必须写进交接说明并告知客户代价/.test(flowNote), '固定说明含交接要求');
  const firstGrpNote = await page.locator('#verifyBody .hgroup').first().locator('.verify-note').count();
  ok(firstGrpNote === 0, '硬约束分组下不加这句说明（只加在 H5 组）', firstGrpNote);

  console.log('\n=== F4. H5 未达成不得拦截 ===');
  ok(!(await page.locator('#btnExport').isDisabled()), 'H5 未达成时「下载全部」仍可点');
  ok(!(await page.locator('#btnPrint').isDisabled()), 'H5 未达成时「打印」仍可点');
  ok(await page.locator('#verifyBanner.warn').count() === 1, '顶部横幅是 warn（不是 fail）');
  ok(await page.locator('#verifyBanner.fail').count() === 0, '顶部横幅没有 fail 样式');
  const verifyBadge = await page.locator('#tabBadgeVerify').textContent();
  ok(verifyBadge === '0', '校验页签徽标显示硬约束违规数 0', verifyBadge);
  await page.screenshot({ path: path.join(SHOT, '05b-校验分组.png'), fullPage: true });

  console.log('\n=== G. 数据体检 ===');
  await page.click('.tab[data-tab="health"]');
  await page.waitForTimeout(300);
  const hgroups = await page.locator('.hgroup').count();
  ok(hgroups >= 8, '体检类别 ≥8', hgroups);
  const ask = await page.locator('.hgroup-head .askflag').count();
  ok(ask >= 3, '标「需客户确认」的类别 ≥3', ask);
  await page.screenshot({ path: path.join(SHOT, '07-数据体检.png'), fullPage: true });

  console.log('\n=== H. 产能核对 ===');
  await page.click('.tab[data-tab="capacity"]');
  await page.waitForTimeout(300);
  const capText = await page.locator('#capacityBody').textContent();
  ok(/6590/.test(capText), '磨缺口 6590 出现在页面上');
  ok(/12350/.test(capText), '磨负荷 12350 出现在页面上');
  await page.screenshot({ path: path.join(SHOT, '08-产能核对.png'), fullPage: true });

  console.log('\n=== I. 换参数：启用 GRD-02 ===');
  await page.click('#btnBack');
  await page.waitForTimeout(300);
  await page.click('.seg[data-name="enableGrd02"] button[data-val="1"]');
  const paramline = await page.locator('#paramline').textContent();
  ok(/GRD02=on/.test(paramline), '参数行实时更新', paramline.slice(0, 80));
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(500);
  const machRow2 = await page.locator('#gantt .gantt-row:not(.gantt-headrow)').count();
  ok(machRow2 === 10, '启用后机台 10 台', machRow2);
  await page.click('.tab[data-tab="capacity"]');
  await page.waitForTimeout(300);
  const cap2 = await page.locator('#capacityBody').textContent();
  ok(/830/.test(cap2), '磨缺口降到 830', (cap2.match(/830/g) || []).length + ' 次出现');
  await page.screenshot({ path: path.join(SHOT, '09-启用GRD02.png'), fullPage: true });

  console.log('\n=== J. 换参数：不允许换机台（CNC-03 停机 → 阀体A 铣全拦）===');
  await page.click('#btnBack');
  await page.waitForTimeout(200);
  await page.click('.seg[data-name="enableGrd02"] button[data-val="0"]');
  await page.click('.seg[data-name="allowSwap"] button[data-val="0"]');
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(500);
  const banner3 = await page.locator('#verifyBanner').textContent();
  ok(/未排入|排不进/.test(banner3), '出现未排入提示', banner3.slice(0, 100).replace(/\s+/g, ' '));
  await page.screenshot({ path: path.join(SHOT, '10-不许换机台.png'), fullPage: true });

  console.log('\n=== K. 错误态：传 .txt ===');
  await page.click('#btnBack');
  await page.waitForTimeout(200);
  const txt = path.join(SHOT, '_tmp.txt');
  fs.writeFileSync(txt, '这不是 excel');
  await page.setInputFiles('#fileInput', txt);
  await page.waitForTimeout(700);
  ok(!(await page.locator('#uploadError').isHidden()), '错误条出现');
  const errTitle = await page.locator('#errTitle').textContent();
  ok(/xlsx/i.test(errTitle), '错误标题点明要 .xlsx', errTitle);
  ok(await page.locator('#btnRun').isDisabled(), '错误后生成按钮禁用');
  await page.screenshot({ path: path.join(SHOT, '11-错误态-非xlsx.png'), fullPage: true });
  fs.unlinkSync(txt);

  console.log('\n=== L. 错误态：缺 sheet 的 xlsx ===');
  // 用 Node 造一个只有「订单」的工作簿（直接构造最小 zip）
  const badXlsx = path.join(SHOT, '_bad.xlsx');
  await makeBadXlsx(badXlsx);
  await page.setInputFiles('#fileInput', badXlsx);
  await page.waitForTimeout(900);
  const errBody2 = await page.locator('#errBody').textContent();
  ok(/设备/.test(errBody2) && /工艺路线/.test(errBody2), '提示缺哪个 sheet', errBody2.replace(/\s+/g, ' ').slice(0, 110));
  await page.screenshot({ path: path.join(SHOT, '12-错误态-缺sheet.png'), fullPage: true });
  fs.unlinkSync(badXlsx);

  console.log('\n=== M. 恢复：重新选对文件仍能跑 ===');
  await page.setInputFiles('#fileInput', XLSX);
  await page.waitForSelector('#fileMeta.ok', { timeout: 15000 });
  ok(await page.locator('#uploadError').isHidden(), '换对文件后错误条自动消失');
  await page.click('.seg[data-name="allowSwap"] button[data-val="1"]');
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(500);
  ok(await page.locator('.card-metric').count() === 6, '刷新后重新生成仍正常');

  console.log('\n=== N. 控制台错误 ===');
  ok(errors.length === 0, '无 JS 报错', errors.slice(0, 3).join(' | ') || '0 条');

  console.log('\n=== O. 关掉流水约束后：校验区不应出现 H5 说明 ===');
  await page.click('#btnBack');
  await page.waitForTimeout(200);
  await page.click('.seg[data-name="flowOn"] button[data-val="0"]');
  await page.click('#btnRun');
  await page.waitForSelector('#viewResult.is-active', { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.click('.tab[data-tab="verify"]');
  await page.waitForTimeout(300);
  ok(await page.locator('#verifyBody .verify-note').count() === 0, '流水约束关闭时没有 H5 说明条');
  ok(await page.locator('#verifyBanner.pass').count() === 1, '流水约束关闭后横幅转为 pass');
  const vBadge2 = await page.locator('#tabBadgeVerify').textContent();
  ok(vBadge2 === '0', '硬约束违规数仍为 0', vBadge2);

  await browser.close();
  console.log('\n结果：' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 全部通过') + '\n');
  process.exitCode = fails ? 1 : 0;
})();

/** 造一个只有「订单」sheet 的最小 xlsx（手写最小 zip，stored 方式） */
async function makeBadXlsx(out) {
  const zlib = require('zlib');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="订单" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>单号</t></is></c><c r="B1" t="inlineStr"><is><t>产品</t></is></c><c r="C1" t="inlineStr"><is><t>数量</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>HD-1</t></is></c><c r="B2" t="inlineStr"><is><t>阀体A</t></is></c><c r="C2"><v>10</v></c></row></sheetData></worksheet>'
  };
  const bufs = [];
  const central = [];
  let offset = 0;
  Object.keys(files).forEach(name => {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(files[name], 'utf8');
    const comp = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));
    bufs.push(local, nameBuf, comp);
    offset += 30 + nameBuf.length + comp.length;
  });
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(out, Buffer.concat([...bufs, cd, eocd]));
}
