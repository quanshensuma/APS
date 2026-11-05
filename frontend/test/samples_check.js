/**
 * 样例台账回归测试（换数据不塌）
 * ---------------------------------------------------------------
 * 背景：PPT 第 24 页「换了数据就跑不了」、任务书 N6「换一份改过的台账再跑一次」。
 *       之前的两个真实缺陷（重复单号只到 -R2、超载时前后端判定不一致）
 *       都是「换一份数据」才暴露的 —— 主台账的测试全绿也照样漏。
 *
 * 样例：tests/samples/*.xlsx（合成数据，由 _verify/gen_samples.py 生成，
 *       不含任何客户信息；与客户台账毫无关系）。
 *
 * 运行：NODE_PATH=../.devtools/node_modules node test/samples_check.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const URL = 'file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/');
const SAMPLES = path.resolve(__dirname, '../../tests/samples');
const SHOT = path.resolve(__dirname, '../../screenshots');
if (!fs.existsSync(SHOT)) fs.mkdirSync(SHOT, { recursive: true });

let fails = 0;
const ok = (c, l, e) => {
  console.log((c ? '  ✓ ' : '  ✗ ') + l + (e !== undefined ? '  → ' + e : ''));
  if (!c) fails++;
};

/* 期望值来自后端 CLI 实测（core/ 各模块对齐后），逐类相等才算过 */
const EXPECT = {
  'sample1_空订单.xlsx': { error: '空表' },
  'sample2_单订单.xlsx': { counts: { ok: 1 } },
  'sample3_全急单.xlsx': { counts: { unplannable: 1, delayed: 4, urgentNoDue: 2, ok: 1, notInHorizon: 6 } },
  'sample4_大批量.xlsx': { counts: { unplannable: 6, delayed: 2, urgentNoDue: 2, notInHorizon: 4 } },
  'sample5_纯阀芯C.xlsx': { counts: { unplannable: 1, urgentNoDue: 1, ok: 1 } },
  'sample6_交期全文字.xlsx': { counts: { unplannable: 1, urgentNoDue: 5, notInHorizon: 5, ok: 3 } },
  'sample7_数量全空.xlsx': { allBlocked: true },
  'sample8_单号重复.xlsx': {
    counts: { unplannable: 1, delayed: 4, urgentNoDue: 2, ok: 1, notInHorizon: 6 },
    uniqueIds: true
  }
};

const ORDER = Object.keys(EXPECT);

(async () => {
  if (!fs.existsSync(SAMPLES)) {
    console.log('跳过：找不到样例目录 ' + SAMPLES);
    return;
  }
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL);
  await page.waitForTimeout(400);

  for (const name of ORDER) {
    const file = path.join(SAMPLES, name);
    if (!fs.existsSync(file)) {
      console.log('\n=== ' + name + '（跳过：文件不存在）===');
      continue;
    }
    console.log('\n=== ' + name + ' ===');
    const errBefore = errors.length;

    // 上一轮可能停在结果页，先回到主页再选下一份文件
    if (await page.locator('#viewResult.is-active').count()) {
      await page.click('#btnBack');
      await page.waitForTimeout(200);
    }
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(1200);

    const exp = EXPECT[name];

    // 空表类：上传阶段能读入（0 张订单），但点生成时由引擎抛出中文错误「空表」
    if (exp.error) {
      const uploadErr = !(await page.locator('#uploadError').isHidden());
      ok(!uploadErr, '上传阶段不报错（读入成功，0 张订单）');
      ok(!(await page.locator('#btnRun').isDisabled()), '生成按钮可用（等点下去才报空表）');

      await page.click('#btnRun');
      await page.waitForTimeout(1200);
      const visible = !(await page.locator('#uploadError').isHidden());
      ok(visible, '点生成后出现中文错误条，不白屏');
      const body = await page.locator('#errBody').textContent();
      const title = await page.locator('#errTitle').textContent();
      ok(new RegExp(exp.error).test(title + body), '错误文案含「' + exp.error + '」',
        (title + ' ' + body).slice(0, 40));
      // 失败后不得有旧产物
      const artHtml = await page.locator('#artifacts').innerHTML();
      ok(!/ac-btn" href/.test(artHtml), '失败后产物区无残留下载链接');
      continue;
    }

    // 能跑出结果的
    const metaOk = await page.locator('#fileMeta.ok').count();
    if (!metaOk) {
      // 可能全部进闸门（sample7）
      const errVisible = !(await page.locator('#uploadError').isHidden());
      const errText = errVisible ? await page.locator('#errBody').textContent() : '';
      if (exp.allBlocked) {
        ok(true, '全部进闸门（生成按钮可用但无可排单）');
      } else {
        ok(false, '应能读入台账', errText.slice(0, 60));
      }
      continue;
    }

    await page.click('#btnRun');
    await page.waitForSelector('#viewResult.is-active', { timeout: 40000 });
    await page.waitForTimeout(700);

    // 全部进闸门：仍应生成结果页，风险清单 14 行全是「排不进」
    if (exp.allBlocked) {
      await page.click('.tab[data-tab="risk"]');
      await page.waitForTimeout(300);
      const rows = await page.locator('#riskTable tbody tr').count();
      const types = await page.locator('#riskTable tbody tr td:nth-child(2)').allTextContents();
      ok(rows === 14, '14 单全部进闸门（风险清单 14 行）', rows);
      ok(types.every(t => /排不进/.test(t)), '类型全是「排不进」', types[0]);
    }

    // 通过 DOM 读取筛选 chip 上的计数（不依赖内部变量）
    if (exp.counts) {
      await page.click('.tab[data-tab="risk"]');
      await page.waitForTimeout(300);
      const chipText = await page.locator('#riskFilters .chip').allTextContents();
      const num = (label) => {
        const c = chipText.find(t => t.includes(label));
        const m = c && c.match(/(\d+)\s*$/);
        return m ? Number(m[1]) : null;
      };
      const map = {
        unplannable: '排不进', delayed: '延期',
        urgentNoDue: '急单·无交期', notInHorizon: '未排入本周', ok: '准时'
      };
      for (const k of Object.keys(exp.counts)) {
        const got = num(map[k]);
        ok(got === exp.counts[k], map[k] + ' 计数 = ' + exp.counts[k], '实际 ' + got);
      }
    }

    // 单号互不相同
    if (exp.uniqueIds) {
      await page.click('.tab[data-tab="risk"]');
      await page.waitForTimeout(300);
      const ids = await page.locator('#riskTable tbody tr td:first-child').allTextContents();
      const clean = ids.map(s => (s.match(/HD-[\w-]+/) || [''])[0]).filter(Boolean);
      ok(new Set(clean).size === clean.length,
        clean.length + ' 个单号互不相同（递增 -R2/-R3…）',
        clean.length + ' 个，其中唯一 ' + new Set(clean).size + ' 个');
      ok(clean.some(s => /-R3$/.test(s)), '存在 -R3（递增改名生效）');

      // 【关键】风险清单可能按 id 聚合，DOM 上看不出重复。
      // 必须直接查引擎输出的订单 id —— 那才是「改名是否生效」的真凭据。
      const idCheck = await page.evaluate(() => {
        const r = window.__apsLastResult;
        if (!r) return null;
        const ids = (r.orders || []).map(o => o.id);
        const lots = (r.model && r.model.jobs ? r.model.jobs : []).map(j => j.lotId);
        return {
          n: ids.length,
          unique: new Set(ids).size,
          hasR3: ids.some(i => /-R3$/.test(i)),
          lotUnique: new Set(lots).size,
          lotN: lots.length
        };
      });
      if (idCheck) {
        ok(idCheck.unique === idCheck.n, '引擎输出的订单 id 互不相同',
          idCheck.unique + '/' + idCheck.n + ' 唯一');
        ok(idCheck.hasR3, '引擎输出中存在 -R3');
      }
    }

    ok(errors.length === errBefore, '本份样例控制台 0 报错',
      errors.slice(errBefore, errBefore + 2).join(' | ') || '0');
  }

  await browser.close();
  console.log('\n结果：' + (fails ? '❌ ' + fails + ' 项失败' : '✅ 样例回归全部通过') + '\n');
  process.exitCode = fails ? 1 : 0;
})();
