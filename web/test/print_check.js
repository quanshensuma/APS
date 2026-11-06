const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/** 台账可能在本仓库 data/，也可能在客户包 文件/；按序探测，避免写死单一路径 */
function findLedger() {
  const cands = [
    path.resolve(__dirname, '../../data/宏达精密_订单台账.xlsx'),
    path.resolve(__dirname, '../../../文件/宏达精密_订单台账.xlsx'),
    path.resolve(__dirname, '../../docs/原始材料/宏达精密_订单台账.xlsx')
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到台账，试过：\n' + cands.join('\n'));
}

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  const ledger = findLedger();
  await p.goto('file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/'));
  await p.setInputFiles('#fileInput', ledger);
  await p.waitForSelector('#fileMeta.ok');
  await p.click('#btnRun');
  await p.waitForSelector('#viewResult.is-active');
  await p.waitForTimeout(800);
  await p.emulateMedia({ media: 'print' });
  const outPdf = path.resolve(__dirname, '../../screenshots/print.pdf');
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  await p.pdf({ path: outPdf, format: 'A4', landscape: true, printBackground: true });
  await b.close();
  console.log('pdf ok -> ' + outPdf);
})();
