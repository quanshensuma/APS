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
  function str(v) { return v == null ? '' : String(v); }
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
    state.unified = null;
    invalidateArtifacts();      // 换文件即视为上一版作废：产物区清空、下载置灰
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
  /** 换文件 / 读取失败时：让上一版产物彻底不可用（防「这是这次的还是上次的」） */
  function invalidateArtifacts() {
    var box = $('#artifacts');
    if (box) {
      box.className = 'artifacts is-pending';
      box.innerHTML = '';
      box.hidden = true;
    }
    hideFreshness();
    $('#btnExport').disabled = true;
    $('#btnPrint').disabled = true;
    $('#viewResult').classList.remove('is-active');
  }

  /* ═══════════ 生成 ═══════════ */
  /** 每次点生成：先清空/置灰产物区，旧链接不可点（F3-1） */
  function resetArtifactsForRun() {
    var box = $('#artifacts');
    box.className = 'artifacts is-pending';
    box.innerHTML = '';
    box.hidden = false;
    $('#viewResult').classList.remove('is-active');
  }

  /** 失败态（F3-2）：错误条保留 + 产物区明确空态 + 归档入口（样式弱于正常下载） */
  function renderArtifactsFailed(err, unified) {
    var box = $('#artifacts');
    box.className = 'artifacts is-failed';
    box.hidden = false;

    var stale = unified && unified.staleArchived;
    var staleHtml = '';
    if (stale) {
      var files = stale.files || [];
      staleHtml = '<div class="artifact-stale">' +
        '<div class="as-head">上一版已归档，仅供追溯，请勿打印贴墙</div>' +
        '<div class="as-body">' +
        files.map(function (f) {
          return '<a class="as-link" href="' + esc(f.href || f.url || '#') + '"' +
            ' target="_blank" rel="noopener">仅查看：' + esc(f.name || f.label || '归档文件') + '</a>';
        }).join('') +
        (!files.length && stale.note ? '<span class="muted">' + esc(stale.note) + '</span>' : '') +
        '</div></div>';
    }

    box.innerHTML =
      '<div class="artifact-fail">' +
      '<div class="af-icon">✕</div>' +
      '<div class="af-main">' +
      '<div class="af-title">本次未生成任何排程产物</div>' +
      '<div class="af-sub">' + esc((err && (err.userMessage || err.message)) || '排程未完成') + '</div>' +
      '</div></div>' + staleHtml;

    hideFreshness();
    $('#btnExport').disabled = true;
    $('#btnPrint').disabled = true;
  }

  function hideFreshness() {
    $('#freshness').hidden = true;
  }

  function showFreshness(unified) {
    $('#freshness').hidden = false;
    $('#freshTime').textContent = fmtTime(unified.generatedAt);
    $('#freshSource').textContent = unified.sourceFile || '—';
    $('#freshMode').textContent = unified.mode === 'server' ? '服务端计算（产物为后端生成）' : '浏览器本地计算';
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  $('#btnRun').addEventListener('click', function () {
    if (!state.sheets || state.running) return;
    clearError();
    setRunning(true);
    resetArtifactsForRun();          // F3-1：先把产物区清空/置灰
    setStatus('正在排程… 读取台账', 'run');

    var opts = {
      startDate: state.opts.startDate || null,
      allowSwap: !!state.opts.allowSwap,
      enableGrd02: !!state.opts.enableGrd02,
      enableCnc03: !!state.opts.enableCnc03,
      emptyQty: state.opts.emptyQty,
      lotSize: state.opts.lotSize,
      flowOn: !!state.opts.flowOn,
      sourceFile: state.file ? state.file.name : '宏达精密_订单台账.xlsx'
    };

    setTimeout(function () {
      var t0 = performance.now();
      var run = state.useServer
        ? APSData.runViaServer(state.file, opts)
        : APSData.runViaEngine(state.sheets, opts);

      run.then(function (out) {
        var ms = performance.now() - t0;
        var unified = APSData.unify(out.mode, out.payload, {
          fileName: state.file ? state.file.name : '',
          now: new Date().toISOString()
        });
        unified.R.__wall = ms;
        state.result = unified.R;
        state.unified = unified;
        state.lastError = null;

        setRunning(false);
        renderResult(unified);
        setStatus('已生成：' + countOps(unified.R) + ' 道工序，用时 ' + (ms / 1000).toFixed(2) + ' 秒', 'ok');
        $('#viewHome').classList.remove('is-active');
        $('#viewResult').classList.add('is-active');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }).catch(function (err) {
        setRunning(false);
        state.lastError = err;
        state.result = null;
        state.unified = null;

        var title = err.title || '排程失败';
        var body = err.userMessage || err.message || '未知错误';
        showError(title, esc(body) + '<br>本次没有生成任何产物；原始台账没有被修改。', err.stack || '');
        setStatus('排程失败：' + title, 'err');
        renderArtifactsFailed(err, state.lastUnifiedStale);
      });
    }, 30);
  });

  function countOps(R) {
    if (!R) return 0;
    if (R.meta && R.meta.counts && R.meta.counts.opsPlanned != null) return R.meta.counts.opsPlanned;
    if (R.operations) return R.operations.length;
    return 0;
  }

  $('#btnBack').addEventListener('click', function () {
    $('#viewResult').classList.remove('is-active');
    $('#viewHome').classList.add('is-active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ═══════════ 渲染结果 ═══════════ */
  function renderResult(unified) {
    var R = unified.R;
    state.result = R;
    state.unified = unified;
    // 暴露最近一次结果，供样例回归测试直接核对引擎输出（不改任何业务逻辑）
    window.__apsLastResult = R;

    $('#resultFile').textContent = unified.sourceFile || (R.meta && R.meta.sourceFile) || '';
    showFreshness(unified);
    renderBanner(R);
    renderArtifacts(unified);
    renderCards(R);
    renderGantt(R);
    renderOrders(R);
    renderRisk(R);
    renderVerify(R);
    renderHealth(R);
    renderCapacity(R);
    renderHandover(unified);
    renderConfirm(unified);

    // 成功态：产物可下载可打印（PASS_WITH_WARN 也不得禁用）
    $('#btnExport').disabled = false;
    $('#btnPrint').disabled = false;

    if (R.risk && R.risk.totals) {
      var badgeRisk = $('#tabBadgeRisk');
      // 急单·无交期也算「要回电话」的单，一起进徽标；延期优先染红
      badgeRisk.textContent = (R.risk.totals.delayed || 0) + (R.risk.totals.atRisk || 0)
        + (R.risk.totals.urgentNoDue || 0);
      badgeRisk.className = 'tab-badge' + (R.risk.totals.delayed > 0 ? ' hot' : (R.risk.totals.atRisk > 0 ? ' info' : ''));
    }
    if (R.verify) {
      var badgeVerify = $('#tabBadgeVerify');
      badgeVerify.textContent = R.verify.hardViolations;
      badgeVerify.className = 'tab-badge' + (R.verify.hardViolations > 0 ? ' hot' : '');
    }
    if (R.health && R.health.counts) {
      var badgeHealth = $('#tabBadgeHealth');
      badgeHealth.textContent = R.health.counts.total;
      badgeHealth.className = 'tab-badge' + (R.health.counts.askCustomer > 0 ? ' info' : '');
    }

    switchTab('gantt');
  }

  /* ───────── F3 · 产物区 ─────────
     五件产物：排单表 / 甘特图 / 交期风险清单 / 数据体检 / 交接说明。
     本地模式这些是即时生成的 csv/md（点开即下载）；服务端模式优先后端给的 artifacts。 */
  var ARTIFACT_DEFS = [
    { key: 'orders', label: '周排单表', file: '01_周排程表.csv', hint: '打印贴墙用' },
    { key: 'gantt', label: '甘特图', file: '02_甘特图.html', hint: '断网可双击打开' },
    { key: 'risk', label: '交期风险清单', file: '03_交期风险清单.csv', hint: '回客户电话用' },
    { key: 'health', label: '数据体检报告', file: '04_数据体检报告.csv', hint: '哪些数不能用' },
    { key: 'handover', label: '交接说明', file: '05_交接说明.md', hint: '下周自己重跑' }
  ];

  function renderArtifacts(unified) {
    var box = $('#artifacts');
    var R = unified.R;
    var beArt = pickArtifacts(unified);

    var items = ARTIFACT_DEFS.map(function (d) {
      var be = beArt[d.key] || beArt[d.file] || null;
      // 服务端模式：后端说 available=false 或没有链接，就算没产出
      var has;
      if (unified.mode === 'server') has = !!(be && be.available && be.href);
      else has = !!be || canBuildLocal(unified, d.key);
      return { def: d, be: be, has: has };
    });

    var vtone = (R.verify && R.verify.result) || 'PASS';
    box.className = 'artifacts is-ok';
    box.innerHTML = '<div class="art-head">' +
      '<h3>本次产物</h3>' +
      '<span class="muted">共 ' + items.filter(function (x) { return x.has; }).length + ' 件</span>' +
      (vtone === 'PASS_WITH_WARN'
        ? '<span class="art-warnbar">硬约束 0 违反，可打印；流水条件未达成，须向客户说明代价</span>'
        : '') +
      '</div>' +
      '<div class="art-grid">' + items.map(function (it) {
        if (!it.has) {
          return '<div class="art-card is-off">' +
            '<div class="ac-name">' + esc(it.def.label) + '</div>' +
            '<div class="ac-note">暂无（本次未产出）</div></div>';
        }
        var href = it.be ? (it.be.href || it.be.url || it.be.path || '') : '';
        return '<div class="art-card">' +
          '<div class="ac-name">' + esc(it.def.label) + '</div>' +
          '<div class="ac-note">' + esc(it.def.hint) + '</div>' +
          '<div class="ac-actions">' +
          (href
            ? '<a class="ac-btn" href="' + esc(href) + '" download="' + esc(it.be.name || it.def.file) + '">下载</a>'
            : '<button class="ac-btn" type="button" data-art="' + esc(it.def.key) + '">下载</button>') +
          '</div></div>';
      }).join('') + '</div>';

    // 本地模式下点按钮即时生成
    $$('#artifacts .ac-btn[data-art]').forEach(function (b) {
      b.addEventListener('click', function () {
        downloadLocalArtifact(unified, b.getAttribute('data-art'));
      });
    });
  }

  function pickArtifacts(u) {
    var raw = u.raw || {};
    var a = raw.artifacts || raw.files || {};
    var m = {};
    if (Array.isArray(a)) {
      a.forEach(function (x) {
        if (!x) return;
        var entry = {
          name: x.name || x.title || '',
          href: x.downloadUrl || x.href || x.url || '',
          stale: !!x.stale,
          available: x.available !== false,
          title: x.title || x.name || '',
          desc: x.desc || ''
        };
        if (entry.name) m[entry.name] = entry;
        var sem = keyOfArtifact(entry.name);
        if (sem) m[sem] = entry;
      });
      return m;
    }
    Object.keys(a || {}).forEach(function (k) {
      var x = a[k] || {};
      m[k] = {
        name: x.name || k, href: x.downloadUrl || x.href || x.url || '',
        stale: !!x.stale, available: x.available !== false,
        title: x.title || k, desc: x.desc || ''
      };
    });
    return m;
  }

  /** 后端产物名 → 前端产物卡片的语义 key（真实契约：排单表.xlsx / 甘特图.html …） */
  function keyOfArtifact(name) {
    var n = str(name);
    if (/排单|排程表/.test(n)) return 'orders';
    if (/甘特/.test(n)) return 'gantt';
    if (/风险/.test(n)) return 'risk';
    if (/体检/.test(n)) return 'health';
    if (/交接/.test(n)) return 'handover';
    if (/需求确认/.test(n)) return 'confirm';
    if (/校验/.test(n)) return 'verify';
    return '';
  }

  function canBuildLocal(u, key) {
    // 服务端模式：只认后端给的产物（有 href 才算有）
    if (u.mode === 'server') return !!(u.R && u.R.verify);
    if (key === 'handover') return !!(u.handover && !u.handover.fileOnly);
    return !!(u.R && u.R.verify);
  }

  function downloadLocalArtifact(u, key) {
    var R = u.R;
    var text = '', name = '';
    if (key === 'orders') { text = csvOperations(R); name = '01_周排程表.csv'; }
    else if (key === 'risk') { text = csvRisk(R); name = '03_交期风险清单.csv'; }
    else if (key === 'health') { text = csvHealth(R); name = '04_数据体检报告.csv'; }
    else if (key === 'handover') { text = handoverMarkdown(u); name = '05_交接说明.md'; }
    else if (key === 'gantt') {
      text = ganttStandaloneHtml(R); name = '02_甘特图.html';
      download(name, text, 'text/html;charset=utf-8');
      return;
    }
    if (!text) return;
    download(name, '\ufeff' + text);
  }

  /** 交接说明导出 md：内容全部来自后端返回，前端只拼标题与时间 */
  function handoverMarkdown(u) {
    if (!u.handover) return '';
    var H = u.handover;
    var L = [];
    L.push('# 交接说明');
    L.push('');
    L.push('> ' + '换了一周的台账，这份说明里的参数和假设要跟着重跑才会更新');
    L.push('');
    L.push('- 数据源：' + (u.sourceFile || '—'));
    L.push('- 生成时间：' + fmtTime(u.generatedAt));
    L.push('');
    if (H.intro) { L.push(H.intro); L.push(''); }
    H.sections.forEach(function (s) {
      L.push('## ' + s.title);
      L.push('');
      L.push(renderBlockText(s.body));
      L.push('');
    });
    return L.join('\n');
  }

  function ganttStandaloneHtml(R) {
    var wrap = $('#gantt');
    var css = '';
    try { css = $('#ganttCss') ? '' : ''; } catch (e) { css = ''; }
    return '<!DOCTYPE html><meta charset="utf-8"><title>甘特图</title>' +
      '<style>body{font-family:sans-serif;padding:20px;background:#f5f7fa}' +
      '.gantt-canvas{border:1px solid #e3e8ef;border-radius:9px;overflow:auto;background:#fff}' +
      '</style>' + (wrap ? wrap.innerHTML : '<p>无甘特数据</p>');
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
    // 耗时取整：后端 elapsed_ms 是浮点（如 161.30000000074506），直接显示会露一长串小数
    var ms = R.__wall || R.meta.elapsed;
    ms = (ms == null || ms === '') ? '' : (' · ' + Math.round(Number(ms)) + ' ms');
    var side = '已排 ' + R.meta.counts.opsPlanned + ' / ' + R.meta.counts.opsTotal + ' 道'
      + ' · 规则「' + esc(R.meta.ruleCn || '—') + '」' + ms;
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
    // 后端模式可能只给 operations、不给前端用的 gantt 结构 → 降级为空态，不抛错
    if (!G || !G.days || !G.machines) {
      $('#gantt').innerHTML = '<div class="empty"><span class="empty-icon">▦</span>' +
        '本次结果没有甘特图数据。' +
        '<br><span class="muted">服务端模式请在产物区下载「甘特图.html」查看；离线模式会在这里直接绘制。</span></div>';
      return;
    }
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
      { key: 'urgent_no_due', label: '🟠 急单·无交期', n: t.urgentNoDue },
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
        '<td class="wrap risk-suggestion">' + esc(r.suggestion) + '</td>' +
        '</tr>';
    }).join('');

    $('#riskTable').innerHTML = list.length
      ? '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>' +
        '<div class="table-foot">' +
        '<span>合计 <b>' + rows.length + '</b> 张</span>' +
        '<span>延期 <b>' + t.delayed + '</b></span>' +
        '<span>预警 <b>' + t.atRisk + '</b></span>' +
        '<span>急单·无交期 <b>' + (t.urgentNoDue || 0) + '</b></span>' +
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

  /* ───────── 校验（分组展示，与 out/校验报告.txt 同格式） ─────────
     本函数只读 R.verify 里已经算好的 groups / lines / flowNote，
     不重算、不判断 gap，也不改变任何按钮状态。 */
  function renderVerify(R) {
    var V = R.verify;
    var groups = V.groups || [];

    $('#verifySummary').textContent = '总体：' + (V.resultCn || V.result) +
      ' · 硬约束 0 违反 ' + (V.hardViolations === 0 ? '✓' : '✗ ' + V.hardViolations) +
      (V.softViolations ? ' · 流水条件未达成 ' + V.softViolations + ' 个批次' : '');

    if (!groups.length) {
      $('#verifyBody').innerHTML = '<div class="empty"><span class="empty-icon">✓</span>没有可展示的校验项。</div>';
      return;
    }

    $('#verifyBody').innerHTML = '<div class="health-grid">' + groups.map(function (g) {
      var head = '<div class="hgroup-head">' +
        '<span class="sev ' + (g.ok ? 'info' : (g.key === 'hard' ? 'block' : 'warn')) + '"></span>' +
        '<h4>' + esc(g.title) + '</h4>' +
        '<span class="count">' + esc(g.note) + '</span>' +
        '<span class="askflag ' + (g.ok ? 'ok' : '') + '">' +
        (g.ok ? '✓ 通过' : '✗ ' + g.failCount + ' 项未达成') + '</span>' +
        '</div>';

      var items = g.lines.map(function (l) {
        var vs = (l.violations || []).map(function (v) {
          return '<div class="hitem">' +
            '<div class="hitem-loc">' + esc(l.code) + '</div>' +
            '<div class="hitem-body"><div class="sym">' + esc(v.text) + '</div></div>' +
            '</div>';
        }).join('');
        var skip = (l.skipped || []).map(function (s) {
          return '<div class="hitem">' +
            '<div class="hitem-loc">' + esc(l.code) + ' 跳过</div>' +
            '<div class="hitem-body"><div class="sym muted">' + esc(s.text) + '</div></div>' +
            '</div>';
        }).join('');
        return '<div class="hitem">' +
          '<div class="hitem-loc">' + esc(l.code) + '</div>' +
          '<div class="hitem-body">' +
          '<div class="sym">' + (l.ok ? '<span class="pill ok">✓</span> ' : '<span class="pill delayed">✗</span> ') +
          '<b>' + esc(l.name) + '</b>　<span class="muted">' + esc(l.detail) + '</span></div>' +
          '</div></div>' + vs + skip;
      }).join('');

      /* H5 有违规时，在该分组下加一句固定说明（文案来自 engine.js 的 flowNote） */
      var note = (g.key === 'flow' && !g.ok && V.flowNote)
        ? '<div class="verify-note">' + esc(V.flowNote) + '</div>'
        : '';

      return '<div class="hgroup">' + head + '<div class="hitems">' + items + '</div>' + note + '</div>';
    }).join('') + '</div>';
  }

  /* ───────── F1 · 交接说明面板 ─────────
     内容全部来自 unified.handover（后端返回），前端只排版。
     缺字段 → 面板显示「暂无」，不抛错。 */
  function renderBlockText(body) {
    if (body == null) return '';
    if (Array.isArray(body)) {
      return body.map(function (x) { return '- ' + str(x); }).join('\n');
    }
    if (typeof body === 'object') {
      return Object.keys(body).map(function (k) { return '- ' + k + '：' + str(body[k]); }).join('\n');
    }
    return str(body);
  }

  /** 极简 markdown：只支持 **粗体**、`代码`、- 列表、换行。不引任何库。 */
  function miniMarkdown(text) {
    var lines = str(text).split(/\r?\n/);
    var out = [], inList = false;
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push('');
        return;
      }
      var isLi = /^\s*[-*·]\s+/.test(line);
      if (isLi) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(line.replace(/^\s*[-*·]\s+/, '')) + '</li>');
        return;
      }
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<p>' + inline(line) + '</p>');
    });
    if (inList) out.push('</ul>');
    return out.join('\n');
  }

  function inline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function renderHandover(u) {
    var H = u.handover;
    var bodyEl = $('#handoverBody');
    var metaEl = $('#handoverMeta');
    var toggle = $('#btnHandoverToggle');

    if (!H) {
      metaEl.textContent = '';
      toggle.hidden = true;
      bodyEl.innerHTML = '<div class="empty"><span class="empty-icon">—</span>' +
        '暂无交接说明内容（后端未返回 handover 字段）。' +
        '<br><span class="muted">本地离线模式不产出交接说明；联机模式下由后端生成。</span></div>' +
        '<div class="caliber-note" style="margin-top:14px">换了一周的台账，这份说明里的参数和假设要跟着重跑才会更新</div>';
      return;
    }

    // 真实后端契约：handover 只是产物描述，正文在那个 md 文件里。
    // F3 要求「该段落在面板里正常显示」→ 主动取回 md 正文再渲染，而不是只给下载链接。
    if (H.fileOnly) {
      metaEl.textContent = '正在载入正文…';
      toggle.hidden = true;
      bodyEl.innerHTML =
        '<div class="ho-intro" id="hoLoading">正在从服务端载入交接说明正文…</div>' +
        '<div class="ho-downloads">' +
        (H.files.md
          ? '<a class="btn btn-ghost btn-sm" href="' + esc(H.files.md) + '" download>下载交接说明（md）</a>'
          : '') +
        '</div>';
      loadHandoverText(H.files.md, bodyEl, metaEl, u);
      return;
    }

    metaEl.textContent = '共 ' + H.sections.length + ' 段';
    toggle.hidden = false;

    var secs = H.sections.map(function (s, i) {
      return '<details class="ho-sec" ' + (i === 0 ? 'open' : '') + '>' +
        '<summary>' + esc(s.title) + '</summary>' +
        '<div class="ho-body">' + miniMarkdown(renderBlockText(s.body)) + '</div>' +
        '</details>';
    }).join('');

    bodyEl.innerHTML =
      (H.intro ? '<div class="ho-intro">' + miniMarkdown(H.intro) + '</div>' : '') +
      secs +
      '<div class="ho-downloads">' +
      '<button class="btn btn-ghost btn-sm" type="button" id="btnHoMd">下载交接说明（md）</button>' +
      (hasHandoverHtml(u)
        ? '<a class="btn btn-ghost btn-sm" id="btnHoHtml" href="' + esc(handoverHtmlHref(u)) + '" target="_blank" rel="noopener">下载 / 打印（html）</a>'
        : '') +
      '</div>';

    var md = $('#btnHoMd');
    if (md) md.addEventListener('click', function () { download('05_交接说明.md', '\ufeff' + handoverMarkdown(u)); });

    if (toggle.getAttribute('data-bound') !== '1') {
      toggle.setAttribute('data-bound', '1');
      toggle.addEventListener('click', function () {
        var anyOpen = $$('#handoverBody .ho-sec[open]').length > 0;
        $$('#handoverBody .ho-sec').forEach(function (d) { d.open = !anyOpen; });
      });
    }
  }

  /**
   * 从后端取回交接说明 md 正文并渲染。
   * 只做「取文本 + 按标题切段 + 简易 markdown」，不生成任何内容。
   * 取不到就退回「下载查看」，不抛错、不白屏。
   */
  function loadHandoverText(href, bodyEl, metaEl, u) {
    if (!href) {
      metaEl.textContent = '';
      bodyEl.innerHTML = '<div class="empty"><span class="empty-icon">—</span>' +
        '后端未提供交接说明下载链接。</div>';
      return;
    }
    fetch(href, { method: 'GET' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (md) {
        var sections = splitMarkdownSections(md);
        if (!sections.length) {
          // 没有二级标题就整段显示，别丢内容
          sections = [{ title: '交接说明', body: md }];
        }
        metaEl.textContent = '共 ' + sections.length + ' 段';
        var toggle = $('#btnHandoverToggle');
        if (toggle) toggle.hidden = false;

        bodyEl.innerHTML =
          sections.map(function (s, i) {
            return '<details class="ho-sec" ' + (i === 0 ? 'open' : '') + '>' +
              '<summary>' + esc(s.title) + '</summary>' +
              '<div class="ho-body">' + miniMarkdown(s.body) + '</div>' +
              '</details>';
          }).join('') +
          '<div class="ho-downloads">' +
          '<a class="btn btn-ghost btn-sm" href="' + esc(href) + '" download>下载交接说明（md）</a>' +
          '</div>';

        if (toggle && toggle.getAttribute('data-bound') !== '1') {
          toggle.setAttribute('data-bound', '1');
          toggle.addEventListener('click', function () {
            var anyOpen = $$('#handoverBody .ho-sec[open]').length > 0;
            $$('#handoverBody .ho-sec').forEach(function (d) { d.open = !anyOpen; });
          });
        }
      })
      .catch(function (e) {
        metaEl.textContent = '';
        bodyEl.innerHTML = '<div class="empty"><span class="empty-icon">—</span>' +
          '正文载入失败（' + esc(e.message || '网络错误') + '）。' +
          '<br><span class="muted">可直接下载交接说明查看。</span></div>' +
          '<div class="ho-downloads"><a class="btn btn-ghost btn-sm" href="' + esc(href) + '" download>下载交接说明（md）</a></div>';
      });
  }

  /** 按 markdown 二级标题（## / ### 中文序号）切段；标题行作为段落名 */
  function splitMarkdownSections(md) {
    var lines = str(md).split(/\r?\n/);
    var out = [], cur = null;
    lines.forEach(function (ln) {
      var m = ln.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*$/);
      if (m) {
        if (cur && cur.body.trim()) out.push(cur);
        cur = { title: m[2].replace(/[*`]/g, '').trim(), body: '' };
        return;
      }
      if (!cur) cur = { title: '概述', body: '' };
      cur.body += ln + '\n';
    });
    if (cur && cur.body.trim()) out.push(cur);
    // 去掉空标题段的空行
    return out.filter(function (s) { return s.title || s.body.trim(); });
  }
  function hasHandoverHtml(u) {
    var raw = u.raw || {};
    var h = raw.handover || {};
    var f = h.files || h.artifacts || {};
    return !!(f.html || f.html_href || h.html || h.html_href);
  }

  function handoverHtmlHref(u) {
    var raw = u.raw || {};
    var h = raw.handover || {};
    var f = h.files || h.artifacts || {};
    return f.html || f.html_href || h.html || h.html_href || '';
  }

  /* ───────── F2 · 需求确认面板 ─────────
     四块内容全部来自后端；未确认事项用警示色条。
     任何情况下都不改动按钮状态。 */
  function renderConfirm(u) {
    var C = u.confirm;
    var U = u.unconfirmed || { confirmed: null, items: [] };
    var bodyEl = $('#confirmBody');
    var metaEl = $('#confirmMeta');

    renderCaliberNote(u);

    if (!C) {
      metaEl.textContent = '';
      bodyEl.innerHTML = '<div class="empty"><span class="empty-icon">—</span>' +
        '暂无需求确认单（后端未返回 confirm 字段）。' +
        '<br><span class="muted">本地离线模式不产出需求确认单；联机模式下由后端生成。</span></div>';
      return;
    }

    // 真实后端契约：confirm 只是产物描述，四块内容在「需求确认单.md」里
    if (C.fileOnly) {
      metaEl.textContent = '正文见文件';
      bodyEl.innerHTML =
        '<div class="cf-block">' +
        '<h4>需求确认单</h4>' +
        '<div id="cfLoading" class="cf-none">正在从服务端载入需求确认单正文…</div>' +
        '<div class="ho-downloads">' +
        (C.file && C.file.md
          ? '<a class="btn btn-ghost btn-sm" href="' + esc(C.file.md) + '" download>下载需求确认单（md）</a>'
          : '<span class="muted">后端未给下载链接</span>') +
        '</div></div>' +
        (U.items && U.items.length
          ? '<div class="cf-block"><h4>未确认事项（' + U.items.filter(function (x) { return !x.signed; }).length + ' 条）</h4>' +
            U.items.filter(function (x) { return !x.signed; }).map(function (it) {
              return '<div class="cf-warn"><span class="cw-label">' + esc(it.label) + '</span>' +
                '<span class="cw-tail">' + esc(it.effective || '已按此口径计算') + '</span></div>';
            }).join('') + '</div>'
          : '');
      // 正文同样取回来渲染（与交接说明一致的做法）
      if (C.file && C.file.md) {
        fetch(C.file.md, { method: 'GET' })
          .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
          .then(function (md) {
            var secs = splitMarkdownSections(md);
            var html = secs.map(function (s, i) {
              return '<details class="ho-sec" ' + (i === 0 ? 'open' : '') + '>' +
                '<summary>' + esc(s.title) + '</summary>' +
                '<div class="ho-body">' + miniMarkdown(s.body) + '</div></details>';
            }).join('');
            var node = $('#cfLoading');
            if (node) node.outerHTML = html || '<div class="cf-none">正文为空</div>';
            metaEl.textContent = '共 ' + secs.length + ' 段';
          })
          .catch(function (e) {
            var node = $('#cfLoading');
            if (node) node.textContent = '正文载入失败（' + (e.message || '网络错误') + '），可下载查看。';
          });
      }
      return;
    }

    var signedAll = U.confirmed === true;
    metaEl.textContent = signedAll ? '客户已签字确认' : '存在未确认事项';

    var blocks = [];

    blocks.push('<div class="cf-block">' +
      '<h4>我理解的三件事</h4>' +
      (C.understanding.length
        ? '<ul class="cf-list">' + C.understanding.map(function (x) { return '<li>' + inline(str(x)) + '</li>'; }).join('') + '</ul>'
        : '<div class="cf-none">暂无</div>') +
      '</div>');

    blocks.push('<div class="cf-block">' +
      '<h4>客户不要的</h4>' +
      (C.notWanted.length
        ? '<ul class="cf-list">' + C.notWanted.map(function (x) { return '<li>' + inline(str(x)) + '</li>'; }).join('') + '</ul>'
        : '<div class="cf-none">暂无</div>') +
      '</div>');

    blocks.push('<div class="cf-block">' +
      '<h4>问答（共 ' + C.qa.length + ' 条）</h4>' +
      (C.qa.length
        ? '<div class="table-wrap"><table class="cf-table"><thead><tr><th style="width:38%">问</th><th>答复</th></tr></thead><tbody>' +
          C.qa.map(function (q) {
            return '<tr><td class="wrap">' + inline(q.q || '—') + '</td><td class="wrap">' +
              (q.a ? inline(q.a) : '<span class="muted">未答复</span>') + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="cf-none">暂无</div>') +
      '</div>');

    // 未确认事项：醒目警示色条
    var uItems = (U.items || []).filter(function (x) { return !x.signed; });
    var uCount = uItems.length;
    blocks.push('<div class="cf-block">' +
      '<h4>未确认事项' + (uCount ? '（' + uCount + ' 条）' : '') + '</h4>' +
      (uCount
        ? uItems.map(function (it) {
            var tail = it.effective ? ' · ' + it.effective : ' · 已按此口径计算';
            return '<div class="cf-warn">' +
              '<span class="cw-label">' + esc(it.label) + '</span>' +
              '<span class="cw-tail">' + esc(tail) + '</span>' +
              '</div>';
          }).join('')
        : '<div class="cf-none ok">没有未确认事项' + (U.confirmed === true ? '（客户已确认）' : '') + '</div>') +
      '</div>');

    bodyEl.innerHTML = blocks.join('');
  }

  /** 产能区口径小字：显示与否由后端 unconfirmed.confirmed 驱动，前端不写死 */
  function renderCaliberNote(u) {
    var el = $('#caliberNote');
    if (!el) return;
    var U = u.unconfirmed || {};
    var items = (U.items || []).filter(function (x) { return !x.signed; });
    var needShow = (U.confirmed === false) || (U.confirmed == null && items.length > 0);

    if (needShow) {
      var flowItem = items.filter(function (x) { return /流水|间隔|30/.test(x.label); })[0];
      var caliber = flowItem ? (flowItem.label + ' 口径') : '当前口径';
      el.hidden = false;
      el.innerHTML = '此缺口在「' + esc(caliber) + '」口径下算出；若客户确认口径不同，此数会变';
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
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
    // 注意：这里不检查 verify.result。H5 未达成（PASS_WITH_WARN）不得阻断下载，
    // 只有硬约束 FAIL 时也照常允许导出——拦截职责在用人一方，不在展示层。
    var files = {
      '01_周排程表.csv': csvOperations(R),
      '02_交期风险清单.csv': csvRisk(R),
      '03_校验报告.csv': csvVerify(R),
      '04_数据体检报告.csv': csvHealth(R),
      '05_产能核对.csv': csvCapacity(R)
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

  /** 校验报告：与 out/校验报告.txt 的两个分组同名同序，纯展示用 */
  function csvVerify(R) {
    var V = R.verify;
    var rows = [['分组', '编号', '校验项', '结果', '明细', '未达成/违规']];
    (V.groups || []).forEach(function (g) {
      g.lines.forEach(function (l) {
        rows.push([
          g.title, l.code, l.name,
          l.ok ? '通过' : '未达成',
          l.detail,
          (l.violations || []).map(function (v) { return v.text; }).join('；')
        ]);
      });
      if (g.key === 'flow' && !g.ok && V.flowNote) {
        rows.push(['', '', '说明', '', V.flowNote, '']);
      }
    });
    rows.push(['总体结论', '', '', V.result, V.resultCn || '', '']);
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

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ═══════════ 初始化 ═══════════ */
  // 先探测后端：http 打开且服务在线 → 走后端；否则走本地 engine。
  // 探测失败不阻塞页面，直接按本地模式起。
  state.useServer = false;
  if (window.APSData) {
    APSData.probe().then(function (r) {
      state.useServer = !!r.online;
      var mode = $('#footMode');
      if (mode) mode.textContent = r.online ? '服务端模式' : '本地离线模式';
    }).catch(function () { state.useServer = false; });
  }
  syncSegs();
  updateParamline();
  setStatus('请先选择台账文件', 'idle');
  $('#footStamp').textContent = '窗口口径：两班 8h / 周日不排 / 交期 17:00';

  // 延迟到打印时再算页码之类的（不做复杂排版，A4 横向由 CSS 控制）
})();
