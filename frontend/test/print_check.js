const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1000 } });
  await p.goto('file://' + path.resolve(__dirname, '../index.html').replace(/\\/g, '/'));
  await p.setInputFiles('#fileInput', path.resolve(__dirname, '../../文件/宏达精密_订单台账.xlsx'));
  await p.waitForSelector('#fileMeta.ok');
  await p.click('#btnRun');
  await p.waitForSelector('#viewResult.is-active');
  await p.waitForTimeout(800);
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: path.resolve(__dirname, '../../screenshots/print.pdf'), format: 'A4', landscape: true, printBackground: true });
  await b.close();
  console.log('pdf ok');
})();
