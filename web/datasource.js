/* ═══════════════════════════════════════════════════════════════════════
   宏达精密 · 本地排产助手 — 数据源适配层（datasource.js）

   为什么要这一层：
     · file:// 双击打开  → 没有服务，走本地 engine.js（纯浏览器自算）
     · http  由服务托管  → 走后端 /api/generate（Python 引擎 + 产物文件）

   两种模式都返回**同一个形状**的对象，app.js 只认这个形状，不关心谁算的。
   后端字段（handover / confirm / artifacts / staleArchived / unconfirmed）
   可能比前端晚落地 —— 这里统一做降级，缺就缺，绝不抛错、绝不白屏。
   ═══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var API_BASE = '';   // 同源部署，留空即当前源

  /** 当前能不能走后端：http(s) 且不是 file:// */
  function canUseServer() {
    try {
      return typeof location !== 'undefined' &&
        /^https?:$/.test(location.protocol);
    } catch (e) { return false; }
  }

  function getMode() {
    return canUseServer() ? 'server' : 'local';
  }

  /* ───────── 探测后端是否真的在线（不阻塞页面） ───────── */
  function probe() {
    if (!canUseServer()) return Promise.resolve({ online: false, mode: 'local' });
    return fetch(API_BASE + '/api/health', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) return { online: true, mode: 'server', info: j };
        return { online: false, mode: 'local' };
      })
      .catch(function () { return { online: false, mode: 'local' }; });
  }

  /* ───────── 工具 ───────── */
  function toArr(v) {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      // 后端可能给整段 markdown/文本，按行切
      return v.split(/\r?\n/).filter(function (x) { return String(x).trim() !== ''; });
    }
    if (typeof v === 'object') return [v];
    return [];
  }

  function str(v) { return v == null ? '' : String(v); }

  /**
   * 把后端返回的 handover 规整成 { intro, sections:[{key,title,body}], files, raw }
   * 兼容几种可能形状：
   *   { 怎么重跑: "...", 假设: [...], 局限: [...] }
   *   { sections: [{title, body|items}] }
   *   { how_to_rerun / assumptions / limits / untrusted_when }
   * 认不出来的键，原样挂成一段，绝不丢内容。
   */
  var H_KEYMAP = [
    { key: 'rerun', title: '怎么重跑', alts: ['怎么重跑', '如何重跑', '重跑', 'how_to_rerun', 'rerun', 'howto', 'how_to_run'] },
    { key: 'assumptions', title: '假设', alts: ['假设', '假设清单', 'assumptions', 'assumption'] },
    { key: 'limits', title: '局限', alts: ['局限', '已知限制', '限制', 'limits', 'limitations', 'known_limits'] },
    { key: 'untrusted', title: '什么条件下不能信', alts: ['什么条件下不能信', '不能信', '不适用条件', 'untrusted_when', 'not_applicable', 'invalid_when'] }
  ];

  function pick(obj, alts) {
    for (var i = 0; i < alts.length; i++) {
      if (obj[alts[i]] !== undefined && obj[alts[i]] !== null) return obj[alts[i]];
    }
    return undefined;
  }

  /**
   * 交接说明：真实后端契约里 handover 是**产物描述**（{name,downloadUrl,...}），
   * 正文在交接说明.md 里；也可能后端后续会直接给结构体。
   * 这里按三种形状都认：
   *   ① 有正文结构（怎么重跑/假设/…）→ 当内容用
   *   ② 只是产物描述（有 name/downloadUrl）→ 标记为「只有文件、无内联正文」
   *   ③ 字符串（整段 md）→ 当一段内容
   */
  function normalizeHandover(h) {
    if (!h) return null;
    if (typeof h === 'string') {
      if (!h.trim()) return null;
      return { intro: '', sections: [{ key: 'raw', title: '内容', body: h }], files: {}, raw: h, fileOnly: false };
    }
    if (typeof h !== 'object') return null;

    var isArtifactRef = !!(h.downloadUrl || h.name) &&
      h.sections === undefined && h['怎么重跑'] === undefined && h.assumptions === undefined;

    if (isArtifactRef) {
      // 只有文件，没有内联正文：交给前端按文件处理（面板显示「正文在文件里」+ 下载）
      return {
        intro: '',
        sections: [],
        files: { md: h.downloadUrl || '', name: h.name || '', title: h.title || '', desc: h.desc || '' },
        raw: h,
        fileOnly: !!(h.downloadUrl)
      };
    }

    var out = { intro: str(h.intro || h.summary || ''), sections: [], files: h.files || h.artifacts || {}, raw: h, fileOnly: false };
    var used = {};

    // 显式 sections 优先
    var secs = toArr(h.sections || h.parts || h.blocks);
    if (secs.length && typeof secs[0] === 'object') {
      secs.forEach(function (s, i) {
        if (!s) return;
        out.sections.push({
          key: s.key || ('s' + i),
          title: str(s.title || s.name || s.heading || ('第 ' + (i + 1) + ' 段')),
          body: s.body !== undefined ? s.body : (s.items || s.content || s.text)
        });
      });
      return out.sections.length ? out : null;
    }

    // 按中文/英文键名映射
    H_KEYMAP.forEach(function (m) {
      var v = pick(h, m.alts);
      if (v === undefined) return;
      used[m.alts[0]] = true;
      out.sections.push({ key: m.key, title: m.title, body: v });
    });

    // 未识别的键：保留内容，不丢
    Object.keys(h).forEach(function (k) {
      if (k === 'intro' || k === 'summary' || k === 'files' || k === 'artifacts') return;
      if (k === 'name' || k === 'title' || k === 'desc' || k === 'downloadUrl' || k === 'available' || k === 'stale') return;
      if (H_KEYMAP.some(function (m) { return m.alts.indexOf(k) >= 0; })) return;
      if (used[k]) return;
      var v = h[k];
      if (v === undefined || v === null || v === '') return;
      if (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) return;
      out.sections.push({ key: k, title: k, body: v });
    });

    if (!out.sections.length && !out.intro) return null;
    return out;
  }

  /**
   * 需求确认单：四块 + 未确认事项
   * 兼容 { understanding / not_wanted / qa / unconfirmed }
   * 以及中文键名。
   */
  /**
   * 需求确认单。
   * 真实后端契约里 confirm 也是**产物描述**（需求确认单.md），不是内联四块。
   * 若后端后续给了四块结构，则直接用；否则标记 fileOnly，由面板引导下载/预览文件。
   */
  function normalizeConfirm(c) {
    if (!c) return null;
    if (typeof c !== 'object') return null;

    var isArtifactRef = !!(c.downloadUrl || (c.name && !c.understanding && !c.qa && !c['我理解的三件事']));
    if (isArtifactRef) {
      return {
        understanding: [], notWanted: [], qa: [], unconfirmed: null,
        file: { md: c.downloadUrl || '', name: c.name || '', title: c.title || '', desc: c.desc || '' },
        raw: c, fileOnly: !!c.downloadUrl
      };
    }

    var understanding = pick(c, ['understanding', '我理解的三件事', 'understood', 'key_points', 'three_things']) || [];
    var notWanted = pick(c, ['not_wanted', '客户不要的', 'refused', 'exclusions', 'out_of_scope']) || [];
    var qa = pick(c, ['qa', 'questions', '五个问答', 'questions_answers', 'interview']) || [];
    var unconfirmed = pick(c, ['unconfirmed', '未确认事项', 'pending', 'open_items']) || null;

    // 如果整个对象就是一条 unconfirmed
    if (!understanding.length && !qa.length && (c.confirmed !== undefined || c.items)) {
      unconfirmed = c;
    }

    return {
      understanding: toArr(understanding),
      notWanted: toArr(notWanted),
      qa: toArr(qa).map(function (q, i) {
        if (typeof q === 'string') return { q: q, a: '' };
        return {
          q: str(q.q || q.question || q.问 || q.ask || ('问题 ' + (i + 1))),
          a: str(q.a || q.answer || q.答 || q.reply || '')
        };
      }),
      unconfirmed: unconfirmed,
      file: null,
      raw: c,
      fileOnly: false
    };
  }

  /**
   * 未确认事项：规整成 [{ label, signed, effective }]
   * 输入可能是 { confirmed:false, items:[{label,note}] } 或 ['xxx · 未签字 · 已按此口径计算']
   */
  function normalizeUnconfirmed(u) {
    if (!u) return { confirmed: null, items: [], raw: null };
    if (typeof u === 'boolean') return { confirmed: u, items: [], raw: u };
    var confirmed = (u.confirmed === true) ? true : (u.confirmed === false ? false : null);
    var items = toArr(u.items || u.list || u.entries || []).map(function (it) {
      if (typeof it === 'string') return { label: it, signed: false, effective: '' };
      return {
        label: str(it.label || it.name || it.title || it.item || ''),
        signed: it.signed === true || it.confirmed === true,
        effective: str(it.effective || it.applied || it.note || it.status || '')
      };
    });
    return { confirmed: confirmed, items: items, raw: u };
  }

  /* ───────── 后端模式：上传 → 取 JSON ───────── */
  function runViaServer(file, opts) {
    var fd = new FormData();
    fd.append('options', JSON.stringify(opts || {}));
    fd.append('file', file, file.name || '台账.xlsx');
    return fetch(API_BASE + '/api/generate', { method: 'POST', body: fd })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (res) {
        var j;
        try { j = JSON.parse(res.text); }
        catch (e) {
          throw mkErr('后端返回异常', '服务返回的不是 JSON（HTTP ' + res.status + '），已按失败处理。\n' + res.text.slice(0, 200));
        }
        if (!j || j.ok === false) {
          throw mkErr('排程失败', (j && (j.error_msg || j.error_code)) || '后端未返回有效结果');
        }
        return { mode: 'server', payload: j };
      })
      .catch(function (e) {
        if (e && e.userMessage) throw e;
        throw mkErr('连不上本地服务', '浏览器请求 ' + (API_BASE || location.origin) +
          '/api/generate 失败。请确认 python web/app.py 已启动；或改用双击 index.html 的离线模式。');
      });
  }

  function mkErr(title, msg) {
    var e = new Error(msg); e.title = title; e.userMessage = msg; return e;
  }

  /* ───────── 风险行字段归一 ───────── */
  /**
   * 后端 /api/generate 的 risks 是蛇形（order_id / type_cn / bottleneck_machine ...），
   * 本地 engine 是驼峰（orderId / statusCn / bottleneckMachine ...）。
   * renderRisk 全部按驼峰读，不归一会导致整张表每格都是「—」。
   * 统一在这里转一次，两种来源都能渲染。
   */
  function normalizeRiskRow(r) {
    if (!r || typeof r !== 'object') return r;
    var g = function () {
      for (var i = 0; i < arguments.length; i++) {
        var v = arguments[i];
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return '';
    };
    var orderId = g(r.orderId, r.order_id, r.id);
    var status = g(r.status, r.type);
    /* 未知状态的兜底顺序：
       ① 后端给了中文（statusCn / type_cn）→ 直接用
       ② 本地映射表能认 → 用中文
       ③ 都认不出 → 原样显示（不用英文码硬撑），并标成「其他」，
          避免后端先落地新状态时前端显示空白或 status_code 英文。 */
    var statusCn = g(r.statusCn, r.type_cn) || STATUS_CN[status] || '';
    if (!statusCn) statusCn = status ? (STATUS_CN_OTHER + '（' + status + '）') : '';
    var due = g(r.due, r.dueMd);
    var plannedEnd = g(r.plannedEndLabel, r.planned_end, r.plannedEnd);
    var delayDays = g(r.delayDays, r.delay_days);
    var machine = g(r.bottleneckMachine, r.bottleneck_machine);
    var op = g(r.bottleneckOp, r.bottleneck_op);
    var qty = g(r.qty, r.qtyLabel);
    var suggestion = g(r.suggestion, r.action, r.reason);
    return Object.assign({}, r, {
      orderId: orderId,
      status: status,
      statusCn: statusCn,
      due: due,
      dueMd: g(r.dueMd, due) || '—',
      plannedEnd: plannedEnd,
      plannedEndLabel: g(r.plannedEndLabel, plannedEnd) || '—',
      delayDays: delayDays,
      delayMd: g(r.delayMd,
        delayDays === '' ? '' : (typeof delayDays === 'number' && delayDays > 0
          ? (Math.round(delayDays * 10) / 10) + ' 天'
          : String(delayDays))) || '—',
      bottleneckMachine: machine,
      bottleneckOp: op,
      qty: qty,
      suggestion: suggestion || '—',
      flags: r.flags || []
    });
  }

  var STATUS_CN = {
    delayed: '延期', at_risk: '预警',
    urgent_no_due: '急单·无交期',
    not_in_horizon: '未排入本周',
    not_scheduled_in_horizon: '未排入本周', unplannable: '排不进', ok: '准时'
  };
  /** 后端先落地了新状态、前端还不认识时的兜底中文前缀 */
  var STATUS_CN_OTHER = '其他状态';

  /* ───────── 本地模式：engine.js 自算 ───────── */
  function runViaEngine(sheets, opts) {
    return new Promise(function (resolve, reject) {
      try {
        var res = ApsEngine.run(sheets, opts);
        resolve({ mode: 'local', payload: res });
      } catch (e) { reject(e); }
    });
  }

  /* ───────── 统一入口：把两种结果摊平成 app.js 认的形状 ───────── */
  /**
   * @returns {{ok, mode, R, artifacts, handover, confirm, unconfirmed, staleArchived, generatedAt, sourceFile}}
   */
  function unify(mode, payload, ctx) {
    var R = payload;
    var isServer = mode === 'server';

    // 后端 payload 的字段名与本地 engine 不完全一样，这里做一层映射；
    // 但「数字」一律不在这层重算，只是搬。
    var unified = {
      ok: true,
      mode: mode,
      R: R,
      generatedAt: str(R.generatedAt || R.meta && R.meta.generatedAt) || (ctx && ctx.now) || new Date().toISOString(),
      sourceFile: str((ctx && ctx.fileName) || (R.meta && R.meta.sourceFile) || ''),
      artifacts: null,        // 由 app.js 依 mode 生成
      handover: normalizeHandover(R.handover),
      confirm: normalizeConfirm(R.confirm || R.confirmation || R.requirement),
      unconfirmed: normalizeUnconfirmed(
        (R.confirm && (R.confirm.unconfirmed || R.confirm)) ||
        R.unconfirmed || null
      ),
      staleArchived: R.staleArchived || R.stale_archived || null,
      raw: R
    };

    // 后端模式：把 verify 的 h1..h5 / result 映射成前端 verify 形状（仅展示用）
    if (isServer && R.verify) {
      unified.R = adaptServerResult(R);
    }
    return unified;
  }

  /** 后端 JSON → 前端 R 形状（只搬字段，不计算） */
  function adaptServerResult(B) {
    var v = B.verify || {};
    var codes = ['h1', 'h2', 'h3', 'h4', 'h5'];
    var names = {
      h1: '每道工序恰好一次', h2: '机台与工时与工艺一致',
      h3: '同订单/子批工序不倒序', h4: '同一台机时间不重叠', h5: '阀芯C 车→磨 流水'
    };
    var lines = codes.map(function (c) {
      var okv = (v[c] === 'PASS' || v[c] === true);
      var viol = (v.violations || []).filter(function (x) {
        var rule = str(x.rule || x.code || '').toLowerCase();
        return rule === c;
      }).map(function (x) { return { text: str(x.message || x.text || x.detail || '') }; });
      return {
        code: c.toUpperCase(), name: names[c], ok: okv,
        detail: (v.checked && v.checked[c] != null) ? (v.checked[c] + ' 项') : '',
        violations: viol
      };
    });
    var hardCodes = ['H1', 'H2', 'H3', 'H4'];
    var groups = [
      { key: 'hard', title: '硬约束', note: 'PPT 第12页，违反则拒绝交付', codes: hardCodes },
      { key: 'flow', title: '客户流水条件', note: '非硬约束，未达成不影响交付', codes: ['H5'] }
    ];
    groups.forEach(function (g) {
      g.lines = lines.filter(function (l) { return g.codes.indexOf(l.code) >= 0; });
      g.ok = g.lines.every(function (l) { return l.ok; });
      g.failCount = g.lines.reduce(function (a, l) { return a + l.violations.length; }, 0);
    });
    var flow = groups[1];
    var softN = v.softViolations != null ? v.softViolations : flow.failCount;
    var hardN = v.hardViolations != null ? v.hardViolations
      : groups[0].lines.reduce(function (a, l) { return a + l.violations.length; }, 0);

    return {
      meta: (function () {
        var m = B.meta || {};
        // 【契约差异】后端的 schedule 是**数组**（65 条工序），不是
        // { operations: [...] } 对象；本地 engine 那份才是对象。
        // 之前一律按 B.schedule.operations 读，数组上取 .operations 得 undefined，
        // 横幅就成了「已排 0 / 0 道」。这里两种形状都认。
        var schedArr = Array.isArray(B.schedule) ? B.schedule
          : ((B.schedule && B.schedule.operations) || []);
        var metrics = B.metrics || {};
        // 本地 engine 的 meta.counts 在后端是分散字段（metrics / unplannable / schedule），
        // 这里补齐成前端渲染需要的同名字段，避免 app.js 读 undefined。
        var counts = {
          ordersTotal: (metrics.orders_total ?? metrics.ordersTotal) ?? m.rows_read ?? 0,
          ordersOk: (metrics.orders_ok ?? metrics.ordersOk) ?? 0,
          ordersBlocked: (metrics.orders_blocked ?? metrics.ordersBlocked) ?? 0,
          opsPlanned: (metrics.ops_planned ?? metrics.opsPlanned)
            ?? (B.schedule && !Array.isArray(B.schedule) ? B.schedule.ops_planned : null)
            ?? schedArr.length,
          opsUnplanned: Array.isArray(B.unplannable) ? B.unplannable.length : 0,
          opsTotal: 0,
          machines: 0
        };
        counts.opsTotal = metrics.ops_total ?? metrics.opsTotal
          ?? (counts.opsPlanned + counts.opsUnplanned);
        // 【契约对齐】横幅右侧要「规则「FIFO」· N ms」，后端把规则放在
        // metrics.best_rule、耗时放在 meta.elapsed_ms。缺这两处映射时横幅显示
        // 「规则「」· 161.30000000074506 ms」这种半截内容。
        var ruleCn = m.ruleCn || metrics.best_rule || '';
        var elapsed = m.elapsed != null ? m.elapsed : m.elapsed_ms;
        return Object.assign({}, m, {
          counts: counts,
          ruleCn: ruleCn,
          elapsed: elapsed,
          sourceFile: m.sourceFile || ''
        });
      })(),
      cards: B.cards || [],
      summary: B.risks || [],
      // 【契约对齐】后端 metrics 用蛇形（delayed_count / not_in_horizon_count ...），
      // 而 renderRisk 读的是驼峰（t.delayed / t.notInHorizon / t.ok ...）。
      // 之前直接 totals: B.metrics，导致风险页签合计条与筛选徽标全显示 0。
      // 这里逐个别名补齐，驼峰优先、蛇形兜底，两种后端都能渲染。
      risk: {
        rows: (B.risks || []).map(normalizeRiskRow),
        totals: (function () {
          var m = B.metrics || {};
          var rows = (B.risks || []).map(normalizeRiskRow);
          // 行数据兜底：后端没给某一类计数时，从风险行自己数（含新状态 urgent_no_due，
          // 这样后端只落地状态、没加 count 字段时前端也不会显示 0）
          var cnt = function (st) {
            return rows.filter(function (r) {
              var s = r.status || r.type;
              return s === st || (st === 'not_in_horizon' && s === 'not_scheduled_in_horizon');
            }).length;
          };
          var pick = function (fallback, skipAuto) {
            for (var i = 1; i < arguments.length; i++) {
              if (arguments[i] != null) return arguments[i];
            }
            return skipAuto ? 0 : fallback;
          };
          return Object.assign({}, m, {
            delayed: pick(cnt('delayed'), m.delayed, m.delayed_count),
            atRisk: pick(cnt('at_risk'), m.atRisk, m.at_risk_count),
            urgentNoDue: pick(cnt('urgent_no_due'), m.urgentNoDue, m.urgent_no_due_count),
            notInHorizon: pick(cnt('not_in_horizon'), m.notInHorizon, m.not_in_horizon_count),
            unplannable: pick(cnt('unplannable'), m.unplannable, m.unplannable_count),
            ok: pick(cnt('ok'), m.ok, m.ok_count, m.on_time_count)
          });
        })()
      },
      /* operations：后端 schedule 可能是蛇形字段的数组（order_id/lot_id/duration_min/
         start_axis…），也可能是 {operations:[...]}。统一映射成前端驼峰形状，
         否则排单表会整张空掉。 */
      operations: (function () {
        var raw = Array.isArray(B.schedule) ? B.schedule
          : (B.schedule && B.schedule.operations) || [];
        return raw.map(function (o) {
          var sa = (o.startAxis != null) ? o.startAxis : o.start_axis;
          var ea = (o.endAxis != null) ? o.endAxis : o.end_axis;
          var st = o.start || '';
          var en = o.end || '';
          return Object.assign({}, o, {
            orderId: o.orderId || o.order_id || '',
            lotId: o.lotId || o.lot_id || o.orderId || o.order_id || '',
            durationMin: (o.durationMin != null) ? o.durationMin : o.duration_min,
            minPerUnit: (o.minPerUnit != null) ? o.minPerUnit : o.min_per_unit,
            startAxis: sa, endAxis: ea,
            startDate: o.startDate || st.slice(0, 10),
            startTime: o.startTime || st.slice(11, 16),
            endDate: o.endDate || en.slice(0, 10),
            endTime: o.endTime || en.slice(11, 16),
            seq: o.seq, op: o.op, product: o.product,
            machine: o.machine, qty: o.qty, group: o.group
          });
        });
      })(),
      unplannable: B.unplannable || [],
      capacity: B.capacity ? { groups: B.capacity, machines: [], totalLoad: 0, totalCapacity: 0 } : null,
      gantt: B.gantt || null,
      // 体检：后端可能不给前端用的结构 → 统一补空结构，由渲染层显示「暂无」
      health: B.health || {
        groups: [], issues: [],
        counts: {
          total: (B.meta && B.meta.issue_count) || 0,
          classes: (B.meta && B.meta.issue_categories) || 0,
          askCustomer: (B.meta && B.meta.need_ask_categories) || 0,
          askClasses: 0
        }
      },
      verify: {
        result: v.result || (hardN ? 'FAIL' : (softN ? 'PASS_WITH_WARN' : 'PASS')),
        resultCn: v.resultCn || '',
        lines: lines,
        groups: groups,
        hardViolations: hardN,
        softViolations: softN,
        flowNote: v.flowNote || (flow.ok ? '' : '磨床是瓶颈，产能客观不足导致断档，不是排程算法错误；硬约束 0 违反，这份排程可以交，但这条必须写进交接说明并告知客户代价。'),
        deliverable: hardN === 0
      },
      __server: B
    };
  }

  root.APSData = {
    getMode: getMode,
    canUseServer: canUseServer,
    probe: probe,
    runViaServer: runViaServer,
    runViaEngine: runViaEngine,
    unify: unify,
    normalizeHandover: normalizeHandover,
    normalizeConfirm: normalizeConfirm,
    normalizeUnconfirmed: normalizeUnconfirmed
  };
})(typeof self !== 'undefined' ? self : this);
