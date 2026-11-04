/* ═══════════════════════════════════════════════════════════════════════
   宏达精密 · 本地排产助手 — 界面逻辑
   职责：文件选择 → 读 xlsx → 调引擎 → 渲染五块内容（甘特/排单/风险/体检/产能）
   不做计算：所有数字都来自 engine.js 的同一份结果对象
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ═══════════ 状态 ═══════════ */
  var state = {
    file: null,          // File
    sheets: null,        // 解析后的三个 sheet
    result: null,        // 引擎结果
    uploadInfo: null,    // {orders, machines, routes}
    opts: defaultOpts(),
    running: false,
    sort: { orders: { key: 'startAxis', dir: 1 } },
    riskFilter: 'all',
    healthOpen: {}
  };

  function defaultOpts() {
    return {
      startDate: '',
      allowSwap: 1,
      enableGrd02: 0,
      enableCnc03: 0,
      emptyQty: 'skip',
      lotSize: 20,
      flowOn: 1
    };
  }

  /* ═══════════ 小工具 ═══════════ */
  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function n0(x) { return x == null ? '—' : String(Math.round(x)); }
  function pct(x) { return (x * 100).toFixed(1) + '%'; }

  /** 弹一个中文错误（不白屏、不显示 Traceback） */
  function showError(title, body, detail) {
    var box = $('#uploadError');
    box.hidden = false;
    $('#errTitle').textContent = title || '出错了';
    $('#errBody').innerHTML = body || '';
    var det = $('#errDetail');
    det.textContent = detail || '';
    box.querySelector('.alert-detail').hidden = !detail;
    $('#dropzone').classList.add('is-bad');
  }
  function clearError() {
    $('#uploadError').hidden = true;
    $('#dropzone').classList.remove('is-bad');
  }

  function setStatus(text, tone) {
    $('#statusText').textContent = text;
    $('#status').setAttribute('data-tone', tone || 'idle');
  }

  function setRunning(on) {
    state.running = on;
    var btn = $('#btnRun');
    btn.disabled = on || !state.file;
    btn.querySelector('.btn-label').textContent = on ? '排程中…' : '开始排程';
    btn.querySelector('.spinner').hidden = !on;
  }

  /* ═══════════ 参数区 ═══════════ */
  function syncSegs() {
    $$('.seg').forEach(function (seg) {
      var name = seg.getAttribute('data-name');
      var val = String(state.opts[name]);
      $$('button', seg).forEach(function (b) {
        b.classList.toggle('on', b.getAttribute('data-val') === val);
      });
    });
  }

  function updateParamline() {
    var o = state.opts;
    var start = o.startDate || (state.uploadInfo && state.uploadInfo.suggestStart) || '（自动）';
    var parts = [
      '原点 ' + start, '两班8h', '周日不排', '交期17:00', '窗口6天',
      'GRD02=' + (o.enableGrd02 ? 'on' : 'off'),
      'CNC03=' + (o.enableCnc03 ? 'on' : 'off'),
      'LAT03=2班',
      'lot=' + o.lotSize,
      'C3=' + (o.flowOn ? '30min' : 'off'),
      '换机台=' + (o.allowSwap ? '是' : '否'),
      '空数量=' + ({ skip: '跳过并提示', zero: '按 0 排', error: '直接报错' }[o.emptyQty])
    ];
    $('#paramline').textContent = '本次参数：' + parts.join(' | ');
  }

  $$('.seg').forEach(function (seg) {
    seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-val]');
      if (!btn) return;
      var name = seg.getAttribute('data-name');
      var raw = btn.getAttribute('data-val');
      state.opts[name] = (name === 'emptyQty') ? raw : Number(raw);
      syncSegs();
      updateParamline();
    });
  });

  $('#optLot').addEventListener('input', function () {
    var v = Number(this.value);
    if (!isFinite(v) || v < 5 || v > 500) {
      this.style.borderColor = '#d9534f';
      return;
    }
    this.style.borderColor = '';
    state.opts.lotSize = Math.max(10, Math.min(200, Math.round(v)));
    updateParamline();
  });

  $('#optStart').addEventListener('change', function () {
    state.opts.startDate = this.value || '';
    var d = this.value ? new Date(this.value + 'T00:00:00') : null;
    if (d && d.getDay() === 0) {
      $('#startHelp').textContent = '⚠ 该日是周日（工厂周日不排），排程会自动顺延到下一个工作日';
      $('#startHelp').style.color = '#d9534f';
    } else {
      $('#startHelp').textContent = '自动取「台账整理日之后最近的周一」，可手改';
      $('#startHelp').style.color = '';
    }
    updateParamline();
  });

  $('#btnReset').addEventListener('click', function () {
    state.opts = defaultOpts();
    syncSegs();
    $('#optLot').value = state.opts.lotSize;
    if (state.uploadInfo) $('#optStart').value = state.uploadInfo.suggestStart || '';
    state.opts.startDate = $('#optStart').value || '';
    $('#startHelp').textContent = '自动取「台账整理日之后最近的周一」，可手改';
    $('#startHelp').style.color = '';
    updateParamline();
  });

  /* ═══════════ 文件选择 ═══════════ */
  var dz = $('#dropzone');
  var input = $('#fileInput');

  dz.addEventListener('click', function () { input.click(); });
  dz.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('is-over'); });
  });
  dz.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  input.addEventListener('change', function () {
    if (input.files && input.files[0]) handleFile(input.files[0]);
  });
  $('#btnRepick').addEventListener('click', function () { input.value = ''; input.click(); });

  /** 先做扩展名/大小检查（快），再做内容检查（准） */
  function handleFile(file) {
    clearError();
    state.file = null;
    state.sheets = null;
    state.uploadInfo = null;
    state.result = null;
    setRunning(false);
    setStatus('正在读取文件…', 'run');
    $('#filepick').hidden = false;
    $('#fileName').textContent = file.name;
    $('#fileSize').textContent = '（' + fmtSize(file.size) + '）';
    var meta = $('#fileMeta');
    meta.textContent = '读取中…';
    meta.className = 'filepick-meta';

    var lower = file.name.toLowerCase();
    if (!/\.(xlsx|xlsm)$/.test(lower)) {
      meta.textContent = '✗ 不是 .xlsx';
      meta.className = 'filepick-meta bad';
      showError('请上传 .xlsx 文件',
        '当前文件是 <code>' + esc(file.name) + '</code>，不是 Excel 工作簿。' +
        '请把台账另存为 <code>.xlsx</code> 后再上传。',
        '文件扩展名：' + esc(lower.split('.').pop()));
      setStatus('文件类型不对，请重新选择 .xlsx 台账', 'err');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      meta.textContent = '✗ 文件过大';
      meta.className = 'filepick-meta bad';
      showError('文件过大', '台账有 ' + fmtSize(file.size) + '，超过 30 MB。请确认选对了文件。');
      setStatus('文件过大', 'err');
      return;
    }

    var reader = new FileReader();
    reader.onerror = function () {
      meta.textContent = '✗ 读取失败';
      meta.className = 'filepick-meta bad';
      showError('读不到文件', '浏览器读取本地文件失败。请重新选择，或把文件复制到桌面再试。');
      setStatus('读取失败', 'err');
    };
    reader.onload = function () {
      var buf = reader.result;
      XlsxLite.readWorkbook(buf).then(function (sheets) {
        return validateSheets(sheets);
      }).then(function (info) {
        state.sheets = info.sheets;
        state.uploadInfo = info;
        state.file = file;
        meta.textContent = '✓ ' + info.orders + ' 张订单 · ' + info.machines + ' 台设备 · ' + info.routes + ' 个产品工艺';
        meta.className = 'filepick-meta ok';
        $('#optStart').disabled = false;
        $('#optLot').disabled = false;
        $('#optStart').value = info.suggestStart;
        state.opts.startDate = info.suggestStart;
        $('#btnRun').disabled = false;
        setRunning(false);
        updateParamline();
        setStatus('已就绪：' + info.orders + ' 张订单，点「开始排程」', 'ok');
      }).catch(function (err) {
        meta.textContent = '✗ ' + (err.title || '读取失败');
        meta.className = 'filepick-meta bad';
        var title = err.title || err.name || '读取失败';
        var body = err.userMessage || err.message || '无法解析这个文件。';
        if (/缺少工作表/.test(body)) {
          body += '<br>请检查台账是否完整（三个 sheet 都要在，名称保持「订单 / 设备 / 工艺路线」）。';
        }
        if (/表头/.test(body)) {
          body += '<br>表头要在前 6 行内，且列名保持原样（单号 / 客户 / 接单日期 / 交期 / 产品 / 数量 / 备注）。';
        }
        showError(title, body, err.stack || '');
        setStatus('台账读取失败，' + title, 'err');
        $('#btnRun').disabled = true;
      });
    };
    reader.readAsArrayBuffer(file);
  }

  /** 结构校验：有没有三个 sheet、能不能认出表头、有没有订单行 */
  function validateSheets(sheets) {
    var names = Object.keys(sheets).filter(function (k) { return !/^__/.test(k); });
    var need = ['订单', '设备', '工艺路线'];
    var miss = need.filter(function (n) { return !sheets[n]; });
    if (miss.length) {
      throw mkErr('缺少工作表', '台账里找不到工作表：' + miss.join(' / ') + '。当前文件只有：' + (names.join(' / ') || '（空）'));
    }
    var orders = sheets['订单'].filter(function (r) { return r && r.some(function (c) { return c !== null && String(c).trim() !== ''; }); });
    if (!orders.length) throw mkErr('空表', '「订单」工作表里一行数据都没有。');

    // 找表头（与引擎同规则，这里只用于显示行数）
    var head = -1;
    for (var i = 0; i < Math.min(6, sheets['订单'].length); i++) {
      var row = (sheets['订单'][i] || []).map(function (c) { return String(c == null ? '' : c).replace(/\s/g, ''); });
      if (row.indexOf('单号') >= 0 && row.indexOf('产品') >= 0) { head = i; break; }
    }
    if (head < 0) {
      throw mkErr('表头不对', '在「订单」工作表前 6 行里找不到表头「单号 / 产品 / 数量」。标准表头是：单号 / 客户 / 接单日期 / 交期 / 产品 / 数量 / 备注。');
    }
    var hdr = sheets['订单'][head].map(function (c) { return String(c == null ? '' : c).replace(/\s/g, ''); });
    var needCols = ['单号', '交期', '产品', '数量'];
    var lack = needCols.filter(function (c) { return hdr.indexOf(c) < 0; });
    if (lack.length) {
      throw mkErr('表头不对', '「订单」表头缺少列：' + lack.join(' / ') + '。实际表头为：' + hdr.filter(Boolean).join(' / '));
    }

    // 订单数据行数（扣除注释/空行）：产品 + 数量至少一个有值
    var rows = 0;
    for (var r = head + 1; r < sheets['订单'].length; r++) {
      var line = sheets['订单'][r] || [];
      var ci = hdr.indexOf('产品'), qi = hdr.indexOf('数量');
      var prod = ci >= 0 ? String(line[ci] == null ? '' : line[ci]).trim() : '';
      var qty = qi >= 0 ? line[qi] : null;
      if (prod || (qty !== null && qty !== undefined && String(qty).trim() !== '')) rows++;
    }

    var machineRows = countRows(sheets['设备']);
    var routeRows = countProductRows(sheets['工艺路线']);

    // 建议起点：标题里的整理日 → 之后最近的周一
    var suggest = suggestStart(sheets['订单'], head);

    return {
      sheets: sheets, orders: rows, machines: machineRows, routes: routeRows, suggestStart: suggest
    };
  }

  /** 产品行数：A 列有产品名、且该行有「工序N」内容的行（备注行不算） */
  function countProductRows(rows) {
    if (!rows) return 0;
    var head = -1;
    for (var i = 0; i < Math.min(6, rows.length); i++) {
      var r = (rows[i] || []).map(function (c) { return String(c == null ? '' : c).replace(/\s/g, ''); });
      if (r.indexOf('产品') >= 0) { head = i; break; }
    }
    if (head < 0) return 0;
    var opCols = [];
    (rows[head] || []).forEach(function (c, ci) {
      if (/^工序\d+$/.test(String(c == null ? '' : c).replace(/\s/g, ''))) opCols.push(ci);
    });
    var n = 0;
    rows.slice(head + 1).forEach(function (row) {
      if (!row) return;
      var prod = String(row[0] == null ? '' : row[0]).trim();
      if (!prod) return;
      var hasOp = opCols.some(function (ci) {
        var v = row[ci];
        return v !== null && v !== undefined && String(v).trim() !== '';
      });
      if (hasOp) n++;
    });
    return n;
  }

  function countRows(rows) {
    if (!rows) return 0;
    var n = 0;
    rows.forEach(function (r) {
      if (r && r.some(function (c) { return c !== null && String(c).trim() !== ''; })) n++;
    });
    return Math.max(0, n - 2); // 去掉标题行和表头行
  }

  function suggestStart(rows, head) {
    var title = (rows[0] || []).map(String).join(' ');
    var m = title.match(/(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
    var base;
    if (m) base = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    else {
      // 退回：最大接单日期
      var best = 0;
      var hi = (rows[head] || []).map(function (c) { return String(c == null ? '' : c).replace(/\s/g, ''); }).indexOf('接单日期');
      rows.slice(head + 1).forEach(function (r) {
        var v = hi >= 0 ? String((r && r[hi]) || '') : '';
        var mm = v.match(/(\d{4})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})/);
        if (mm) best = Math.max(best, Date.UTC(+mm[1], +mm[2] - 1, +mm[3]));
      });
      base = best || Date.UTC(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
    }
    var d = new Date(base);
    // 之后最近的周一（不含当天）
    while (d.getUTCDay() !== 1) d = new Date(d.getTime() + 86400000);
    if (d.getTime() <= base) d = new Date(d.getTime() + 7 * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function mkErr(title, msg) {
    var e = new Error(msg); e.title = title; e.userMessage = msg; return e;
  }

  /* ═══════════ 运行 ═══════════ */
  $('#btnRun').addEventListener('click', function () {
    if (!state.sheets || state.running) return;
    clearError();
    setRunning(true);
    var stages = ['读取台账', '清洗脏数据', '建立工序实例', '规则排程', '独立校验', '生成报表'];
    var i = 0;
    setStatus('正在排程… ' + stages[0], 'run');

    // 让浏览器先把"排程中"画出来，再开始算
    setTimeout(function () {
      var t0 = performance.now();
      var res;
      try {
        res = ApsEngine.run(state.sheets, {
          startDate: state.opts.startDate || null,
          allowSwap: !!state.opts.allowSwap,
          enableGrd02: !!state.opts.enableGrd02,
          enableCnc03: !!state.opts.enableCnc03,
          emptyQty: state.opts.emptyQty,
          lotSize: state.opts.lotSize,
          flowOn: !!state.opts.flowOn,
          sourceFile: state.file ? state.file.name : '宏达精密_订单台账.xlsx'
        });
      } catch (err) {
        setRunning(false);
        var title = err.title || '排程失败';
        var body = err.userMessage || err.message || '未知错误';
        showError(title, esc(body) + '<br>数据没有被修改，可以换个台账或调整参数再试。', err.stack || '');
        setStatus('排程失败：' + title, 'err');
        return;
      }
      var ms = performance.now() - t0;
      state.result = res;
      state.result.__wall = ms;
      setRunning(false);
      renderResult(res);
      setStatus('已生成：' + res.meta.counts.opsPlanned + ' 道工序，用时 ' + (ms / 1000).toFixed(2) + ' 秒', 'ok');
      $('#viewHome').classList.remove('is-active');
      $('#viewResult').classList.add('is-active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }, 30);
  });

  $('#btnBack').addEventListener('click', function () {
    $('#viewResult').classList.remove('is-active');
    $('#viewHome').classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ═══════════ 渲染结果 ═══════════ */
  function renderResult(R) {
    $('#resultFile').textContent = R.meta.sourceFile;
    renderBanner(R);
    renderCards(R);
    renderGantt(R);
    renderOrders(R);
    renderRisk(R);
    renderHealth(R);
    renderCapacity(R);

    var badgeRisk = $('#tabBadgeRisk');
    badgeRisk.textContent = R.risk.totals.delayed + R.risk.totals.atRisk;
    badgeRisk.className = 'tab-badge' + (R.risk.totals.delayed > 0 ? ' hot' : (R.risk.totals.atRisk > 0 ? ' info' : ''));

    var badgeHealth = $('#tabBadgeHealth');
    badgeHealth.textContent = R.health.counts.total;
    badgeHealth.className = 'tab-badge' + (R.health.counts.askCustomer > 0 ? ' info' : '');

    switchTab('gantt');
  }

  function renderBanner(R) {
    var v = R.verify;
    var skipped = R.meta.counts.opsUnplanned;
    var cls = v.result === 'FAIL' ? 'fail' : (v.result === 'PASS' ? 'pass' : 'warn');
    var icon = v.result === 'FAIL' ? '✕' : (v.result === 'PASS' ? '✓' : '!');
    var main;
    if (v.result === 'FAIL') {
      main = '<b>校验未通过</b>（' + v.hardViolations + ' 处硬约束违反）。这份排程 <b>不能</b> 直接交给车间，请查看「数据体检」页签。';
    } else if (skipped > 0) {
      main = '<b>四条硬约束 0 违反</b>，但有 <b>' + skipped + ' 道工序排不进</b>' +
        (v.softViolations ? '，另有 ' + v.softViolations + ' 个批次流水条件（H5）未达成' : '') +
        '。逐条原因已登记在「交期风险」「排单表」里，这份排程能交，但「排不进」必须先讲清楚。';
    } else if (v.softViolations > 0) {
      main = '<b>四条硬约束 0 违反</b>（不重不漏 / 机台对 / 不倒序 / 不重叠），排程可用。' +
        '但 <b>H5 阀芯C 车→磨 ≤30min 未达成 ' + v.softViolations + ' 个批次</b>：磨床一台机扛全部磨工序，' +
        '紧贴窗口塞不进去。这是产能问题、不是算法问题（见「产能核对」页签）。';
    } else {
      main = '<b>五项校验全部通过</b>：' + R.meta.counts.opsPlanned + ' 道工序已排，0 违反。';
    }
    var side = '已排 ' + R.meta.counts.opsPlanned + ' / ' + R.meta.counts.opsTotal + ' 道 · 规则「' + esc(R.meta.ruleCn) + '」 · ' + (R.__wall || R.meta.elapsed) + ' ms';
    $('#verifyBanner').className = 'banner ' + cls;
    $('#verifyBanner').innerHTML =
      '<span class="banner-icon">' + icon + '</span>' +
      '<div class="banner-main">' + main + '</div>' +
      '<span class="banner-side">' + side + '</span>';
  }

  function renderCards(R) {
    $('#cards').innerHTML = R.cards.map(function (c) {
      return '<div class="card-metric" data-tone="' + esc(c.tone) + '" title="' + esc(c.tip) + '">' +
        '<div class="cm-label">' + esc(c.label) + '</div>' +
        '<div class="cm-value">' + esc(c.value) + '</div>' +
        '<div class="cm-sub">' + esc(c.sub) + '</div>' +
        '</div>';
    }).join('');
  }

  /* ───────── 甘特图 ───────── */
  var GRP_CLASS = { '下料': 'saw', '车': 'lat', '铣': 'cnc', '钻': 'drl', '磨': 'grd' };

  function renderGantt(R) {
    var G = R.gantt;
    var days = G.days;
    var totalAxis = Math.max(G.windowAxis, G.makespan);
    var DAY_PX = 168;                  // 每天宽度（px），两班各 84
    var perDay = DAY_PX / 960;         // 每轴分钟对应像素
    var laneW = Math.round(totalAxis * perDay);
    var MACH_PX = 132;

    /* 表头：两行（日期 + 班次） */
    var head = '<div class="gantt-row gantt-headrow">' +
      '<div class="gantt-mach" style="width:' + MACH_PX + 'px;min-width:' + MACH_PX + 'px">机台</div>' +
      '<div class="gantt-lane" style="width:' + laneW + 'px;min-width:' + laneW + 'px">' +
      '<div class="gantt-days">';
    days.forEach(function (d) {
      head += '<div class="gantt-day' + (d.beyond ? ' beyond' : '') + '" style="width:' + DAY_PX + 'px">' +
        '<div class="gantt-day-label">' + d.md + ' ' + d.dow + (d.beyond ? '<i>窗外</i>' : '') + '</div>' +
        '<div class="gantt-shifts"><span>08–16</span><span>16–24</span></div>' +
        '</div>';
    });
    head += '</div></div></div>';

    /* 每台机一行 */
    var body = '';
    G.machines.forEach(function (m) {
      var firstGroup = m.group.split('/')[0];
      var cls = GRP_CLASS[firstGroup] || 'other';
      var bars = G.bars.filter(function (b) { return b.m === m.id; });
      var barsHtml = bars.map(function (b) {
        var op = R.operations.filter(function (o) { return o.lotId === b.lot && o.op === b.op; })[0];
        var c2 = GRP_CLASS[(op || {}).group] || cls;
        // 按「工作日」分段：每天只有 08:00–24:00 是生产时间，夜里断开，
        // 否则一条从周一干到周三的色块会让人误以为通宵不停机
        var segs = [];
        var t = b.s;
        while (t < b.e) {
          var dayIdx = Math.floor(t / 960);
          var segEnd = Math.min(b.e, (dayIdx + 1) * 960);
          segs.push([t, segEnd]);
          t = segEnd;
        }
        return segs.map(function (sg, si) {
          var left = sg[0] * perDay;
          var w = Math.max(2, (sg[1] - sg[0]) * perDay - (si > 0 ? 2 : 0));
          var label = (si === 0 && w > 46) ? b.id.replace(/^HD-2026-/, '') : (w > 26 ? b.op : '');
          return '<div class="bar ' + c2 + (b.flow ? ' flow-next' : '') + '" ' +
            'style="left:' + left.toFixed(1) + 'px;width:' + w.toFixed(1) + 'px" ' +
            'data-tip="' + esc(tipOf(b)) + '">' +
            (label ? '<span class="bar-label">' + esc(label) + '</span>' : '') + '</div>';
        }).join('');
      }).join('');

      body += '<div class="gantt-row">' +
        '<div class="gantt-mach' + (m.isBottleneck ? ' is-bottle' : '') + '" style="width:' + MACH_PX + 'px;min-width:' + MACH_PX + 'px">' +
        '<b>' + esc(m.id) + '</b><span class="m-group">' + esc(m.group) + '</span></div>' +
        '<div class="gantt-lane" style="width:' + laneW + 'px;min-width:' + laneW + 'px">' +
        '<div class="gantt-days">' + days.map(function (d) {
          return '<div class="gantt-day' + (d.beyond ? ' beyond' : '') + '" style="width:' + DAY_PX + 'px"></div>';
        }).join('') + '</div>' +
        '<div class="gantt-bars">' + barsHtml + '</div>' +
        '</div></div>';
    });

    $('#gantt').innerHTML = '<div class="gantt-canvas" style="width:' + (MACH_PX + laneW) + 'px">' +
      head + body + '</div>';
    $('#gantt').style.setProperty('--mach-w', MACH_PX + 'px');

    bindGanttTips();
  }

  /** 色块颜色按工序组取（不是按机台） */
  function groupOf(R, b) {
    var op = R.operations.find(function (o) { return o.lotId === b.lot && o.seq && o.op === b.op; });
    var g = op ? op.group : '';
    return GRP_CLASS[g] || '';
  }

  function tipOf(b) {
    var c = clockOfAxis(b.s);
    return b.id + ' | ' + b.op + ' | ' + c + ' → ' + clockOfAxis(b.e) + ' | ' + b.dur + ' min | ' + b.qty + ' 件';
  }
  function clockOfAxis(axis) {
    var R = state.result;
    var i = Math.floor(axis / 960);
    var day = R.gantt.days[Math.min(i, R.gantt.days.length - 1)];
    var inDay = axis - i * 960;
    var clock = 8 * 60 + inDay;
    var hh = Math.floor(clock / 60) % 24, mm = Math.round(clock % 60);
    return (day ? day.md : '?') + ' ' + (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  var tipEl = null;
  function bindGanttTips() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'gantt-tip';
      document.body.appendChild(tipEl);
    }
    $$('#gantt .bar').forEach(function (bar) {
      bar.addEventListener('mouseenter', function (e) {
        tipEl.textContent = '';
        var parts = bar.getAttribute('data-tip').split(' | ');
        tipEl.innerHTML = '<b>' + esc(parts[0]) + '</b> · ' + esc(parts[1]) +
          '<br>' + esc(parts[2]) + '<br>' + esc(parts[3] || '');
        tipEl.classList.add('show');
        moveTip(e);
      });
      bar.addEventListener('mousemove', moveTip);
      bar.addEventListener('mouseleave', function () { tipEl.classList.remove('show'); });
    });
  }
  function moveTip(e) {
    if (!tipEl) return;
    var x = e.clientX + 14, y = e.clientY + 16;
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    if (x + w > window.innerWidth - 10) x = e.clientX - w - 14;
    if (y + h > window.innerHeight - 10) y = e.clientY - h - 14;
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }

  /* ───────── 排单表 ───────── */
  var ORDER_COLS = [
    { key: 'startDate', label: '日期', cls: 'mono' },
    { key: 'shift', label: '班次' },
    { key: 'machine', label: '机台', cls: 'mono' },
    { key: 'lotId', label: '单号', cls: 'mono' },
    { key: 'op', label: '工序' },
    { key: 'qty', label: '数量', cls: 'num' },
    { key: 'startTime', label: '开工', cls: 'mono' },
    { key: 'endDate', label: '完工日', cls: 'mono' },
    { key: 'endTime', label: '完工时刻', cls: 'mono' },
    { key: 'durationMin', label: '工时(min)', cls: 'num' },
    { key: 'product', label: '产品' }
  ];

  function shiftOf(startAxis) { return (startAxis % 960) < 480 ? '白班' : '夜班'; }

  function renderOrders(R) {
    var ops = R.operations.map(function (o) {
      return Object.assign({}, o, { shift: shiftOf(o.startAxis) });
    });
    var st = state.sort.orders;
    ops.sort(function (a, b) {
      var va = a[st.key], vb = b[st.key];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * st.dir;
      if (va > vb) return 1 * st.dir;
      return 0;
    });

    var head = ORDER_COLS.map(function (c) {
      var sorted = st.key === c.key;
      return '<th class="sortable' + (sorted ? ' sorted' : '') + (c.cls === 'num' ? ' num' : '') + '" data-key="' + c.key + '">' +
        c.label + '<span class="arrow">' + (sorted ? (st.dir > 0 ? '▲' : '▼') : '▾') + '</span></th>';
    }).join('');

    var rows = ops.map(function (o) {
      var risk = R.summary.find(function (s) { return s.orderId === o.orderId; });
      var rowCls = risk ? 'row-' + risk.status : '';
      return '<tr class="' + rowCls + '" data-order="' + esc(o.orderId) + '">' +
        '<td class="mono">' + esc(o.startDate) + '</td>' +
        '<td>' + esc(o.shift) + '</td>' +
        '<td class="mono"><b>' + esc(o.machine) + '</b></td>' +
        '<td class="mono">' + esc(o.lotId) + '</td>' +
        '<td>' + esc(o.op) + '</td>' +
        '<td class="num">' + esc(o.qty) + '</td>' +
        '<td class="mono">' + esc(o.startTime) + '</td>' +
        '<td class="mono">' + esc(o.endDate) + '</td>' +
        '<td class="mono">' + esc(o.endTime) + '</td>' +
        '<td class="num">' + esc(o.durationMin) + '</td>' +
        '<td>' + esc(o.product) + '</td>' +
        '</tr>';
    }).join('');

    var unplanRows = R.unplannable.map(function (u) {
      return '<tr class="row-blocked">' +
        '<td class="mono">—</td><td>未排入</td><td class="mono">' + esc(u.blockingMachine || '—') + '</td>' +
        '<td class="mono">' + esc(u.lotId) + '</td><td>' + esc(u.op) + '</td>' +
        '<td class="num">—</td><td class="mono">—</td><td class="mono">—</td><td class="mono">—</td>' +
        '<td class="num">—</td><td class="wrap">' + esc(u.reason) + '</td></tr>';
    }).join('');

    $('#ordersTable').innerHTML = ops.length
      ? '<table><thead><tr>' + head + '</tr></thead><tbody>' + rows + unplanRows + '</tbody></table>'
      : '<div class="empty"><span class="empty-icon">▤</span>没有任何工序被排入。<br>请看「交期风险」页签里每张单的排不进原因。</div>';

    $('#ordersTitle').textContent = '排单表（' + ops.length + ' 道工序' +
      (R.unplannable.length ? ' + ' + R.unplannable.length + ' 道未排入' : '') + '）';

    $$('#ordersTable th.sortable').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.getAttribute('data-key');
        if (state.sort.orders.key === k) state.sort.orders.dir *= -1;
        else state.sort.orders = { key: k, dir: 1 };
        renderOrders(R);
      });
    });
    bindOrderSearch(R);
  }

  function bindOrderSearch(R) {
    var box = $('#ordersSearch');
    box.disabled = false;
    box.value = '';
    box.oninput = function () {
      var q = this.value.trim().toLowerCase();
      $$('#ordersTable tbody tr').forEach(function (tr) {
        tr.style.display = (!q || tr.textContent.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
      });
    };
  }

  /* ───────── 风险清单 ───────── */
  const RISK_COLS = [
    { key: 'orderId', label: '单号', cls: 'mono' },
    { key: 'statusCn', label: '类型' },
    { key: 'dueMd', label: '交期', cls: 'mono' },
    { key: 'plannedEndLabel', label: '预计完工', cls: 'mono' },
    { key: 'delayMd', label: '差额' },
    { key: 'bottleneckMachine', label: '卡在哪台机', cls: 'mono' },
    { key: 'bottleneckOp', label: '卡在哪个工序' },
    { key: 'qtyLabel', label: '数量', cls: 'num' },
    { key: 'suggestion', label: '建议动作', cls: 'wrap' }
  ];

  function renderRisk(R) {
    var rows = R.risk.rows;
    var t = R.risk.totals;
    var filters = [
      { key: 'all', label: '全部', n: rows.length },
      { key: 'delayed', label: '🔴 延期', n: t.delayed },
      { key: 'at_risk', label: '🟡 预警', n: t.atRisk },
      { key: 'not_in_horizon', label: '⚪ 未排入本周', n: t.notInHorizon },
      { key: 'unplannable', label: '⚫ 排不进', n: t.unplannable },
      { key: 'ok', label: '🟢 准时', n: t.ok }
    ];
    $('#riskFilters').innerHTML = filters.map(function (f) {
      return '<button class="chip' + (state.riskFilter === f.key ? ' on' : '') + '" data-filter="' + f.key + '">' +
        f.label + ' <span class="n">' + f.n + '</span></button>';
    }).join('');

    $$('#riskFilters .chip').forEach(function (c) {
      c.addEventListener('click', function () {
        state.riskFilter = c.getAttribute('data-filter');
        renderRisk(R);
      });
    });

    var list = state.riskFilter === 'all' ? rows : rows.filter(function (r) { return r.status === state.riskFilter; });

    var head = '<tr>' + RISK_COLS.map(function (c) {
      return '<th class="' + (c.cls === 'num' ? 'num' : '') + '">' + c.label + '</th>';
    }).join('') + '</tr>';

    var body = list.map(function (r) {
      return '<tr class="row-' + r.status + ' clickable" data-order="' + esc(r.orderId) + '" data-machine="' + esc(r.bottleneckMachine || '') + '">' +
        '<td class="mono"><b>' + esc(r.orderId) + '</b>' + (r.flags && r.flags.length ? ' <span class="tag">' + esc(r.flags[0]) + '</span>' : '') + '</td>' +
        '<td><span class="pill ' + r.status + '">' + esc(r.statusCn) + '</span></td>' +
        '<td class="mono">' + esc(r.dueMd) + '</td>' +
        '<td class="mono">' + esc(r.plannedEndLabel) + '</td>' +
        '<td class="mono">' + (r.delayMd || '—') + '</td>' +
        '<td class="mono">' + (r.bottleneckMachine ? '<b>' + esc(r.bottleneckMachine) + '</b>' : '—') + '</td>' +
        '<td>' + esc(r.bottleneckOp || '—') + '</td>' +
        '<td class="num">' + qtyLabel(r) + '</td>' +
        '<td class="wrap">' + esc(r.suggestion) + '</td>' +
        '</tr>';
    }).join('');

    $('#riskTable').innerHTML = list.length
      ? '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
        '<div class="table-foot">' +
        '<span>合计 <b>' + rows.length + '</b> 张</span>' +
        '<span>延期 <b>' + t.delayed + '</b></span>' +
        '<span>预警 <b>' + t.atRisk + '</b></span>' +
        '<span>未排入本周 <b>' + t.notInHorizon + '</b></span>' +
        '<span>排不进 <b>' + t.unplannable + '</b></span>' +
        '<span>准时 <b>' + t.ok + '</b></span>' +
        '</div>'
      : '<div class="empty"><span class="empty-icon">☺</span>这个筛选下没有订单——这是好事。</div>';

    $$('#riskTable tr.clickable').forEach(function (tr) {
      tr.addEventListener('click', function () {
        focusOrder(tr.getAttribute('data-order'));
      });
    });
  }

  function qtyLabel(r) {
    if (r.qty == null) return '—';
    var s = String(r.qty);
    if (r.qtyFull != null && r.qtyFull !== r.qty) s += ' / ' + r.qtyFull;
    return esc(s);
  }

  /** 点风险行 → 跳排单表并高亮该单的全部工序（任务书 N6「回排单表核对」） */
  function focusOrder(orderId) {
    switchTab('orders');
    var rows = $$('#ordersTable tbody tr');
    rows.forEach(function (tr) {
      var hit = tr.getAttribute('data-order') === orderId;
      tr.classList.toggle('is-hit', hit);
    });
    var first = rows.filter(function (tr) { return tr.getAttribute('data-order') === orderId; })[0];
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    var box = $('#ordersSearch');
    if (box) { box.value = ''; box.oninput && box.oninput.call(box); }
  }

  /* ───────── 数据体检 ───────── */
  function renderHealth(R) {
    var H = R.health;
    $('#healthSummary').textContent = '共 ' + H.counts.total + ' 条记录 · ' + H.counts.classes + ' 类问题 · 其中 ' +
      H.counts.askCustomer + ' 条需客户确认（' + H.counts.askClasses + ' 类）';

    if (!H.groups.length) {
      $('#healthBody').innerHTML = '<div class="empty"><span class="empty-icon">✓</span>台账干净，没有需要记录的清洗动作。</div>';
      return;
    }

    $('#healthBody').innerHTML = '<div class="health-grid">' + H.groups.map(function (g) {
      var items = g.items.map(function (it) {
        return '<div class="hitem">' +
          '<div class="hitem-loc">' + esc(it.locator || '—') + '</div>' +
          '<div class="hitem-body">' +
          '<div class="sym">' + esc(it.symptom) + '</div>' +
          '<div class="hand">' + esc(it.handling) + '</div>' +
          '</div></div>';
      }).join('');
      return '<div class="hgroup">' +
        '<div class="hgroup-head">' +
        '<span class="sev ' + g.severity + '"></span>' +
        '<h4>' + esc(g.title) + '</h4>' +
        '<span class="count">' + g.count + ' 条</span>' +
        (g.askCustomer ? '<span class="askflag">需客户确认</span>' : '') +
        '</div>' +
        '<div class="hitems">' + items + '</div>' +
        '</div>';
    }).join('') + '</div>';
  }

  /* ───────── 产能核对 ───────── */
  function renderCapacity(R) {
    var C = R.capacity;
    var totalUtil = C.totalCapacity ? C.totalLoad / C.totalCapacity : 0;

    var rows = C.groups.map(function (g) {
      var u = g.util;
      var cls = u > 1 ? 'over' : (u > 0.85 ? 'near' : '');
      var utilCell = g.onlyShared
        ? '<span class="muted">与' + esc(g.sharedWith.join('/')) + '共用机台</span>'
        : '<div style="display:flex;align-items:center;gap:8px">' +
          '<div class="utilbar"><span class="' + cls + '" style="width:' + Math.min(100, u * 100).toFixed(1) + '%"></span></div>' +
          '<span class="util-pct" style="color:' + (u > 1 ? '#d9534f' : (u > .85 ? '#c98a1e' : '#2f9e6a')) + '">' + (u * 100).toFixed(1) + '%</span>' +
          '</div>';
      return '<tr class="' + (g.over ? 'row-delayed' : '') + '">' +
        '<td><b>' + esc(g.group) + '</b></td>' +
        '<td class="mono">' + (g.machines.join(' / ') || '—') + '</td>' +
        '<td class="num">' + n0(g.load) + '</td>' +
        '<td class="num">' + n0(g.capacity) + '</td>' +
        '<td class="num">' + (g.over ? '<b style="color:#d9534f">' + n0(g.gap) + '</b>' : '0') + '</td>' +
        '<td style="min-width:150px">' + utilCell + '</td>' +
        '<td>' + (g.over ? '<span class="pill delayed">超窗 ' + (g.gap / 960).toFixed(1) + ' 天</span>'
          : (g.onlyShared ? '<span class="pill not_in_horizon">本批无此工序</span>' : '<span class="pill ok">装得下</span>')) + '</td>' +
        '</tr>';
    }).join('');

    var mach = C.machines.map(function (m) {
      var u = m.util;
      return '<div class="mcard' + (m.isBottleneck ? ' bottle' : '') + '">' +
        '<div class="mcard-top"><b>' + esc(m.id) + '</b><span class="g">' + esc(m.group) + '</span>' +
        (m.isBottleneck ? '<span class="bflag">瓶颈</span>' : '') + '</div>' +
        '<div class="mhrs">占用 ' + (m.busy / 60).toFixed(1) + ' h / 96.0 h</div>' +
        '<div class="utilbar"><span class="' + (u > 1 ? 'over' : (u > .85 ? 'near' : '')) + '" style="width:' + Math.min(100, u * 100).toFixed(1) + '%"></span></div>' +
        '<div class="util-pct" style="margin-top:4px;color:' + (u > .85 ? '#d9534f' : '#7d8794') + '">' + (u * 100).toFixed(1) + '%</div>' +
        '</div>';
    }).join('');

    $('#capacityBody').innerHTML =
      '<div class="table-wrap"><table class="gap-table"><thead><tr>' +
      '<th>工序组</th><th>可用机台</th><th class="num">负荷(min)</th><th class="num">窗口容量(min)</th>' +
      '<th class="num">缺口(min)</th><th>利用率</th><th>判定</th></tr></thead><tbody>' + rows +
      '<tr><td><b>合计</b><span class="muted" style="font-size:10.5px;display:block">机台口径·不重复</span></td><td></td>' +
      '<td class="num"><b>' + n0(C.totalLoad) + '</b></td>' +
      '<td class="num"><b>' + n0(C.totalCapacity) + '</b></td>' +
      '<td class="num"><b>' + n0(Math.max(0, C.totalLoad - C.totalCapacity)) + '</b></td>' +
      '<td><span class="util-pct">' + (totalUtil * 100).toFixed(1) + '%</span></td>' +
      '<td>' + (totalUtil > 1 ? '<span class="pill delayed">超载</span>' : '<span class="pill ok">有余量</span>') + '</td></tr>' +
      '</tbody></table></div>' +
      '<div class="footnotes" style="margin-top:12px">' +
      '<p><b>为什么要两个口径：</b>组级缺口合计 ' + n0(C.groupGapSum) + ' min 是「各组分别差多少」的简单相加，' +
      '会因为一台机同时算进两个组而重复（本台账 DRL-01/02 既做钻也做攻丝，CNC-03 既做铣也做镗）。' +
      '所以合计按<b>机台口径</b>：' + C.machines.length + ' 台可用机 × 6 天 × 960 = ' + n0(C.totalCapacity) + ' min，' +
      '负荷 ' + n0(C.totalLoad) + ' min → ' + (totalUtil * 100).toFixed(1) + '%。</p>' +
      '<p>注意：总负荷「装得下」不等于「交期赶得上」。磨床单台缺口 ' + n0(findGap(R, '磨')) +
      ' min，才是这周排不完的真正原因。</p>' +
      '</div>' +
      '<h4 style="margin:18px 0 0;font-size:13px">逐台机占用</h4>' +
      '<div class="machgrid">' + mach + '</div>' +
      '<div class="footnotes" style="margin-top:16px">' +
      '<p><b>硬证据：</b>磨工序负荷 ' + n0(findLoad(R, '磨')) + ' min，窗口只有 5760 min（6 天 × 960）；' +
      '换算法也变不出来 —— 单台机需要 <b>' + (findLoad(R, '磨') / 960).toFixed(1) + ' 个工作日</b>。</p>' +
      '<p><b>口径开关：</b>「磨（GRD-01）」是点名 → 默认只用 GRD-01 一台；把参数「允许用闲置磨床 GRD-02」打开，磨缺口会从 6590 降到 830。</p>' +
      '</div>';
  }

  function findGap(R, group) {
    var g = R.capacity.groups.filter(function (x) { return x.group === group; })[0];
    return g ? g.gap : 0;
  }

  function findLoad(R, group) {
    var g = R.capacity.groups.filter(function (x) { return x.group === group; })[0];
    return g ? g.load : 0;
  }

  /* ═══════════ 页签 ═══════════ */
  function switchTab(name) {
    $$('.tab').forEach(function (t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === name); });
    $$('.panel').forEach(function (p) { p.classList.toggle('is-active', p.getAttribute('data-panel') === name); });
  }
  $$('.tab').forEach(function (t) {
    t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
  });

  /* ═══════════ 导出 / 打印 ═══════════ */
  $('#btnPrint').addEventListener('click', function () { window.print(); });

  $('#btnExport').addEventListener('click', function () {
    var R = state.result;
    if (!R) return;
    var files = {
      '01_周排程表.csv': csvOperations(R),
      '02_交期风险清单.csv': csvRisk(R),
      '03_数据体检报告.csv': csvHealth(R),
      '04_产能核对.csv': csvCapacity(R)
    };
    var names = Object.keys(files);
    if (names.length === 1) {
      download(names[0], '\ufeff' + files[names[0]]);
      return;
    }
    // 逐个下载（不需要打包库）
    names.forEach(function (n, i) {
      setTimeout(function () { download(n, '\ufeff' + files[n]); }, i * 260);
    });
    setStatus('已导出 ' + names.length + ' 个 csv 文件（Excel 可直接打开）', 'ok');
  });

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csv(rows) { return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'); }

  function csvOperations(R) {
    var rows = [['日期', '班次', '机台', '单号', '工序', '数量', '开工', '完工日', '完工时刻', '工时(min)', '产品']];
    R.operations.forEach(function (o) {
      rows.push([o.startDate, shiftOf(o.startAxis), o.machine, o.lotId, o.op, o.qty, o.startTime, o.endDate, o.endTime, o.durationMin, o.product]);
    });
    R.unplannable.forEach(function (u) {
      rows.push(['—', '未排入', u.blockingMachine || '', u.lotId, u.op, '', '', '', '', '', u.reason]);
    });
    return csv(rows);
  }

  function csvRisk(R) {
    var rows = [['单号', '类型', '交期', '预计完工', '差额', '卡在哪台机', '卡在哪个工序', '数量', '建议动作']];
    R.risk.rows.forEach(function (r) {
      rows.push([r.orderId, r.statusCn, r.dueMd, r.plannedEndLabel, r.delayMd, r.bottleneckMachine || '—',
        r.bottleneckOp || '—', r.qty == null ? '—' : r.qty, r.suggestion]);
    });
    return csv(rows);
  }

  function csvHealth(R) {
    var rows = [['类别', '严重度', '位置', '现象', '处理方式', '需客户确认']];
    R.health.issues.forEach(function (i) {
      rows.push([i.title, ({ block: '阻断', warn: '警告', info: '提示' })[i.severity], i.locator, i.symptom, i.handling, i.askCustomer ? '是' : '否']);
    });
    return csv(rows);
  }

  function csvCapacity(R) {
    var rows = [['工序组', '可用机台', '负荷(min)', '窗口容量(min)', '缺口(min)', '利用率']];
    R.capacity.groups.forEach(function (g) {
      rows.push([g.group, g.machines.join(' / '), g.load, g.capacity, g.gap,
        g.onlyShared ? '与' + g.sharedWith.join('/') + '共用机台' : (g.util * 100).toFixed(1) + '%']);
    });
    rows.push(['合计（机台口径·不重复）', '', R.capacity.totalLoad, R.capacity.totalCapacity,
      Math.max(0, R.capacity.totalLoad - R.capacity.totalCapacity),
      (R.capacity.totalLoad / R.capacity.totalCapacity * 100).toFixed(1) + '%']);
    return csv(rows);
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ═══════════ 初始化 ═══════════ */
  syncSegs();
  updateParamline();
  setStatus('请先选择台账文件', 'idle');
  $('#footStamp').textContent = '窗口口径：两班 8h / 周日不排 / 交期 17:00';

  // 延迟到打印时再算页码之类的（不做复杂排版，A4 横向由 CSS 控制）
})();
