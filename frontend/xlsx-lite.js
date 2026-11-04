/*!
 * xlsx-lite.js — 极简 .xlsx 读取器（零依赖，Node 与浏览器通用）
 * ---------------------------------------------------------------------
 * 只做三件事：
 *   1. 解 ZIP（stored / deflate），Node 用 zlib，浏览器用 DecompressionStream('deflate-raw')
 *   2. 读 xl/workbook.xml + rels 拿到 sheet 名与顺序
 *   3. 读 sharedStrings / styles / 每个 sheet，输出 { sheet名: [[单元格值…]…] }
 *
 * 不支持：ZIP64、加密工作簿、图表、合并单元格展开（只取左上角值，够用）
 * 用法：
 *   Node   : await require('./xlsx-lite.js').readWorkbook(buffer)
 *   浏览器 : await XlsxLite.readWorkbook(arrayBuffer)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XlsxLite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ─────────────── 错误（中文，给用户看） ─────────────── */
  function XlsxError(title, message) {
    var e = new Error(message);
    e.name = 'XlsxError';
    e.title = title;
    e.userMessage = message;
    return e;
  }

  /* ─────────────── 1. ZIP ─────────────── */

  function u16(dv, p) { return dv.getUint16(p, true); }
  function u32(dv, p) { return dv.getUint32(p, true); }

  function findEOCD(bytes) {
    var min = Math.max(0, bytes.length - 66000);
    for (var i = bytes.length - 22; i >= min; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  /** 解析中央目录 → { name: {method, compressedSize, localOffset} } */
  function readZipIndex(bytes, dv) {
    var eocd = findEOCD(bytes);
    if (eocd < 0) throw XlsxError('文件格式不对', '这不是一个有效的 Excel 工作簿（.xlsx 是 ZIP 包，找不到目录结构）。请确认文件没有被改扩展名。');
    var count = u16(dv, eocd + 10);
    var cdOffset = u32(dv, eocd + 16);
    if (cdOffset === 0xffffffff) throw XlsxError('文件过大', '该文件使用了 ZIP64 格式，本工具暂不支持。请另存为普通 .xlsx。');

    var index = {};
    var p = cdOffset;
    for (var i = 0; i < count; i++) {
      if (u32(dv, p) !== 0x02014b50) break;
      var method = u16(dv, p + 10);
      var compSize = u32(dv, p + 20);
      var uncompSize = u32(dv, p + 24);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOffset = u32(dv, p + 42);
      var name = utf8(bytes, p + 46, nameLen);
      index[name] = { method: method, compSize: compSize, uncompSize: uncompSize, localOffset: localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return index;
  }

  function utf8(bytes, offset, len) {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes.subarray(offset, offset + len));
    }
    var s = '';
    for (var i = offset; i < offset + len; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }

  function inflateRawNode(data) {
    var zlib = require('zlib');
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(data)));
  }

  function inflateRawBrowser(data) {
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(XlsxError('浏览器不支持', '当前浏览器不支持本地解压（DecompressionStream）。请用 Chrome / Edge 104 以上版本打开本页面。'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  function inflateRaw(data) {
    if (typeof require === 'function' && typeof process !== 'undefined' && process.versions && process.versions.node) {
      return Promise.resolve(inflateRawNode(data));
    }
    return inflateRawBrowser(data);
  }

  /** 取出某个条目的原始字节 */
  function extractEntry(bytes, dv, entry) {
    var p = entry.localOffset;
    if (u32(dv, p) !== 0x04034b50) throw XlsxError('工作簿损坏', 'ZIP 局部头校验失败，文件可能下载不完整。请重新获取台账。');
    var nameLen = u16(dv, p + 26);
    var extraLen = u16(dv, p + 28);
    var start = p + 30 + nameLen + extraLen;
    var raw = bytes.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Promise.resolve(raw);
    if (entry.method === 8) return inflateRaw(raw);
    throw XlsxError('压缩方式不支持', '该工作簿使用了不常见的压缩方式（method=' + entry.method + '），请用 Excel 另存为一次。');
  }

  function readText(bytes, dv, index, name) {
    var entry = index[name];
    if (!entry) return Promise.resolve(null);
    return extractEntry(bytes, dv, entry).then(function (u8) {
      if (u8[0] === 0xff && u8[1] === 0xfe) return decodeUtf16(u8, 2);
      return utf8(u8, 0, u8.length);
    });
  }

  function decodeUtf16(u8, from) {
    var s = '';
    for (var i = from; i + 1 < u8.length; i += 2) s += String.fromCharCode(u8[i] | (u8[i + 1] << 8));
    return s;
  }

  /* ─────────────── 2. 极简 XML 取值 ─────────────── */

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, g) {
      if (g[0] === '#') {
        var code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      switch (g) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return "'";
        default: return m;
      }
    });
  }

  function attr(tagText, name) {
    var re = new RegExp('\\b' + name.replace(/[:.]/g, '\\$&') + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
    var m = tagText.match(re);
    return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : null;
  }

  function tags(xml, tagName) {
    var out = [];
    var re = new RegExp('<' + tagName + '\\b([^>]*?)(/?)>', 'g');
    var m;
    while ((m = re.exec(xml))) out.push({ attrs: m[1], selfClose: m[2] === '/', index: m.index });
    return out;
  }

  function innerText(xml) {
    // 去掉所有标签，保留文本
    return decodeEntities(xml.replace(/<[^>]*>/g, ''));
  }

  /* ─────────────── 3. 工作簿结构 ─────────────── */

  function parseWorkbook(xml) {
    var sheets = [];
    var re = /<sheet\b([^>]*)\/?>/g, m;
    while ((m = re.exec(xml))) {
      sheets.push({
        name: attr(m[1], 'name'),
        sheetId: attr(m[1], 'sheetId'),
        rid: attr(m[1], 'r:id') || attr(m[1], 'id')
      });
    }
    return sheets;
  }

  function parseRels(xml) {
    var map = {};
    var re = /<Relationship\b([^>]*)\/?>/g, m;
    while ((m = re.exec(xml))) {
      var id = attr(m[1], 'Id'), target = attr(m[1], 'Target');
      if (id && target) map[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    return map;
  }

  function parseSharedStrings(xml) {
    var list = [];
    var re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g, m;
    while ((m = re.exec(xml))) {
      if (m[1] === undefined) { list.push(''); continue; }
      var body = m[1];
      // 富文本：<r><t>…</t></r> 多段拼接；跳过 <rPh>（注音）
      body = body.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      var parts = [];
      var tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g, tm;
      while ((tm = tre.exec(body))) parts.push(decodeEntities(tm[1]));
      if (!parts.length) parts.push(decodeEntities(body));
      list.push(parts.join(''));
    }
    return list;
  }

  var DATE_FMT_BUILTIN = { 14: 1, 15: 1, 16: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1, 22: 1, 45: 1, 46: 1, 47: 1 };

  function parseStyles(xml) {
    var custom = {};
    var nre = /<numFmt\b([^>]*)\/?>/g, nm;
    while ((nm = nre.exec(xml))) {
      var id = parseInt(attr(nm[1], 'numFmtId'), 10);
      var code = attr(nm[1], 'formatCode') || '';
      custom[id] = /[ymdhs]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, ''));
    }
    var isDate = {};
    var cellXfsMatch = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
    if (cellXfsMatch) {
      var xre = /<xf\b([^>]*)\/?>/g, xm, i = 0;
      while ((xm = xre.exec(cellXfsMatch[1]))) {
        var fmtId = parseInt(attr(xm[1], 'numFmtId') || '0', 10);
        isDate[i] = !!(DATE_FMT_BUILTIN[fmtId] || custom[fmtId]);
        i++;
      }
    }
    return isDate;
  }

  function serialToDateStr(n) {
    var ms = Math.round(n) * 86400000;
    var t = new Date(Date.UTC(1899, 11, 30) + ms);
    var y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
    var hh = t.getUTCHours(), mm = t.getUTCMinutes();
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    if (hh || mm) return y + '-' + p(m) + '-' + p(d) + 'T' + p(hh) + ':' + p(mm);
    return y + '-' + p(m) + '-' + p(d);
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref);
    if (!m) return -1;
    var s = 0;
    for (var i = 0; i < m[1].length; i++) s = s * 26 + (m[1].charCodeAt(i) - 64);
    return s - 1;
  }

  /** 解析单个工作表 XML → 二维数组 */
  function parseSheet(xml, shared, isDateStyle) {
    var rows = [];
    var rowRe = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
    var rm;
    while ((rm = rowRe.exec(xml))) {
      var rowAttr = rm[1];
      var body = rm[3] || '';
      var rIdx = parseInt(attr(rowAttr, 'r'), 10);
      if (!isFinite(rIdx)) rIdx = rows.length + 1;
      var cells = [];
      var cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
      var cm;
      while ((cm = cellRe.exec(body))) {
        var cAttr = cm[1];
        var cBody = cm[3] || '';
        var ref = attr(cAttr, 'r') || '';
        var ci = colIndex(ref);
        if (ci < 0) ci = cells.length;
        var t = attr(cAttr, 't') || 'n';
        var s = parseInt(attr(cAttr, 's') || '-1', 10);
        var vMatch = cBody.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        var vRaw = vMatch ? decodeEntities(vMatch[1]) : null;
        var val = null;

        if (t === 's') {
          var si = parseInt(vRaw, 10);
          val = shared[si] !== undefined ? shared[si] : '';
        } else if (t === 'inlineStr') {
          var isM = cBody.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
          val = isM ? innerText(isM[1]) : '';
        } else if (t === 'str') {
          val = vRaw === null ? '' : vRaw;
        } else if (t === 'b') {
          val = vRaw === '1';
        } else if (t === 'e') {
          val = vRaw;
        } else if (vRaw !== null && vRaw !== '') {
          var num = parseFloat(vRaw);
          if (isFinite(num)) {
            val = (isDateStyle && isDateStyle[s]) ? serialToDateStr(num) : num;
          } else val = vRaw;
        }
        cells[ci] = val;
        for (var k = 0; k < cells.length; k++) if (cells[k] === undefined) cells[k] = null;
      }
      while (rows.length < rIdx - 1) rows.push([]);
      rows[rIdx - 1] = cells;
    }
    // 补齐每行长度
    var maxLen = 0;
    rows.forEach(function (r) { if (r && r.length > maxLen) maxLen = r.length; });
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i]) rows[i] = [];
      for (var j = 0; j < maxLen; j++) if (rows[i][j] === undefined) rows[i][j] = null;
    }
    return rows;
  }

  /* ─────────────── 4. 主入口 ─────────────── */

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
    if (input && input.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw XlsxError('读取失败', '无法识别的文件数据。');
  }

  function readWorkbook(input) {
    var bytes;
    try { bytes = toBytes(input); } catch (e) { return Promise.reject(e); }
    if (bytes.length < 100) {
      return Promise.reject(XlsxError('文件为空', '文件大小异常（' + bytes.length + ' 字节），请确认选择的是台账文件。'));
    }
    // 老式 .xls（OLE 复合文档）开头是 D0 CF 11 E0
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return Promise.reject(XlsxError('是老版 .xls', '这是 Excel 97-2003 的老格式（.xls）。请用 Excel 打开后「另存为」.xlsx 再上传。'));
    }
    if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      return Promise.reject(XlsxError('不是 Excel 文件', '这个文件不是 Excel 工作簿（.xlsx）。请上传台账 .xlsx 文件。'));
    }

    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var index;
    try { index = readZipIndex(bytes, dv); } catch (e) { return Promise.reject(e); }

    var wbPath = index['xl/workbook.xml'] ? 'xl/workbook.xml' : null;
    if (!wbPath) {
      return Promise.reject(XlsxError('不是 Excel 台账', '这个压缩包里没有 xl/workbook.xml，不像是正常的 Excel 工作簿。'));
    }

    return Promise.all([
      readText(bytes, dv, index, 'xl/workbook.xml'),
      readText(bytes, dv, index, 'xl/_rels/workbook.xml.rels'),
      readText(bytes, dv, index, 'xl/sharedStrings.xml'),
      readText(bytes, dv, index, 'xl/styles.xml')
    ]).then(function (arr) {
      var wbXml = arr[0], relsXml = arr[1] || '', ssXml = arr[2] || '', stXml = arr[3] || '';
      var sheetDefs = parseWorkbook(wbXml);
      if (!sheetDefs.length) throw XlsxError('工作簿无工作表', '这个 Excel 文件里没有工作表。');
      var rels = parseRels(relsXml);
      var shared = ssXml ? parseSharedStrings(ssXml) : [];
      var isDateStyle = stXml ? parseStyles(stXml) : {};

      return Promise.all(sheetDefs.map(function (def) {
        var target = rels[def.rid];
        var candidates = [];
        if (target) candidates.push('xl/' + target);
        if (target) candidates.push(target);
        candidates.push('xl/worksheets/sheet' + def.sheetId + '.xml');
        var path = candidates.filter(function (p) { return index[p]; })[0];
        if (!path) return Promise.resolve([]);
        return readText(bytes, dv, index, path).then(function (xml) {
          return xml ? parseSheet(xml, shared, isDateStyle) : [];
        });
      })).then(function (sheetRows) {
        var out = {};
        sheetDefs.forEach(function (def, i) { out[def.name] = sheetRows[i]; });
        return out;
      });
    });
  }

  return { readWorkbook: readWorkbook, XlsxError: XlsxError };
});
