/*!
 * 宏达精密 · 本地排产助手 — 排程引擎（纯 JS，无第三方依赖）
 * ---------------------------------------------------------------
 * 职责：台账三个 sheet → 清洗 → 实例 → 排程 → 校验 → 汇总
 * 口径（手册 §3.4 / 设计文档 §0）：
 *   P1 默认 = 严格尊重点名（磨只用 GRD-01）、CNC-03 停机不可用、LAT-03 三班按两班算
 * 单位：排程内部一律用「轴分钟」（第 0 分钟 = 窗口首日 08:00），落盘才转挂钟。
 * 用法：
 *   Node  : const E = require('./engine.js'); E.run(sheets, opts)
 *   浏览器: window.ApsEngine.run(sheets, opts)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ApsEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ═══════════════════════════ 0. 常量与基础工具 ═══════════════════════════ */

  var DAY_MS = 86400000;
  var MIN_PER_DAY = 960;      // 两班 8h = 16h = 960 min（08:00–24:00）
  var SHIFT_MIN = 480;
  var ORIGIN_HOUR = 8;
  var DUE_HOUR = 17;          // 交期口径：当日 17:00
  var WINDOW_DAYS = 6;        // 本周窗口：周一 ~ 周六，周日不排
  var WEEK_OFF = 0;           // 周日

  /** 1970-01-01 是周四 → 0=周日，1=周一 … */
  function dow(dayNum) { return ((dayNum % 7) + 11) % 7; }

  function ymdToNum(y, m, d) { return Math.round(Date.UTC(y, m - 1, d) / DAY_MS); }

  function numToYmd(n) {
    var t = new Date(n * DAY_MS);
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** dayNum → 'YYYY-MM-DD' */
  function fmtDate(n) {
    if (n === null || n === undefined) return '—';
    var a = numToYmd(n);
    return a[0] + '-' + pad2(a[1]) + '-' + pad2(a[2]);
  }

  /** dayNum → 'MM-DD' */
  function fmtMd(n) {
    if (n === null || n === undefined) return '—';
    var a = numToYmd(n);
    return pad2(a[1]) + '-' + pad2(a[2]);
  }

  var DOW_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtDateCn(n) { return fmtDate(n) + '（' + DOW_CN[dow(n)] + '）'; }

  function str(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/\u00a0/g, ' ').trim();
  }

  function isBlank(v) { return str(v) === ''; }

  /** 宽松数字：'40' / 40 / '40 件' → 40；无法解析 → null */
  function toNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    var s = str(v).replace(/[，,\s]/g, '');
    if (!s) return null;
    var m = s.match(/^-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  /** 四舍五入到整数分钟 */
  function r0(x) { return Math.floor(x + 0.5); }

  /* ═══════════════════════════ 1. 日历（工作日轴） ═══════════════════════════ */

  /**
   * 工作日日历：从 startNum 起，跳过周日，无限向后延伸。
   * 轴：第 i 个工作日的 08:00 = i × 960 分钟
   */
  function makeCalendar(startNum) {
    var days = [];
    return {
      start: startNum,
      /** 第 i 个工作日（i >= 0），自动向后扩展 */
      dayAt: function (i) {
        while (days.length <= i) {
          var c = days.length === 0 ? startNum : days[days.length - 1] + 1;
          while (dow(c) === WEEK_OFF) c++;
          days.push(c);
        }
        return days[i];
      },
      /** dayNum → 工作日序号（可能为负；非工作日返回 null） */
      indexOf: function (dayNum) {
        if (dayNum === null || dayNum === undefined) return null;
        if (dow(dayNum) === WEEK_OFF) return null;
        var guard = 0;
        if (dayNum >= startNum) {
          for (var i = 0; guard < 400; i++, guard++) {
            var d = this.dayAt(i);
            if (d === dayNum) return i;
            if (d > dayNum) return null;
          }
        } else {
          var j = -1, c = startNum;
          for (; guard < 400; j--, guard++) {
            do { c--; } while (dow(c) === WEEK_OFF);
            if (c === dayNum) return j;
            if (c < dayNum) return null;
          }
        }
        return null;
      },
      /** 取 >= dayNum 的第一个工作日序号（物料到货等原因，落在周日时顺延） */
      indexOnOrAfter: function (dayNum) {
        var c = dayNum;
        while (dow(c) === WEEK_OFF) c++;
        return this.indexOf(c);
      },
      /** 轴分钟 → 挂钟 'YYYY-MM-DDTHH:MM' */
      toWall: function (axis) {
        var i = Math.floor(axis / MIN_PER_DAY);
        var inDay = axis - i * MIN_PER_DAY;
        var clock = ORIGIN_HOUR * 60 + inDay;
        var d = this.dayAt(Math.max(0, i));
        if (i < 0) d = this.dayAt(0) - (0 - i) * 2;
        var hh = Math.floor(clock / 60), mm = Math.round(clock % 60);
        // 24:00 归到当日末，避免出现 24:xx
        if (hh >= 24) { hh -= 24; mm = 0; }
        return fmtDate(d) + 'T' + pad2(hh) + ':' + pad2(mm);
      },
      /** 轴分钟 → {date, time, dayIndex} */
      toClock: function (axis) {
        var i = Math.floor(axis / MIN_PER_DAY);
        var inDay = axis - i * MIN_PER_DAY;
        var clock = ORIGIN_HOUR * 60 + inDay;
        var d = this.dayAt(Math.max(0, i));
        var hh = Math.floor(clock / 60), mm = Math.round(clock % 60);
        if (hh >= 24) { hh -= 24; mm = 0; }
        return { date: fmtDate(d), md: fmtMd(d), time: pad2(hh) + ':' + pad2(mm), dayIndex: i };
      },
      /** 挂钟时刻用于"完工跨班"显示：'HH:MM' */
      clock: function (axis) {
        if (axis === null || axis === undefined) return '—';
        var i = Math.floor(axis / MIN_PER_DAY);
        var inDay = axis - i * MIN_PER_DAY;
        var clock = ORIGIN_HOUR * 60 + inDay;
        var hh = Math.floor(clock / 60), mm = Math.round(clock % 60);
        if (hh >= 24) { hh -= 24; mm = 0; }
        return pad2(hh) + ':' + pad2(mm);
      }
    };
  }

  /* ═══════════════════════════ 2. 三个 sheet 的表头定位与读取 ═══════════════════════════ */

  var ALIAS = {
    orderId: ['单号', '订单号', '订单编号', '工单号'],
    customer: ['客户', '客户名称'],
    orderDate: ['接单日期', '下单日期', '订单日期'],
    due: ['交期', '交货期', '要求交期', '交期日期'],
    product: ['产品', '产品名称', '品名'],
    qty: ['数量', '订单数量'],
    remark: ['备注', '说明'],
    machineId: ['编号', '设备号', '设备编号', '机床号'],
    machineNo: ['设备号'],
    model: ['型号', '设备型号'],
    ops: ['可做工序', '工序', '加工工序'],
    shifts: ['每日班次', '班次'],
    status: ['状态', '设备状态'],
    productRoute: ['产品'],
    routeTotal: ['单件工时合计', '合计', '单件工时']
  };

  /** 在一行单元格里找某个字段的列号（按别名，唯一命中才算） */
  function findCol(headerRow, aliases) {
    for (var a = 0; a < aliases.length; a++) {
      var key = aliases[a];
      for (var c = 0; c < headerRow.length; c++) {
        if (str(headerRow[c]).replace(/\s/g, '') === key) return c;
      }
    }
    return -1;
  }

  /** 在前若干行里找表头行：命中所给关键字段最多的一行（至少命中 1 个） */
  function locateHeader(rows, required, limit) {
    var best = { row: -1, score: 0 };
    var top = Math.min(rows.length, limit || 6);
    for (var r = 0; r < top; r++) {
      var row = rows[r] || [];
      var score = 0;
      for (var i = 0; i < required.length; i++) {
        if (findCol(row, ALIAS[required[i]]) >= 0) score++;
      }
      if (score > best.score) best = { row: r, score: score };
    }
    return best.score >= 1 ? best.row : -1;
  }

  /** 把 rows 转成 [{字段名: 值}] —— 按表头名取列，不用列索引 */
  function tableize(rows, headerRow, fieldMap) {
    var header = rows[headerRow] || [];
    var cols = {};
    Object.keys(fieldMap).forEach(function (k) { cols[k] = findCol(header, ALIAS[fieldMap[k]]); });
    var out = [];
    for (var r = headerRow + 1; r < rows.length; r++) {
      var row = rows[r] || [];
      var obj = { __row: r + 1, __raw: row };
      var any = false;
      Object.keys(cols).forEach(function (k) {
        var c = cols[k];
        obj[k] = c >= 0 ? row[c] : null;
        if (!isBlank(obj[k])) any = true;
      });
      obj.__any = any;
      out.push(obj);
    }
    return { cols: cols, rows: out };
  }

  /* ═══════════════════════════ 3. 日期 / 交期 / 单号解析 ═══════════════════════════ */

  /** 解析各种写法的日期 → {dayNum, level, kind} */
  function parseDate(raw, ctxYear) {
    var s = str(raw);
    if (!s) return { dayNum: null, level: 'none', kind: 'empty' };

    // Excel 序列号
    if (typeof raw === 'number' && raw > 20000 && raw < 80000) {
      return { dayNum: Math.round(raw) - 25569, level: 'exact', kind: 'serial' };
    }

    var m = s.match(/(\d{4})\s*[-\/.年]\s*(\d{1,2})\s*[-\/.月]\s*(\d{1,2})/);
    if (m) {
      return { dayNum: ymdToNum(+m[1], +m[2], +m[3]), level: 'exact', kind: 'date' };
    }
    // 11月12日 / 11月12号 / 11.12
    m = s.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?$/);
    if (m) {
      return { dayNum: ymdToNum(ctxYear, +m[1], +m[2]), level: 'exact', kind: 'cn-date' };
    }
    m = s.match(/^(\d{1,2})\s*[-\/.]\s*(\d{1,2})$/);
    if (m) {
      return { dayNum: ymdToNum(ctxYear, +m[1], +m[2]), level: 'exact', kind: 'md' };
    }
    // Excel 里的真日期（Date 对象）
    if (raw instanceof Date && !isNaN(raw)) {
      return { dayNum: Math.round(raw.getTime() / DAY_MS), level: 'exact', kind: 'date-obj' };
    }
    return { dayNum: null, level: 'none', kind: 'unparsed' };
  }

  /** 交期专用：还要识别「尽快 / 月底前 / 空白」这类人话 */
  function parseDue(raw, ctx) {
    var s = str(raw);
    if (!s) return { dayNum: null, level: 'none', kind: 'empty' };
    if (/尽快|越早越好|ASAP|急/i.test(s) && !/\d/.test(s)) {
      return { dayNum: null, level: 'none', kind: 'asap' };
    }
    if (/月底|月末/.test(s)) {
      var y = ctx.year, mo = ctx.month;
      var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      return { dayNum: ymdToNum(y, mo, last), level: 'inferred', kind: 'monthend' };
    }
    if (/下周/.test(s)) {
      return { dayNum: ctx.startNum + 7, level: 'inferred', kind: 'nextweek' };
    }
    if (/本周|这周/.test(s)) {
      return { dayNum: ctx.startNum + 5, level: 'inferred', kind: 'thisweek' };
    }
    return parseDate(raw, ctx.year);
  }

  /** 单号归一：HD-2026-101 / HD2026102 / 104 → HD-2026-101 形式 */
  function normalizeId(raw, defaultYear) {
    var s = str(raw).toUpperCase().replace(/\s/g, '');
    if (!s) return { id: '', changed: false };
    var m = s.match(/^([A-Z]{1,4})-?(\d{4})-?(\d{1,4})(-[A-Z]\d+)?$/);
    if (m) {
      var id = m[1] + '-' + m[2] + '-' + ('000' + m[3]).slice(-3) + (m[4] || '');
      return { id: id, changed: id !== str(raw).trim() };
    }
    m = s.match(/^(\d{1,4})(-[A-Z]\d+)?$/);
    if (m) {
      var id2 = 'HD-' + defaultYear + '-' + ('000' + m[1]).slice(-3) + (m[2] || '');
      return { id: id2, changed: true };
    }
    return { id: str(raw).trim(), changed: false };
  }

  /* ═══════════════════════════ 4. 清洗 ═══════════════════════════ */

  function newIssues() { return []; }

  function addIssue(list, o) {
    list.push({
      code: o.code || '',
      sheet: o.sheet || '',
      locator: o.locator || '',
      symptom: o.symptom || '',
      handling: o.handling || '',
      askCustomer: !!o.askCustomer,
      severity: o.severity || 'info'   // info | warn | block
    });
  }

  /** 主清洗：三个 sheet → {orders, blocked, machines, routes, issues, meta} */
  function clean(sheets, opts) {
    var issues = newIssues();
    var year = opts.year || 2026;

    /* ---- 订单 ---- */
    var orderRows = sheets['订单'] || sheets['订单表'] || sheets[Object.keys(sheets)[0]];
    var oh = locateHeader(orderRows, ['orderId', 'product', 'qty'], 6);
    if (oh < 0) throw makeErr('表头不对', '在「订单」工作表中找不到「单号/产品/数量」表头（前 6 行）');
    var tOrder = tableize(orderRows, oh, {
      id: 'orderId', customer: 'customer', orderDate: 'orderDate',
      due: 'due', product: 'product', qty: 'qty', remark: 'remark'
    });

    // 整理日：先从标题里找日期，找不到用最大接单日
    var titleText = (orderRows[0] || []).map(str).join(' ');
    var titleDate = parseDate(titleText.match(/\d{4}\s*[-\/.]\s*\d{1,2}\s*[-\/.]\s*\d{1,2}/) ? titleText.match(/\d{4}\s*[-\/.]\s*\d{1,2}\s*[-\/.]\s*\d{1,2}/)[0] : '', year);

    var parsed = [];
    tOrder.rows.forEach(function (r) {
      if (!r.__any) return;
      var pid = str(r.id), prod = str(r.product), qty = toNum(r.qty), dueRaw = str(r.due);
      // 注释行：无产品、无数量、单号以「注」开头或整行只有一句话
      if (!prod && qty === null) {
        addIssue(issues, {
          code: 'NOTE_ROW', sheet: '订单', locator: '订单!A' + r.__row, severity: 'info',
          symptom: '第 ' + r.__row + ' 行是注释/说明行，不是订单：' + (pid || str(r.customer)).slice(0, 40),
          handling: '跳过，不计入订单行数'
        });
        return;
      }
      parsed.push(r);
    });

    var ordersTotal = parsed.length;

    /* 先定年份与整理日 */
    var orderDates = parsed.map(function (r) { return parseDate(r.orderDate, year).dayNum; }).filter(function (x) { return x !== null; });
    var bizDay = titleDate.dayNum;
    if (bizDay === null) {
      bizDay = orderDates.length ? Math.max.apply(null, orderDates) : ymdToNum(year, 11, 1);
      addIssue(issues, {
        code: 'BIZ_DATE_INFER', sheet: '订单', locator: '订单!A1', severity: 'warn', askCustomer: true,
        symptom: '标题里没有整理日期，按最大接单日 ' + fmtDate(bizDay) + ' 推断',
        handling: '推断，影响窗口起点；需与计划员确认'
      });
    }
    var ctx = { year: year, month: numToYmd(bizDay)[1], startNum: bizDay };

    /* ---- 设备 ---- */
    var machRows = sheets['设备'] || sheets['设备表'];
    if (!machRows) throw makeErr('缺少工作表', '台账里没有「设备」工作表');
    var mh = locateHeader(machRows, ['machineId', 'ops', 'status'], 6);
    if (mh < 0) throw makeErr('表头不对', '在「设备」工作表中找不到「编号/可做工序/状态」表头');
    var tMach = tableize(machRows, mh, {
      no: 'machineNo', id: 'machineId', model: 'model', ops: 'ops', shifts: 'shifts', status: 'status'
    });

    var machines = [];
    tMach.rows.forEach(function (r) {
      if (!r.__any) return;
      var id = str(r.id) || str(r.no);
      if (!id) return;
      var ops = str(r.ops).split(/[、,，\/;；]/).map(str).filter(Boolean);
      var sh = toNum(r.shifts);
      var raw = str(r.status);
      var status = 'available';
      if (/停机|维修|故障|停用/.test(raw)) status = 'down';
      else if (/闲置|空闲|备用/.test(raw)) status = 'idle';
      else if (/外协|外包|不计本厂/.test(raw)) status = 'outsourced';
      machines.push({
        id: id, no: str(r.no), model: str(r.model), ops: ops,
        shifts: sh === null ? 2 : Math.max(1, Math.min(3, sh)),
        statusRaw: raw, status: status, sourceRow: r.__row
      });
      if (status === 'down') addIssue(issues, {
        code: 'MACH_DOWN', sheet: '设备', locator: '设备!B' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 状态为「' + raw + '」', handling: '从本周可用产能中剔除，排程不使用该机'
      });
      if (status === 'idle') addIssue(issues, {
        code: 'MACH_IDLE', sheet: '设备', locator: '设备!B' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 状态为「' + raw + '」（同组产能）', handling: '默认不用；参数「允许用闲置磨床」打开后可启用'
      });
      if (status === 'outsourced') addIssue(issues, {
        code: 'MACH_OUT', sheet: '设备', locator: '设备!B' + r.__row, severity: 'info',
        symptom: id + ' 为外协（' + raw + '）', handling: '不计本厂产能，工艺路线里的外协工序不占机台'
      });
      if (sh !== null && sh >= 3) addIssue(issues, {
        code: 'SHIFT3', sheet: '设备', locator: '设备!E' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 每日班次为 ' + sh + ' 班', handling: '本周按两班（960 min）计，写入假设；需客户确认可否开三班'
      });
    });

    /* ---- 工艺路线 ---- */
    var routeRows = sheets['工艺路线'] || sheets['工艺'] || sheets['路线'];
    if (!routeRows) throw makeErr('缺少工作表', '台账里没有「工艺路线」工作表');
    var rh = locateHeader(routeRows, ['productRoute', 'ops'], 6);
    if (rh < 0) throw makeErr('表头不对', '在「工艺路线」工作表中找不到「产品」表头');
    var rHeader = routeRows[rh] || [];
    var opCols = [];
    for (var c = 0; c < rHeader.length; c++) {
      if (/^工序\s*\d+$/.test(str(rHeader[c]).replace(/\s/g, ''))) opCols.push(c);
    }
    if (!opCols.length) throw makeErr('表头不对', '「工艺路线」里没有「工序1/工序2…」列');
    var totalCol = findCol(rHeader, ALIAS.routeTotal);
    var noteCol = findCol(rHeader, ALIAS.remark);
    var prodCol = findCol(rHeader, ALIAS.productRoute);

    var machineById = {};
    machines.forEach(function (m) { machineById[m.id.toUpperCase()] = m; });

    /** 由机台号前缀反推机台组：LAT → 车、CNC → 铣 … */
    function groupOfIdent(ident) {
      var up = ident.toUpperCase();
      if (machineById[up]) return { group: machineById[up].ops[0] || null, pinned: machineById[up].id };
      var hit = machines.filter(function (m) { return m.id.toUpperCase().indexOf(up) === 0; });
      if (!hit.length) return { group: null, pinned: ident };
      return { group: hit[0].ops[0] || null, pinned: null };
    }

    var routes = {};
    var oralRules = [];
    for (var r = rh + 1; r < routeRows.length; r++) {
      var row = routeRows[r] || [];
      var prod = str(row[prodCol]);
      if (!prod) continue;
      var steps = [];
      opCols.forEach(function (c, idx) {
        var cell = str(row[c]);
        if (!cell) return;
        // 「下料（SAW-01）20」→ 工序 / 机台或机台组 / 单件工时
        var m = cell.match(/^(.+?)\s*[（(]\s*([A-Za-z0-9\-]+)\s*[）)]\s*(\d+(?:\.\d+)?)/);
        var op, ident, min;
        if (m) { op = str(m[1]); ident = str(m[2]); min = parseFloat(m[3]); }
        else {
          var m2 = cell.match(/^(.+?)\s*(\d+(?:\.\d+)?)\s*$/);
          if (!m2) {
            addIssue(issues, {
              code: 'ROUTE_PARSE', sheet: '工艺路线', locator: '工艺路线!' + colName(c) + (r + 1), severity: 'warn',
              symptom: prod + ' 第 ' + (idx + 1) + ' 道工序写法无法解析：' + cell.slice(0, 30),
              handling: '跳过该工序，需人工确认'
            });
            return;
          }
          op = str(m2[1]); ident = ''; min = parseFloat(m2[2]);
        }
        var g = ident ? groupOfIdent(ident) : { group: null, pinned: null };
        if (!g.group) {
          // 工序名本身就是组名
          g.group = op;
        }
        steps.push({
          seq: steps.length + 1, op: op, ident: ident,
          group: g.group || op, pinned: g.pinned, min: min
        });
        if (g.pinned) addIssue(issues, {
          code: 'ROUTE_PINNED', sheet: '工艺路线', locator: '工艺路线!' + colName(c) + (r + 1), severity: 'info',
          symptom: prod + ' 的「' + op + '」点名机台 ' + g.pinned + '（不是机台组）',
          handling: '按点名排；若该机停机且开启「允许换机台」，改用同组可用机并记入假设'
        });
      });
      if (!steps.length) {
        // 没有工序列内容的行 = 口头规则备注行
        oralRules.push(str(row[0]).slice(0, 200));
        addIssue(issues, {
          code: 'ORAL_RULE', sheet: '工艺路线', locator: '工艺路线!A' + (r + 1), severity: 'warn', askCustomer: true,
          symptom: '工艺路线里夹了一条口头规则：' + str(row[0]).slice(0, 60),
          handling: '逐条转成参数/优先级标记；不能自动执行的部分记为客户口头确认'
        });
        continue;
      }
      var sum = steps.reduce(function (a, s) { return a + s.min; }, 0);
      var stated = totalCol >= 0 ? toNum(row[totalCol]) : null;
      routes[prod] = {
        product: prod, steps: steps, total: sum, stated: stated,
        note: noteCol >= 0 ? str(row[noteCol]) : '', sourceRow: r + 1
      };
      if (stated !== null && Math.abs(stated - sum) > 0.01) {
        addIssue(issues, {
          code: 'ROUTE_TOTAL', sheet: '工艺路线', locator: '工艺路线!' + colName(totalCol) + (r + 1), severity: 'warn',
          symptom: prod + ' 单件工时合计写 ' + stated + '，逐工序相加为 ' + sum,
          handling: '以逐工序相加为准（' + sum + '）；合计列仅作校验'
        });
      }
    }
    if (oralRules.length) {
      addIssue(issues, {
        code: 'ORAL_SUM', sheet: '工艺路线', locator: '工艺路线!A9:A11', severity: 'warn', askCustomer: true,
        symptom: '共 ' + oralRules.length + ' 条口头规则藏在工艺路线底部备注里',
        handling: '已按规则转成优先级（急单）、物料到货约束、数量折半；明细见下方逐条'
      });
    }

    /* ---- 订单逐行清洗 ---- */
    var orders = [];
    var blocked = [];
    var usedIds = {};
    var blankQtyCount = 0;

    parsed.forEach(function (r) {
      var prod = str(r.product);
      var route = routes[prod];
      var dueInfo = parseDue(r.due, ctx);
      var od = parseDate(r.orderDate, ctx.year);
      var idInfo = normalizeId(r.id, ctx.year);
      var id = idInfo.id;
      if (!id) {
        addIssue(issues, {
          code: 'ID_EMPTY', sheet: '订单', locator: '订单!A' + r.__row, severity: 'block', askCustomer: true,
          symptom: '第 ' + r.__row + ' 行没有单号', handling: '无法追溯，跳过该行'
        });
        return;
      }
      if (idInfo.changed) addIssue(issues, {
        code: 'ID_NORM', sheet: '订单', locator: '订单!A' + r.__row, severity: 'info',
        symptom: '单号写法不规范：' + str(r.id) + ' → ' + id, handling: '统一格式，不改变业务含义'
      });
      if (usedIds[id]) {
        var newId = id + '-R2';
        addIssue(issues, {
          code: 'ID_DUP', sheet: '订单', locator: '订单!A' + r.__row, severity: 'warn', askCustomer: true,
          symptom: '单号 ' + id + ' 与第 ' + usedIds[id] + ' 行重复（数量不同）',
          handling: '视为追加批，改名 ' + newId + ' 单独排；需客户确认是否合并'
        });
        id = newId;
      }
      usedIds[id] = r.__row;
      if (!route) {
        blocked.push({
          orderId: id, severity: 'block', reason: '工艺路线缺失',
          detail: '产品「' + prod + '」在工艺路线表里找不到', locator: '订单!E' + r.__row,
          action: '补充工艺路线后重跑', product: prod, sourceRow: r.__row
        });
        addIssue(issues, {
          code: 'ROUTE_MISSING', sheet: '订单', locator: '订单!E' + r.__row, severity: 'block', askCustomer: true,
          symptom: '产品「' + prod + '」没有工艺路线', handling: '该单不排，进「排不进」清单'
        });
        return;
      }

      var remark = str(r.remark);
      var qty = toNum(r.qty);
      var split = null;
      var priority = 3;
      var release = null;
      var flags = [];

      if (/急单|张工说|客户催|越早越好|加急/.test(remark) || dueInfo.kind === 'asap') {
        priority = 5;
        flags.push('急单');
      }
      var relM = remark.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日.*到/);
      if (relM) {
        release = ymdToNum(ctx.year, +relM[1], +relM[2]);
        flags.push('物料 ' + fmtMd(release) + ' 到');
        addIssue(issues, {
          code: 'MATERIAL', sheet: '订单', locator: '订单!G' + r.__row, severity: 'warn', askCustomer: true,
          symptom: id + ' 备注写「' + remark + '」', handling: '转为物料到货约束：该单最早开工 = ' + fmtMd(release)
        });
      }
      if (/先做一半|做一半|先行一半/.test(remark)) {
        split = 0.5;
        flags.push('本周做一半');
        addIssue(issues, {
          code: 'SPLIT', sheet: '订单', locator: '订单!G' + r.__row, severity: 'warn', askCustomer: true,
          symptom: id + ' 备注写「' + remark + '」', handling: '本周数量按一半计，剩余顺延；需客户确认折半基数'
        });
      }
      if (/等客户确认|待确认|数量待定/.test(remark) || qty === null) {
        blankQtyCount++;
        addIssue(issues, {
          code: 'QTY_BLANK', sheet: '订单', locator: '订单!F' + r.__row, severity: 'block', askCustomer: true,
          symptom: id + ' 数量空白（备注：' + (remark || '无') + '）',
          handling: '不进本周排程，进「排不进」清单，等客户回填'
        });
        blocked.push({
          orderId: id, severity: 'block', reason: '数量为空白',
          detail: '备注写「' + (remark || '数量等客户确认') + '」', locator: '订单!F' + r.__row,
          action: '复核回填数量后重跑', product: prod, sourceRow: r.__row
        });
        return;
      }
      if (/一起做|同批|合并/.test(remark)) {
        flags.push('建议同批');
        addIssue(issues, {
          code: 'MERGE_HINT', sheet: '订单', locator: '订单!G' + r.__row, severity: 'info', askCustomer: true,
          symptom: id + ' 备注写「' + remark + '」', handling: '记为同批生产建议，本版不合并数量'
        });
      }
      if (!remark && !dueInfo.dayNum && dueInfo.kind === 'empty') { /* 无备注无交期，正常 */ }

      if (dueInfo.kind === 'unparsed') addIssue(issues, {
        code: 'DUE_UNPARSED', sheet: '订单', locator: '订单!D' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 交期写法无法识别：' + str(r.due), handling: '按无硬交期处理（不参与准时率）'
      });
      if (dueInfo.kind === 'empty') addIssue(issues, {
        code: 'DUE_EMPTY', sheet: '订单', locator: '订单!D' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 交期空白', handling: '按无硬交期处理，只报预计完工，不算延期'
      });
      if (dueInfo.kind === 'asap') addIssue(issues, {
        code: 'DUE_ASAP', sheet: '订单', locator: '订单!D' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 交期写「' + str(r.due) + '」', handling: '转成最高优先级（尽快=最急），不设硬交期'
      });
      if (dueInfo.kind === 'monthend') addIssue(issues, {
        code: 'DUE_MONTHEND', sheet: '订单', locator: '订单!D' + r.__row, severity: 'warn', askCustomer: true,
        symptom: id + ' 交期写「' + str(r.due) + '」', handling: '推算为 ' + fmtDate(dueInfo.dayNum) + '（月末），标注推算值'
      });
      if (!od.dayNum && !isBlank(r.orderDate)) addIssue(issues, {
        code: 'ODATE_BAD', sheet: '订单', locator: '订单!C' + r.__row, severity: 'info',
        symptom: id + ' 接单日期写法异常：' + str(r.orderDate), handling: '按缺失处理，不影响排程'
      });
      if (isBlank(r.orderDate)) addIssue(issues, {
        code: 'ODATE_EMPTY', sheet: '订单', locator: '订单!C' + r.__row, severity: 'info',
        symptom: id + ' 接单日期空白', handling: '不影响排程；FIFO 排序用台账行号兜底'
      });

      var thisQty = qty;
      if (split) thisQty = Math.round(qty * split * 10) / 10;

      orders.push({
        id: id, idRaw: str(r.id), customer: str(r.customer), product: prod,
        qty: thisQty, qtyRaw: str(r.qty), qtyFull: qty,
        due: dueInfo.dayNum, dueRaw: str(r.due), dueLevel: dueInfo.level, dueKind: dueInfo.kind,
        orderDate: od.dayNum, priority: priority,
        release: release, split: split ? { thisWeek: split, next: 1 - split } : null,
        flags: flags, route: route, sourceRow: r.__row,
        unitMin: route.total, totalMin: route.total * thisQty
      });
    });

    if (ordersTotal === 0) throw makeErr('空表', '台账里没有可识别的订单行');

    return {
      issues: issues, orders: orders, blocked: blocked, machines: machines,
      routes: routes, bizDay: bizDay, ctx: ctx,
      counts: { ordersTotal: ordersTotal, ordersOk: orders.length, ordersBlocked: blocked.length }
    };
  }

  function colName(idx) {
    var s = '', n = idx + 1;
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function makeErr(title, msg) {
    var e = new Error(msg);
    e.title = title;
    e.userMessage = msg;
    return e;
  }

  /* ═══════════════════════════ 5. 建模：订单 → 工序任务 ═══════════════════════════ */

  /** 计算可用机台与容量（默认 P1 口径） */
  function buildCapacity(model, opts) {
    var usable = [];
    model.machines.forEach(function (m) {
      if (m.status === 'available') { usable.push(m); return; }
      if (m.status === 'idle' && opts.enableGrd02 && /GRD/.test(m.id)) {
        m.effShifts = m.shifts; usable.push(m); return;
      }
      if (m.status === 'down' && opts.enableCnc03 && /CNC-03/.test(m.id)) {
        m.effShifts = m.shifts; usable.push(m); return;
      }
    });
    usable.forEach(function (m) {
      m.effShifts = opts.threeShift ? m.shifts : Math.min(m.shifts, 2);
      m.dailyMinutes = m.effShifts * SHIFT_MIN;
    });

    var groups = {};
    usable.forEach(function (m) {
      m.ops.forEach(function (op) {
        if (!groups[op]) groups[op] = { group: op, machines: [] };
        if (groups[op].machines.indexOf(m.id) < 0) groups[op].machines.push(m.id);
      });
    });
    return { usable: usable, groups: groups };
  }

  /** 某道工序可用哪些机台 */
  function candidatesOf(step, cap, opts) {
    var g = cap.groups[step.group];
    var list = g ? g.machines.slice() : [];
    if (step.pinned) {
      var up = step.pinned.toUpperCase();
      var isPinnedUsable = cap.usable.some(function (m) { return m.id.toUpperCase() === up; });
      if (isPinnedUsable) return [step.pinned];
      // 点名机台不可用（停机/闲置/外协）
      if (opts.allowSwap) return list;         // 换机台：同组任选
      return [];
    }
    return list;
  }

  /** 拆子批（仅为 C3 流水约束的产品） */
  function buildJobs(model, opts, cap) {
    var jobs = [];
    model.orders.forEach(function (o) {
      var steps = o.route.steps.map(function (s) {
        var c = { seq: s.seq, op: s.op, group: s.group, pinned: s.pinned, min: s.min };
        return c;
      });
      // 外协工序（热处理）不占本厂机台 → 从实例里剔除
      steps = steps.filter(function (s) { return cap.groups[s.group] || !s.pinned; });
      var flow = (opts.flowOn && o.product === opts.flowProduct) ? opts : null;
      var lotSize = flow ? Math.max(1, Math.round(opts.lotSize)) : 0;
      if (flow && o.qty > lotSize) {
        var n = Math.ceil(o.qty / lotSize);
        for (var i = 0; i < n; i++) {
          var q = i === n - 1 ? Math.round((o.qty - i * lotSize) * 10) / 10 : lotSize;
          jobs.push(makeJob(o, steps, q, o.id + '-L' + (i + 1), i, flow));
        }
      } else {
        jobs.push(makeJob(o, steps, o.qty, o.id, 0, flow));
      }
    });
    return jobs;
  }

  function makeJob(o, steps, qty, lotId, lotIdx, flow) {
    var total = qty * o.route.total;
    return {
      lotId: lotId, orderId: o.id, lotIdx: lotIdx, product: o.product,
      qty: qty, steps: steps, priority: o.priority,
      due: o.due, dueLevel: o.dueLevel, release: o.release,
      sourceRow: o.sourceRow, totalMin: total,
      flow: flow ? { maxGap: flow.flowGap } : null
    };
  }

  /* ═══════════════════════════ 6. 排程 ═══════════════════════════ */

  function findSlot(busy, earliest, dur) {
    var t = Math.max(0, earliest);
    for (var i = 0; i < busy.length; i++) {
      var b = busy[i];
      if (t + dur <= b.s) return t;
      if (t < b.e) t = b.e;
    }
    return t;
  }

  /** 只看 [lo, hi] 窗口内的空档：整段 duration 必须落在窗口里 */
  function findSlotWindow(busy, lo, hi, dur) {
    if (hi - lo < dur) return null;
    var t = Math.max(0, lo);
    for (var i = 0; i < busy.length; i++) {
      var b = busy[i];
      if (b.e <= t) continue;
      if (t + dur <= b.s) break;
      if (b.s > hi) break;
      t = Math.max(t, b.e);
    }
    return (t + dur <= hi) ? t : null;
  }

  function insertBusy(busy, s, e) {
    busy.push({ s: s, e: e });
    busy.sort(function (a, b) { return a.s - b.s; });
  }

  function sortJobs(jobs, rule) {
    var k = jobs.map(function (j, i) { return { j: j, i: i }; });
    k.sort(function (a, b) {
      var A = a.j, B = b.j;
      if (rule === 'fifo') return A.sourceRow - B.sourceRow || A.lotIdx - B.lotIdx;
      if (rule === 'spt') return A.totalMin - B.totalMin || A.sourceRow - B.sourceRow;
      if (rule === 'mwkr') return B.totalMin - A.totalMin || A.sourceRow - B.sourceRow;
      if (rule === 'edd') {
        var da = A.due === null ? Infinity : A.due, db = B.due === null ? Infinity : B.due;
        return da - db || A.sourceRow - B.sourceRow;
      }
      // prio：急单优先，再按交期
      var pa = -(A.priority || 3), pb = -(B.priority || 3);
      var da2 = A.due === null ? Infinity : A.due, db2 = B.due === null ? Infinity : B.due;
      return pa - pb || da2 - db2 || A.sourceRow - B.sourceRow;
    });
    return k.map(function (x) { return x.j; });
  }

  function solve(model, cap, opts, rule) {
    var cal = opts.cal;
    var state = {};
    cap.usable.forEach(function (m) { state[m.id] = { busy: [] }; });

    var jobs = sortJobs(model.jobs, rule);
    var ops = [], unplan = [];

    jobs.forEach(function (job) {
      job.cursor = 0;
      if (job.release !== null) {
        var idx = cal.indexOnOrAfter(job.release);
        if (idx !== null && idx > 0) job.cursor = idx * MIN_PER_DAY;
      }
      var failed = null;
      for (var i = 0; i < job.steps.length; i++) {
        var st = job.steps[i];
        if (failed) {
          unplan.push({
            orderId: job.orderId, lotId: job.lotId, seq: st.seq, op: st.op,
            group: st.group, reason: failed.reason, blockingMachine: failed.machine,
            suggestion: failed.suggestion
          });
          continue;
        }
        var res = placeStep(job, st, state, cap, opts);
        if (res.error) {
          failed = res.error;
          unplan.push({
            orderId: job.orderId, lotId: job.lotId, seq: st.seq, op: st.op,
            group: st.group, reason: failed.reason, blockingMachine: failed.machine,
            suggestion: failed.suggestion
          });
          continue;
        }
        var dur = res.dur;
        var end = res.start + dur;
        insertBusy(state[res.machine].busy, res.start, end);
        ops.push({
          orderId: job.orderId, lotId: job.lotId, lotIdx: job.lotIdx, seq: st.seq, op: st.op,
          product: job.product, group: st.group, pinned: st.pinned, qty: job.qty,
          minPerUnit: st.min, durationMin: dur, machine: res.machine,
          startAxis: res.start, endAxis: end,
          start: cal.toWall(res.start), end: cal.toWall(end),
          startDate: cal.toClock(res.start).date, startTime: cal.toClock(res.start).time,
          endDate: cal.toClock(end).date, endTime: cal.toClock(end).time,
          status: 'scheduled', due: job.due, flow: !!job.flow, tight: !!res.tight
        });
        job.cursor = end;
      }
    });
    ops.sort(function (a, b) { return a.startAxis - b.startAxis || (a.machine < b.machine ? -1 : 1); });
    var makespan = ops.reduce(function (a, o) { return Math.max(a, o.endAxis); }, 0);
    return { ops: ops, unplan: unplan, makespan: makespan, rule: rule, machines: state };
  }

  /**
   * 把一道工序放到机台上，返回 {machine, start, dur, tight} 或 {error}
   * 紧后工序（阀芯C 磨）有两个通道：
   *   A「紧贴」只找 [车完工, 车完工+gap] 内的空档，保 C3 成立；
   *   B「顺排」任意最早可放位置，C3 交校验器判，兜底不让整单消失。
   */
  function placeStep(job, st, state, cap, opts) {
    var cand = candidatesOf(st, cap, opts);
    var dur = r0(st.min * job.qty);
    if (!cand.length) {
      return {
        error: {
          reason: st.pinned
            ? ('点名机台 ' + st.pinned + ' 不可用（停机/闲置），且未允许换机台')
            : ('「' + st.group + '」组内无可用机台'),
          machine: st.pinned || st.group,
          suggestion: st.pinned ? '允许换机台 / 确认该机是否修好' : '确认该组设备状态'
        }
      };
    }
    var earliest = job.cursor;
    var best = null;

    if (job.flow && st.seq === 2) {
      // 通道 A：优先紧贴
      for (var a = 0; a < cand.length; a++) {
        var m1 = cand[a];
        var g = findSlotWindow(state[m1].busy, earliest, earliest + job.flow.maxGap, dur);
        if (g !== null && (best === null || g < best.start)) best = { machine: m1, start: g, tight: true };
      }
      if (best) return { machine: best.machine, start: best.start, dur: dur, tight: true };
      // 通道 B：紧贴放不进就顺排，C3 交给校验器判（这里不拦，否则整个阀芯C 会消失）
      for (var b2 = 0; b2 < cand.length; b2++) {
        var m2 = cand[b2];
        var s2 = findSlot(state[m2].busy, earliest, dur);
        if (best === null || s2 < best.start) best = { machine: m2, start: s2, tight: false };
      }
      if (!best) {
        return {
          error: {
            reason: '磨床无可用窗口',
            machine: cand[0],
            suggestion: '启用 GRD-02 / 调整子批大小 / 顺延下一窗口'
          }
        };
      }
      return { machine: best.machine, start: best.start, dur: dur, tight: false };
    }

    for (var c = 0; c < cand.length; c++) {
      var mid = cand[c];
      var s = findSlot(state[mid].busy, earliest, dur);
      if (best === null || s < best.start || (s === best.start && state[mid].busy.length < state[best.machine].busy.length)) {
        best = { machine: mid, start: s };
      }
    }
    return { machine: best.machine, start: best.start, dur: dur, tight: false };
  }

  /* ═══════════════════════════ 7. 独立校验器（四条硬约束 + C3） ═══════════════════════════ */

  function verify(model, cap, sched, opts) {
    var cal = opts.cal;
    var lines = [];

    /* H1 每道工序恰好一次 */
    var expected = {};
    model.jobs.forEach(function (j) {
      j.steps.forEach(function (s) { expected[j.lotId + '|' + s.seq] = s; });
    });
    var seen = {};
    var h1 = [];
    sched.ops.forEach(function (o) {
      var k = o.lotId + '|' + o.seq;
      if (seen[k]) h1.push({ text: o.lotId + ' ' + o.op + ' 重复排入（' + o.machine + '）', machine: o.machine, orderId: o.orderId });
      seen[k] = true;
    });
    var expectedCount = Object.keys(expected).length;
    var unplanKeys = {};
    sched.unplan.forEach(function (u) { unplanKeys[u.lotId + '|' + u.seq] = true; });
    Object.keys(expected).forEach(function (k) {
      if (!seen[k] && !unplanKeys[k]) {
        h1.push({ text: toId(k) + ' 工序未排入且未登记原因（漏排）', orderId: toId(k) });
      }
    });
    lines.push({
      code: 'H1', name: '每道工序恰好一次', ok: h1.length === 0,
      detail: (sched.ops.length + sched.unplan.length) + '/' + expectedCount + '（已排 ' + sched.ops.length + ' + 未排入 ' + sched.unplan.length + '）',
      violations: h1
    });

    /* H2 机台与工时一致 */
    var h2 = [];
    sched.ops.forEach(function (o) {
      var step = expected[o.lotId + '|' + o.seq];
      var dur = r0(step.min * (step && model.jobQty ? model.jobQty[o.lotId] : o.qty));
      var qty = model.jobQty[o.lotId];
      dur = r0(step.min * qty);
      if (dur !== o.durationMin) {
        h2.push({ text: o.lotId + ' ' + o.op + ' 工时 ' + o.durationMin + ' ≠ ' + step.min + '×' + qty + '=' + dur, machine: o.machine, orderId: o.orderId });
      }
      var g = cap.groups[o.group];
      var okMachine = g && g.machines.indexOf(o.machine) >= 0;
      if (!okMachine) h2.push({ text: o.lotId + ' ' + o.op + ' 排到 ' + o.machine + '，但该机不可做「' + o.group + '」', machine: o.machine, orderId: o.orderId });
    });
    lines.push({
      code: 'H2', name: '机台与工时与工艺一致', ok: h2.length === 0,
      detail: sched.ops.length + ' 道已排工序逐条核对（分钟/件 × 数量、机台工艺能力）',
      violations: h2
    });

    /* H3 同订单工序不倒序 */
    var h3 = [];
    var byLot = {};
    sched.ops.forEach(function (o) { (byLot[o.lotId] = byLot[o.lotId] || []).push(o); });
    Object.keys(byLot).forEach(function (lot) {
      var arr = byLot[lot].slice().sort(function (a, b) { return a.seq - b.seq; });
      for (var i = 1; i < arr.length; i++) {
        if (arr[i].startAxis < arr[i - 1].endAxis) {
          h3.push({
            text: lot + ' 「' + arr[i].op + '」开工 ' + arr[i].start + ' 早于前道「' + arr[i - 1].op + '」完工 ' + arr[i - 1].end,
            machine: arr[i].machine, orderId: arr[i].orderId
          });
        }
      }
    });
    lines.push({
      code: 'H3', name: '同订单/子批工序不倒序', ok: h3.length === 0,
      detail: Object.keys(byLot).length + ' 个作业链逐条核对前道完工 ≤ 后道开工',
      violations: h3
    });

    /* H4 同机台时间不重叠 */
    var h4 = [];
    var byMachine = {};
    sched.ops.forEach(function (o) { (byMachine[o.machine] = byMachine[o.machine] || []).push(o); });
    Object.keys(byMachine).forEach(function (m) {
      var arr = byMachine[m].slice().sort(function (a, b) { return a.startAxis - b.startAxis; });
      for (var i = 1; i < arr.length; i++) {
        if (arr[i].startAxis < arr[i - 1].endAxis) {
          h4.push({
            text: m + '：' + arr[i - 1].lotId + '「' + arr[i - 1].op + '」' + arr[i - 1].startTime + '–' + arr[i - 1].endTime +
              ' 与 ' + arr[i].lotId + '「' + arr[i].op + '」' + arr[i].startTime + '–' + arr[i].endTime + ' 重叠',
            machine: m, orderId: arr[i].orderId
          });
        }
      }
    });
    lines.push({
      code: 'H4', name: '同一台机时间不重叠', ok: h4.length === 0,
      detail: Object.keys(byMachine).length + ' 台机逐对核对区间',
      violations: h4
    });

    /* H5 阀芯C 流水约束 */
    var h5 = [], skip = [];
    if (opts.flowOn) {
      var flowLots = {};
      sched.ops.forEach(function (o) { if (o.flow) (flowLots[o.lotId] = flowLots[o.lotId] || []).push(o); });
      Object.keys(flowLots).forEach(function (lot) {
        var arr = flowLots[lot].sort(function (a, b) { return a.seq - b.seq; });
        if (arr.length < 2) { skip.push({ text: lot + ' 只有一道工序排入，无法校验流水间隔' }); return; }
        var gap = arr[1].startAxis - arr[0].endAxis;
        if (gap > opts.flowGap) {
          h5.push({ text: lot + ' 车间隔 ' + gap + ' min > ' + opts.flowGap + '（磨开工 ' + arr[1].start + '）', machine: arr[1].machine, orderId: arr[1].orderId });
        } else if (gap < 0) {
          h5.push({ text: lot + ' 车间隔 ' + gap + ' min（磨早于车完工）', machine: arr[1].machine, orderId: arr[1].orderId });
        }
      });
      lines.push({
        code: 'H5', name: opts.flowProduct + ' 车→磨 流水 ≤' + opts.flowGap + 'min', ok: h5.length === 0,
        detail: Object.keys(flowLots).length + ' 个子批核对（另一口径：两道完工之差）',
        violations: h5, skipped: skip
      });
    }

    var hardFail = false;
    lines.forEach(function (l) {
      // H1~H4 是硬约束（不重不漏 / 机台对 / 不倒序 / 不重叠）；
      // H5 是客户澄清的流水条件，不满足时单独报「条件未达成」，不与硬约束混为一谈
      if (!l.ok && l.code !== 'H5') hardFail = true;
    });
    var softFail = lines.some(function (l) { return !l.ok && l.code === 'H5'; });
    var hasSkip = sched.unplan.length > 0;
    var result = hardFail ? 'FAIL' : (softFail ? 'PASS_WITH_WARN' : (hasSkip ? 'PASS_WITH_SKIP' : 'PASS'));
    var resultCn = {
      PASS: '通过', PASS_WITH_SKIP: '通过（有未排入）',
      PASS_WITH_WARN: '硬约束通过 / 流水条件未达成', FAIL: '不通过'
    }[result];

    /* 分组元数据：只描述「哪条属于哪组」，不做任何判定。
       与后端 out/校验报告.txt 的两个分组标题逐字对应（core/checker.py format_report）。 */
    var groups = [{
      key: 'hard',
      title: '硬约束',
      note: 'PPT 第12页，违反则拒绝交付',
      codes: ['H1', 'H2', 'H3', 'H4']
    }, {
      key: 'flow',
      title: '客户流水条件',
      note: '非硬约束，未达成不影响交付',
      codes: ['H5']
    }];
    groups.forEach(function (g) {
      g.lines = lines.filter(function (l) { return g.codes.indexOf(l.code) >= 0; });
      g.ok = g.lines.every(function (l) { return l.ok; });
      g.failCount = g.lines.reduce(function (a, l) { return a + l.violations.length; }, 0);
    });
    var flowGroup = groups.filter(function (g) { return g.key === 'flow'; })[0];

    return {
      result: result, resultCn: resultCn, lines: lines,
      groups: groups,
      hardFail: hardFail, softFail: softFail,
      /* 硬约束 0 违反 = 这份排程可以交付；H5 未达成只影响「要不要告知代价」，不影响可交付性。
         前端任何地方都不得用 softFail 去禁用生成或阻断下载。 */
      deliverable: !hardFail,
      violations: lines.reduce(function (a, l) { return a + l.violations.length; }, 0),
      hardViolations: lines.reduce(function (a, l) { return a + (l.code === 'H5' ? 0 : l.violations.length); }, 0),
      softViolations: lines.reduce(function (a, l) { return a + (l.code === 'H5' ? l.violations.length : 0); }, 0),
      flowNote: (flowGroup && !flowGroup.ok)
        ? '磨床是瓶颈，产能客观不足导致断档，不是排程算法错误；硬约束 0 违反，这份排程可以交，但这条必须写进交接说明并告知客户代价。'
        : ''
    };
  }

  function toId(k) { return k.split('|')[0]; }

  /* ═══════════════════════════ 8. 汇总：指标卡 / 风险清单 / 产能 ═══════════════════════════ */

  var STATUS_CN = {
    ok: '准时', delayed: '延期', at_risk: '预警',
    not_in_horizon: '未排入本周', unplannable: '排不进'
  };

  function summarize(model, cap, sched, opts) {
    var cal = opts.cal;
    var need = {};   // lotId → 应排工序数
    model.jobs.forEach(function (j) { need[j.lotId] = j.steps.length; });
    var done = {}, undone = {};
    sched.ops.forEach(function (o) { done[o.lotId] = (done[o.lotId] || 0) + 1; });
    sched.unplan.forEach(function (u) { undone[u.lotId] = (undone[u.lotId] || 0) + 1; });

    // 作业级完工
    var lotEnd = {};
    sched.ops.forEach(function (o) {
      lotEnd[o.lotId] = Math.max(lotEnd[o.lotId] || 0, o.endAxis);
    });

    var rows = [];
    model.orders.forEach(function (o) {
      var myLots = model.jobs.filter(function (j) { return j.orderId === o.id; })
        .map(function (j) { return j.lotId; });
      var planned = myLots.reduce(function (a, l) { return a + (done[l] || 0); }, 0);
      var needOps = myLots.reduce(function (a, l) { return a + (need[l] || 0); }, 0);
      var complete = myLots.length > 0 && myLots.every(function (l) { return (done[l] || 0) >= (need[l] || 0); });
      var endAxis = myLots.reduce(function (a, l) { return Math.max(a, lotEnd[l] || 0); }, 0);
      var plannedEnd = complete ? endAxis : null;
      // 交期落在周日 → 顺延到下一个工作日（工厂周日不排）
      var dueIdx = o.due === null ? null : cal.indexOnOrAfter(o.due);
      var windowEndIdx = WINDOW_DAYS - 1;
      var inHorizon = dueIdx !== null && dueIdx >= 0 && dueIdx <= windowEndIdx;
      var dueAxis = inHorizon ? dueIdx * MIN_PER_DAY + (DUE_HOUR - ORIGIN_HOUR) * 60 : null;

      var status, delayDays = null, remainMin = null;
      if (planned === 0) {
        status = 'unplannable';
      } else if (!complete) {
        status = 'unplannable';
      } else if (dueIdx !== null && dueIdx > windowEndIdx) {
        // 交期在窗口之后：本周排不排都不算延期（口径见设计文档 E3.2）
        status = 'not_in_horizon';
      } else if (dueAxis === null) {
        status = 'ok';  // 无硬交期：只报预计完工
      } else if (endAxis > dueAxis) {
        status = 'delayed';
        delayDays = Math.max(1, Math.ceil((endAxis - dueAxis) / MIN_PER_DAY));
      } else if (dueAxis - endAxis < SHIFT_MIN) {
        status = 'at_risk';
        remainMin = dueAxis - endAxis;
      } else {
        status = 'ok';
        remainMin = dueAxis - endAxis;
      }

      // 瓶颈：已排工序里最晚完工的那台机就是交付卡点（未排入的单退回第一道排不进的工序）
      var myOps = sched.ops.filter(function (x) { return x.orderId === o.id; });
      var last = myOps.reduce(function (a, b) { return (b.endAxis > (a ? a.endAxis : -1)) ? b : a; }, null);
      var miss = sched.unplan.filter(function (u) { return u.orderId === o.id; })[0] || null;
      var bm = last ? last.machine : (miss ? miss.blockingMachine : null);
      var bo = last ? last.op : (miss ? miss.op : null);
      var bs = last ? last.seq : (miss ? miss.seq : null);
      if (miss && !last) { bm = miss.blockingMachine; bo = miss.op; bs = miss.seq; }

      rows.push({
        orderId: o.id, idRaw: o.idRaw, customer: o.customer, product: o.product,
        qty: o.qty, qtyFull: o.qtyFull, qtyRaw: o.qtyRaw,
        due: o.due, dueRaw: o.dueRaw, dueLevel: o.dueLevel, dueKind: o.dueKind,
        dueMd: o.due === null ? (o.dueKind === 'asap' ? '尽快' : '—') : fmtMd(o.due) + (o.dueLevel === 'inferred' ? '*' : ''),
        inHorizon: inHorizon,
        plannedEndAxis: complete ? endAxis : null,
        plannedEnd: complete ? cal.toWall(endAxis) : null,
        plannedEndLabel: complete ? (function () {
          var c = cal.toClock(endAxis); return c.md + ' ' + c.time;
        })() : '—',
        status: status, statusCn: STATUS_CN[status],
        delayDays: delayDays,
        delayMd: delayDays === null ? '—' : '<span class="late">+' + delayDays + ' 天</span>',
        delayText: delayDays === null ? (remainMin !== null ? '余量 ' + Math.round(remainMin) + ' min' : '—') : '+' + delayDays + ' 天',
        remainMin: remainMin,
        bottleneckMachine: bm,
        bottleneckOp: bo,
        bottleneckSeq: bs,
        opsPlanned: planned, opsNeed: needOps,
        lots: myLots, lotsUnplannable: myLots.filter(function (l) { return (undone[l] || 0) > 0; }),
        unplanReason: miss ? miss.reason : null,
        priority: o.priority, release: o.release, flags: o.flags,
        suggestion: suggest(status, delayDays, last, miss, o)
      });
    });

    // blocked（数量空白 / 工艺缺失）
    model.blocked.forEach(function (b) {
      rows.push({
        orderId: b.orderId, idRaw: b.orderId, customer: '—', product: b.product,
        qty: null, qtyFull: null, qtyRaw: '—',
        due: null, dueRaw: '—', dueLevel: 'none', dueKind: 'empty', dueMd: '—', inHorizon: false,
        plannedEndAxis: null, plannedEnd: null, plannedEndMd: null, plannedEndLabel: '—',
        status: 'unplannable', statusCn: '排不进',
        delayDays: null, delayMd: '—', delayText: '—', remainMin: null,
        bottleneckMachine: null, bottleneckOp: null, bottleneckSeq: null,
        opsPlanned: 0, opsNeed: 0, lots: [], lotsUnplannable: [],
        unplanReason: b.reason + '（' + b.detail + '）',
        priority: 0, release: null, flags: [], suggestion: b.action, blocked: true
      });
    });

    var order = { ok: 0, delayed: 1, at_risk: 2, not_in_horizon: 3, unplannable: 4 };
    rows.sort(function (a, b) {
      var d = order[a.status] - order[b.status];
      if (d !== 0) return d;
      return (a.due === null ? Infinity : a.due) - (b.due === null ? Infinity : b.due);
    });

    /* 产能与负荷
       组级容量 = 组内可用机台容量之和（只用于回答「这一组够不够」）
       合计容量 = 可用机台容量之和（不重复计，因为一台机可能同时出现在镗/铣两个组里） */
    var loadByGroup = {};
    var gapRows = [];
    var totalLoad = 0;
    var dailyOf = {};
    cap.usable.forEach(function (m) { dailyOf[m.id] = m.effShifts * SHIFT_MIN; });

    // 先统计每台机被哪些组共享
    var groupsOfMachine = {};
    Object.keys(cap.groups).forEach(function (g) {
      cap.groups[g].machines.forEach(function (id) {
        (groupsOfMachine[id] = groupsOfMachine[id] || []).push(g);
      });
    });

    Object.keys(cap.groups).forEach(function (g) {
      var ms = cap.groups[g].machines;
      var capMin = ms.reduce(function (a, id) { return a + (dailyOf[id] || 0) * WINDOW_DAYS; }, 0);
      loadByGroup[g] = 0;
      var shared = ms.filter(function (id) { return groupsOfMachine[id].length > 1; });
      gapRows.push({
        group: g, machines: ms, capacity: capMin, daily: capMin / WINDOW_DAYS,
        sharedWith: shared.length ? groupsOfMachine[shared[0]].filter(function (x) { return x !== g; }) : []
      });
    });
    model.orders.forEach(function (o) {
      o.route.steps.forEach(function (s) {
        if (loadByGroup[s.group] === undefined) {
          loadByGroup[s.group] = 0;
          gapRows.push({ group: s.group, machines: [], capacity: 0, daily: 0, sharedWith: [] });
        }
        loadByGroup[s.group] += s.min * o.qty;
        totalLoad += s.min * o.qty;
      });
    });
    gapRows.forEach(function (r) {
      r.load = Math.round(loadByGroup[r.group] * 10) / 10;
      r.capacity = Math.round(r.capacity * 10) / 10;
      r.gap = Math.max(0, Math.round((r.load - r.capacity) * 10) / 10);
      r.free = Math.max(0, Math.round((r.capacity - r.load) * 10) / 10);
      r.util = r.capacity ? r.load / r.capacity : 0;
      r.over = r.gap > 0;
      r.days = r.capacity ? r.load / MIN_PER_DAY : 0;
      r.onlyShared = r.load === 0 && r.sharedWith.length > 0;
    });

    // 按负荷排序，让超载的组排在上面
    gapRows.sort(function (a, b) { return b.util - a.util || a.group.localeCompare(b.group); });

    // 合计：机台口径（不重复）
    var totalCap = cap.usable.reduce(function (a, m) { return a + (dailyOf[m.id] || 0) * WINDOW_DAYS; }, 0);
    var groupGapSum = gapRows.reduce(function (a, r) { return a + r.gap; }, 0);
    var groupFreeSum = gapRows.reduce(function (a, r) { return a + r.free; }, 0);

    /* 指标卡 */
    var delayed = rows.filter(function (r) { return r.status === 'delayed'; }).length;
    var atRisk = rows.filter(function (r) { return r.status === 'at_risk'; }).length;
    var notInHorizon = rows.filter(function (r) { return r.status === 'not_in_horizon'; }).length;
    var unplannable = rows.filter(function (r) { return r.status === 'unplannable'; }).length;
    var okN = rows.filter(function (r) { return r.status === 'ok'; }).length;
    var hard = rows.filter(function (r) { return r.inHorizon; }).length;
    var onTime = rows.filter(function (r) { return r.inHorizon && (r.status === 'ok' || r.status === 'at_risk'); }).length;
    var makespanDays = sched.makespan / MIN_PER_DAY;
    var util = totalCap ? totalLoad / totalCap : 0;

    return {
      rows: rows, gapRows: gapRows,
      totalLoad: totalLoad, totalCapacity: totalCap,
      groupGapSum: groupGapSum, groupFreeSum: groupFreeSum,
      counts: {
        delayed: delayed, atRisk: atRisk, notInHorizon: notInHorizon,
        unplannable: unplannable, ok: okN, hard: hard, onTime: onTime
      },
      cardData: {
        makespanDays: makespanDays,
        util: util,
        onTimeRate: hard ? onTime / hard : null,
        overWindow: makespanDays - WINDOW_DAYS
      }
    };
  }

  function suggest(status, delay, last, miss, o) {
    if (status === 'delayed') {
      var m = last ? last.machine : '';
      if (/GRD/.test(m)) return '磨床是瓶颈：启用 GRD-02 / 与客户协商延期 ' + (delay || 1) + ' 天';
      if (/CNC/.test(m)) return '铣削超载：与客户协商延期 ' + (delay || 1) + ' 天 / 外协部分铣削';
      return '与客户协商延期 ' + (delay || 1) + ' 天';
    }
    if (status === 'at_risk') return '余量不足一个班次，提前确认物料与人员';
    if (status === 'not_in_horizon') return '交期在窗口外，建议顺延到下一周窗口，本周不排不算延期';
    if (status === 'unplannable') {
      if (miss && /GRD|磨/.test(miss.blockingMachine + miss.reason)) return '磨床无有效窗口：启用 GRD-02 / 调整 lot_size / 顺延';
      if (miss && /流水/.test(miss.reason)) return '流水约束卡死：调整子批大小（lot_size）或增加磨床';
      return '需决策：' + (miss ? miss.reason : '数量/工艺缺失');
    }
    return '按计划生产';
  }

  /* ═══════════════════════════ 9. 入口 ═══════════════════════════ */

  var DEFAULT_OPTS = {
    startDate: null, allowSwap: true, enableGrd02: false, enableCnc03: false,
    emptyQty: 'skip', lotSize: 20, flowOn: true, flowProduct: '阀芯C',
    flowGap: 30, threeShift: false, year: 2026
  };

  function run(sheets, userOpts, onStage) {
    var t0 = Date.now();
    var opts = {};
    Object.keys(DEFAULT_OPTS).forEach(function (k) { opts[k] = DEFAULT_OPTS[k]; });
    Object.keys(userOpts || {}).forEach(function (k) { if (userOpts[k] !== undefined) opts[k] = userOpts[k]; });

    var stage = function (name, p) { if (onStage) onStage(name, p); };

    stage('读取台账', 0.1);
    var model = clean(sheets, opts);

    // 窗口起点：默认「整理日之后最近的周一」
    var startNum = opts.startDate ? parseDate(opts.startDate, opts.year).dayNum : null;
    if (startNum === null) {
      startNum = model.bizDay;
      while (dow(startNum) !== 1) startNum++;   // 找最近的周一
      if (startNum < model.bizDay) startNum += 7;
    }
    opts.cal = makeCalendar(startNum);
    opts.year = numToYmd(startNum)[0];
    opts.month = numToYmd(startNum)[1];

    stage('清洗脏数据', 0.3);
    var cap = buildCapacity(model, opts);

    stage('建立工序实例', 0.45);
    model.jobs = buildJobs(model, opts, cap);
    model.jobQty = {};
    model.jobs.forEach(function (j) { model.jobQty[j.lotId] = j.qty; });

    stage('规则排程', 0.6);
    var rules = opts.forceRule ? [opts.forceRule] : ['prio', 'edd', 'fifo', 'spt', 'mwkr'];
    var best = null;
    var tried = [];
    rules.forEach(function (rule) {
      var s = solve(model, cap, opts, rule);
      var sum = quickScore(model, s, opts);
      s.score = sum;
      tried.push({ rule: rule, score: sum, makespan: s.makespan, unplan: s.unplan.length });
      if (!best || better(sum, best.score)) best = s;
    });

    stage('独立校验', 0.82);
    var v = verify(model, cap, best, opts);

    stage('生成报表', 0.92);
    var sum2 = summarize(model, cap, best, opts);

    // 未登记在 issues 里的"排不进"原因，补一条
    if (best.unplan.length) {
      var byReason = {};
      best.unplan.forEach(function (u) { byReason[u.reason] = (byReason[u.reason] || 0) + 1; });
      Object.keys(byReason).forEach(function (k) {
        addIssue(model.issues, {
          code: 'UNPLANNED', sheet: '排程', locator: '—', severity: 'warn', askCustomer: true,
          symptom: byReason[k] + ' 道工序排不进：' + k,
          handling: '列入风险清单「排不进」，需决策（加设备 / 调整子批 / 顺延）'
        });
      });
    }
    if (sum2.cardData.util > 1) {
      addIssue(model.issues, {
        code: 'OVERLOAD', sheet: '产能', locator: '—', severity: 'warn', askCustomer: true,
        symptom: '总负荷 ' + r0(sum2.totalLoad) + ' min 超过窗口总容量 ' + sum2.totalCapacity + ' min（利用率 ' + (sum2.cardData.util * 100).toFixed(0) + '%）',
        handling: '这不是算法问题，是产能不足；需加设备 / 加班 / 顺延，写入交接说明'
      });
    }

    var paramsLine = [
      '原点 ' + fmtDate(startNum),
      '两班8h', '周日不排', '交期17:00', '窗口6天',
      'GRD02=' + (opts.enableGrd02 ? 'on' : 'off'),
      'CNC03=' + (opts.enableCnc03 ? 'on' : 'off'),
      'LAT03=' + (opts.threeShift ? '3班' : '2班'),
      'lot=' + opts.lotSize,
      'C3=' + (opts.flowOn ? opts.flowGap + 'min' : 'off'),
      '换机台=' + (opts.allowSwap ? '是' : '否')
    ].join(' | ');

    stage('完成', 1);
    return finish({
      model: model, cap: cap, sched: best, verify: v, sum: sum2,
      opts: opts, startNum: startNum, paramsLine: paramsLine, elapsed: Date.now() - t0,
      rules: rules
    });
  }

  function finish(x) {
    var model = x.model, sched = x.sched, sum = x.sum, v = x.verify, opts = x.opts;
    var cal = opts.cal;
    var days = [];
    for (var i = 0; i < WINDOW_DAYS; i++) {
      var d = cal.dayAt(i);
      days.push({ index: i, date: fmtDate(d), md: fmtMd(d), dow: DOW_CN[dow(d)], axisStart: i * MIN_PER_DAY });
    }
    var axisDays = Math.max(WINDOW_DAYS, Math.ceil(sched.makespan / MIN_PER_DAY));
    for (var j = WINDOW_DAYS; j < axisDays; j++) {
      var dd = cal.dayAt(j);
      days.push({ index: j, date: fmtDate(dd), md: fmtMd(dd), dow: DOW_CN[dow(dd)], axisStart: j * MIN_PER_DAY, beyond: true });
    }

    /* 甘特条 */
    var bars = sched.ops.map(function (o) {
      return {
        m: o.machine, s: o.startAxis, e: o.endAxis, id: o.orderId, lot: o.lotId,
        op: o.op, prod: o.product, qty: o.qty, dur: o.durationMin,
        status: 'scheduled', flow: o.flow, label: o.op
      };
    });

    /* 机台列表（甘特纵轴）：按组排序 */
    var orderOfGroup = { '下料': 0, '车': 1, '铣': 2, '钻': 3, '磨': 4 };
    var machRows = x.cap.usable.slice().sort(function (a, b) {
      var ga = (a.ops && a.ops.length) ? orderOfGroup[a.ops[0]] : 9;
      var gb = (b.ops && b.ops.length) ? orderOfGroup[b.ops[0]] : 9;
      return ga - gb || (a.id < b.id ? -1 : 1);
    }).map(function (m) {
      var busy = 0;
      sched.ops.forEach(function (o) { if (o.machine === m.id) busy += o.durationMin; });
      return {
        id: m.id, group: (m.ops || []).join('/'), model: m.model,
        shifts: m.effShifts, capacity: WINDOW_DAYS * MIN_PER_DAY,
        busy: busy, util: busy / (WINDOW_DAYS * MIN_PER_DAY),
        isBottleneck: sum.gapRows.some(function (g) { return g.over && g.machines.indexOf(m.id) >= 0; })
      };
    });

    /* 指标卡 */
    var cd = sum.cardData;
    var cards = [
      {
        key: 'total', label: '订单总数', value: String(model.counts.ordersTotal),
        sub: (model.counts.ordersBlocked ? model.counts.ordersBlocked + ' 张待复核' : '台账有效行'), tone: 'plain',
        tip: '台账「订单」sheet 的有效行数（不含注释行）=' + model.counts.ordersTotal
      },
      {
        key: 'ok', label: '可排订单', value: String(model.counts.ordersOk),
        sub: model.counts.ordersBlocked ? model.counts.ordersBlocked + ' 张待复核' : '全部进排程', tone: 'blue',
        tip: '通过闸门（数量/工艺齐全）进入排程的订单数 = ' + model.counts.ordersOk
      },
      {
        key: 'makespan', label: '总工期', value: cd.makespanDays.toFixed(1) + ' 天',
        sub: cd.overWindow > 0.05 ? '超窗 ' + cd.overWindow.toFixed(1) + ' 天' : '窗口 6 天内完成',
        tone: cd.overWindow > 0 ? 'bad' : 'good',
        tip: 'makespan = 最后一道工序完工 = ' + r0(sched.makespan) + ' min ÷ 960 min/天 = ' + cd.makespanDays.toFixed(2) + ' 天'
      },
      {
        key: 'util', label: '产能利用率', value: (cd.util * 100).toFixed(1) + '%',
        sub: cd.util > 1 ? '⚠ 超载' : '有余量', tone: cd.util > 1 ? 'bad' : 'good',
        tip: '总负荷 ' + r0(sum.totalLoad) + ' min ÷ 窗口总容量 ' + sum.totalCapacity + ' min（' + x.cap.usable.length + ' 台机 × 6 天 × 960）'
      },
      {
        key: 'delayed', label: '延期单数', value: String(sum.counts.delayed),
        sub: sum.counts.delayed > 0 ? '⚠ 需回客户' : '无延期', tone: sum.counts.delayed > 0 ? 'bad' : 'good',
        tip: '已排入且预计完工晚于交期（当日 17:00）的订单数；另 ' + sum.counts.notInHorizon + ' 张交期在窗口外，不算延期'
      },
      {
        key: 'ontime', label: '准时率', value: cd.onTimeRate === null ? '—' : (cd.onTimeRate * 100).toFixed(1) + '%',
        sub: '窗口内硬交期 ' + sum.counts.hard + ' 张', tone: (cd.onTimeRate !== null && cd.onTimeRate < 0.8) ? 'warn' : 'good',
        tip: '准时（含预警）' + sum.counts.onTime + ' ÷ 窗口内硬交期 ' + sum.counts.hard + '；无硬交期的单不计入分母'
      }
    ];

    /* 数据体检分组 */
    var sevOrder = { block: 0, warn: 1, info: 2 };
    var issues = model.issues.slice().sort(function (a, b) { return sevOrder[a.severity] - sevOrder[b.severity]; });
    var codeTitle = {
      NOTE_ROW: '注释行', BIZ_DATE_INFER: '整理日推断', MACH_DOWN: '设备停机', MACH_IDLE: '设备闲置',
      MACH_OUT: '设备外协', SHIFT3: '三班机台', ROUTE_PINNED: '点名机台', ROUTE_PARSE: '工序写法',
      ORAL_RULE: '口头规则', ORAL_SUM: '口头规则汇总', ROUTE_TOTAL: '工时合计', ID_EMPTY: '单号缺失',
      ID_NORM: '单号归一', ID_DUP: '单号重复', ROUTE_MISSING: '工艺缺失', MATERIAL: '物料到货',
      SPLIT: '先做一半', QTY_BLANK: '数量空白', MERGE_HINT: '同批建议', DUE_UNPARSED: '交期不可识别',
      DUE_EMPTY: '交期空白', DUE_ASAP: '交期「尽快」', DUE_MONTHEND: '交期「月底前」',
      ODATE_BAD: '接单日期异常', ODATE_EMPTY: '接单日期空白', UNPLANNED: '排不进', OVERLOAD: '产能超载'
    };
    issues.forEach(function (i2) { i2.title = codeTitle[i2.code] || i2.code; });
    var groups = {};
    issues.forEach(function (i2) { (groups[i2.code] = groups[i2.code] || []).push(i2); });
    var codeOrder = ['NOTE_ROW', 'ID_NORM', 'ID_DUP', 'DUE_ASAP', 'DUE_MONTHEND', 'DUE_EMPTY', 'DUE_UNPARSED',
      'QTY_BLANK', 'MATERIAL', 'SPLIT', 'MERGE_HINT', 'ROUTE_MISSING', 'ROUTE_PINNED', 'ROUTE_TOTAL', 'ROUTE_PARSE',
      'ORAL_SUM', 'ORAL_RULE', 'MACH_DOWN', 'MACH_IDLE', 'MACH_OUT', 'SHIFT3', 'ODATE_EMPTY', 'ODATE_BAD',
      'BIZ_DATE_INFER', 'UNPLANNED', 'OVERLOAD'];
    var groupList = Object.keys(groups).sort(function (a, b) {
      var ia = codeOrder.indexOf(a), ib = codeOrder.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).map(function (code) {
      var list = groups[code];
      return {
        code: code, title: list[0].title,
        count: list.length,
        askCustomer: list.some(function (x2) { return x2.askCustomer; }),
        severity: list.some(function (x2) { return x2.severity === 'block'; }) ? 'block'
          : (list.some(function (x2) { return x2.severity === 'warn'; }) ? 'warn' : 'info'),
        items: list
      };
    });

    return {
      ok: true,
      meta: {
        generatedAt: new Date().toISOString(),
        sourceFile: opts.sourceFile || '宏达精密_订单台账.xlsx',
        elapsed: x.elapsed,
        rule: sched.rule,
        ruleCn: { prio: '急单优先', edd: '最早交期优先', fifo: '先来先到', spt: '短工时优先', mwkr: '长工时优先' }[sched.rule] || sched.rule,
        horizon: {
          start: fmtDate(x.startNum), startCn: fmtDateCn(x.startNum),
          end: fmtDate(cal.dayAt(WINDOW_DAYS - 1)), endCn: fmtDateCn(cal.dayAt(WINDOW_DAYS - 1)),
          days: days, workingDays: WINDOW_DAYS,
          capacityPerMachine: WINDOW_DAYS * MIN_PER_DAY,
          paramsLine: x.paramsLine
        },
        opts: {
          allowSwap: opts.allowSwap, enableGrd02: opts.enableGrd02, enableCnc03: opts.enableCnc03,
          lotSize: opts.lotSize, flowOn: opts.flowOn, flowGap: opts.flowGap,
          emptyQty: opts.emptyQty, threeShift: opts.threeShift
        },
        counts: {
          ordersTotal: model.counts.ordersTotal,
          ordersOk: model.counts.ordersOk,
          ordersBlocked: model.counts.ordersBlocked,
          opsTotal: Object.keys(model.jobQty).reduce(function (a, l) { return a + 0; }, 0) + (function () {
            var n = 0; model.jobs.forEach(function (j) { n += j.steps.length; }); return n;
          })(),
          opsPlanned: sched.ops.length,
          opsUnplanned: sched.unplan.length,
          lots: model.jobs.length,
          machines: x.cap.usable.length
        }
      },
      cards: cards,
      orders: model.orders,
      operations: sched.ops,
      unplannable: sched.unplan,
      summary: sum.rows,
      risk: {
        rows: sum.rows,
        totals: sum.counts,
        labels: STATUS_CN
      },
      capacity: {
        groups: sum.gapRows,
        totalLoad: sum.totalLoad,
        totalCapacity: sum.totalCapacity,
        machines: machRows
      },
      gantt: { days: days, machines: machRows, bars: bars, makespan: sched.makespan, windowAxis: WINDOW_DAYS * MIN_PER_DAY },
      verify: v,
      health: {
        groups: groupList,
        issues: issues,
        counts: {
          total: issues.length,
          askCustomer: issues.filter(function (i3) { return i3.askCustomer; }).length,
          classes: groupList.length,
          askClasses: groupList.filter(function (g) { return g.askCustomer; }).length
        }
      },
      blocked: model.blocked,
      model: { orders: model.orders, jobs: model.jobs, routes: model.routes, machines: model.machines }
    };
  }

  function quickScore(model, sched, opts) {
    var cal = opts.cal;
    var delayed = 0, tardy = 0, hard = 0, urgentEnd = 0, urgentN = 0;
    var lotEnd = {}, lotNeed = {};
    model.jobs.forEach(function (j) { lotNeed[j.lotId] = j.steps.length; });
    var lotDone = {};
    sched.ops.forEach(function (o) {
      lotEnd[o.lotId] = Math.max(lotEnd[o.lotId] || 0, o.endAxis);
      lotDone[o.lotId] = (lotDone[o.lotId] || 0) + 1;
    });
    model.orders.forEach(function (o) {
      var lots = model.jobs.filter(function (j) { return j.orderId === o.id; }).map(function (j) { return j.lotId; });
      var complete = lots.length > 0 && lots.every(function (l) { return (lotDone[l] || 0) >= lotNeed[l]; });
      if (!complete) return;
      var end = lots.reduce(function (a, l) { return Math.max(a, lotEnd[l] || 0); }, 0);
      // 急单（备注急单 / 交期写「尽快」）必须尽早，否则「尽快=最急」这条口头规则就废了
      if (o.priority >= 5 || o.dueKind === 'asap') { urgentEnd += end; urgentN++; }
      var di = o.due === null ? null : cal.indexOnOrAfter(o.due);
      if (di === null || di < 0 || di > WINDOW_DAYS - 1) return;
      hard++;
      var dueAxis = di * MIN_PER_DAY + (DUE_HOUR - ORIGIN_HOUR) * 60;
      if (end > dueAxis) { delayed++; tardy += (end - dueAxis) / MIN_PER_DAY; }
    });
    // 字典序：延期单数 → 急单平均完工 → 平均迟到天数 → 未排入工序数 → makespan
    return [delayed, urgentN ? Math.round(urgentEnd / urgentN) : 0, hard ? Math.round((tardy / hard) * 100) : 0, sched.unplan.length, r0(sched.makespan)];
  }

  /** 字典序比较：a 更优返回 true */
  function better(a, b) {
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var x = a[i] === undefined ? Infinity : a[i];
      var y = b[i] === undefined ? Infinity : b[i];
      if (x < y) return true;
      if (x > y) return false;
    }
    return false;
  }

  return {
    run: run,
    clean: clean,
    verify: verify,
    summarize: summarize,
    makeCalendar: makeCalendar,
    parseDate: parseDate,
    parseDue: parseDue,
    normalizeId: normalizeId,
    fmtDate: fmtDate,
    fmtMd: fmtMd,
    dow: dow,
    DEFAULT_OPTS: DEFAULT_OPTS,
    MIN_PER_DAY: MIN_PER_DAY
  };
});
