# -*- coding: utf-8 -*-
"""server/app.py —— 本地服务（标准库 http.server，不用 Flask）。

任务书 N5：「python server/app.py 起本地服务（用标准库 http.server，不要 Flask）」

设计要点
────────
1. **两条路都能跑**：
   · 双击 index.html        → 纯浏览器端（自带 engine.js），零依赖
   · python server/app.py   → 本服务托管前端 + 提供 3 个 API，Excel 产物由后端生成
   两种模式下页面完全一样，只是"谁来算"不同。

2. **口径对齐**：本文件不重新实现排程，而是调用 core/ 的 Python 引擎；
   Python 引擎的默认参数与前端 engine.js 的 DEFAULT_OPTS 一一对应（见 OPT_MAP），
   保证两边算出来的数字一致。

3. **3 个 API**（附录 B §B6 / 附录 A §⑤）：
   GET  /api/health                探活
   POST /api/generate              上传台账 → 排程 → 返回 JSON
   GET  /api/download/<filename>   下载四件产物（RFC 5987 中文名）

4. **异常全部转中文**，不白屏、不吐 Traceback（任务书 N5 明确要求）。
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import traceback
import urllib.parse
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 把项目根加入 sys.path，便于 import core / config
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import config
from core import workcal as cal
from core import cleaner, checker, instance, reader, report, solver

WEB_DIR = os.path.join(ROOT, "frontend")
OUT_DIR = os.path.join(ROOT, "out")
VERSION = "1.0.0"

# 下载白名单（防目录穿越）
ALLOWED_DOWNLOADS = {
    "排单表.xlsx": "排单表.xlsx",
    "甘特图.html": "甘特图.html",
    "风险清单.xlsx": "风险清单.xlsx",
    "体检报告.md": "体检报告.md",
    "校验报告.txt": "校验报告.txt",
    "交接说明.md": "交接说明.md",
    "需求确认单.md": "需求确认单.md",
    "schedule.json": "schedule.json",
    "clean.json": "clean.json",
}


# ============================================================
# 参数映射：前端 options → Python RunOptions
# ============================================================
# 前端 DEFAULT_OPTS（engine.js）：
#   startDate, allowSwap: true, enableGrd02: false, enableCnc03: false,
#   emptyQty: 'skip', lotSize: 20, flowOn: true, flowProduct: '阀芯C',
#   flowGap: 30, threeShift: false, year: 2026
#
# 对齐关系：
#   allowSwap  → allow_mill_substitute（允许换机台 = 阀体A 铣可走其他立加）
#   enableGrd02 → enable_grd02（但前端默认「磨点名」，故还要 morning_as_group）
#   flowOn/flowGap → flow_interp 与 lot_size
#   threeShift → three_shift

def opts_from_payload(payload: dict):
    """前端 JSON → RunOptions + 起始日。"""
    p = payload or {}

    def b(key, default=False):
        v = p.get(key, default)
        return bool(v)

    allow_swap = b("allowSwap", True)
    enable_grd02 = b("enableGrd02", False)
    enable_cnc03 = b("enableCnc03", False)
    three_shift = b("threeShift", False)
    lot_size = int(p.get("lotSize") or config.DEFAULT_LOT_SIZE)

    # 「允许换机台」= 点名机台不可用时允许走同组其他机台
    opts = config.RunOptions(
        allow_mill_substitute=allow_swap,
        morning_as_group=(enable_grd02 or allow_swap),
        enable_grd02=enable_grd02,
        enable_cnc03=enable_cnc03,
        three_shift=three_shift,
        lot_size=max(1, lot_size),
        flow_interp="a",
        out_dir=OUT_DIR,
    )

    origin = p.get("startDate")
    return opts, (origin or None)


# ============================================================
# 业务：跑一遍全流程，返回 JSON
# ============================================================


RESULT_CN = {
    "PASS": "通过，可以用",
    "PASS_WITH_WARN": "硬约束通过 / 流水条件未达成，可交付但须说明代价",
    "PASS_WITH_SKIP": "通过（有未排入）",
    "FAIL": "未通过，不可交付",
}

ARTIFACT_META = {
    "排单表.xlsx": ("排单表", "这周每天每台机干什么，可打印贴墙"),
    "甘特图.html": ("甘特图", "整周节奏，断网双击可看"),
    "风险清单.xlsx": ("交期风险清单", "哪几单要赶不上、卡在哪台机"),
    "体检报告.md": ("数据体检报告", "台账里哪些数不能用、为什么要问客户"),
    "校验报告.txt": ("校验报告", "五条规则的逐条结论"),
    "交接说明.md": ("交接说明", "下周怎么重跑、假设与局限"),
    "需求确认单.md": ("需求确认单", "给客户签字用的一页纸"),
    "clean.json": ("清洗结果", "中间产物，调试用"),
    "schedule.json": ("排程结果", "中间产物，调试用"),
}


def _artifact(name, present):
    """单件产物描述（含可下载 URL）。"""
    if name not in present:
        return {"name": name, "title": ARTIFACT_META.get(name, (name, ""))[0],
                "desc": ARTIFACT_META.get(name, (name, ""))[1],
                "available": False, "downloadUrl": None, "stale": False}
    title, desc = ARTIFACT_META.get(name, (name, ""))
    return {"name": name, "title": title, "desc": desc, "available": True,
            "downloadUrl": "/api/download/" + urllib.parse.quote(name, safe=""),
            "stale": False}


def _artifacts(names, stale=False):
    """产物清单。stale=True 时不给下载链接（不鼓励下载旧文件）。"""
    out = []
    for n in names or []:
        title, desc = ARTIFACT_META.get(n, (n, ""))
        out.append({
            "name": n, "title": title, "desc": desc, "available": True,
            "stale": bool(stale),
            "downloadUrl": (None if stale
                            else "/api/download/" + urllib.parse.quote(n, safe="")),
        })
    return out


def _archive_stale(out_dir, names):
    """把旧产物移到 out/_stale/（精确文件名，绝不用通配符）。"""
    stale_dir = os.path.join(out_dir, "_stale")
    moved = []
    for name in names:
        src = os.path.join(out_dir, name)
        if not os.path.isfile(src):
            continue
        try:
            os.makedirs(stale_dir, exist_ok=True)
            dst = os.path.join(stale_dir, name)
            if os.path.exists(dst):
                import datetime as _dt3
                stamp = _dt3.datetime.now().strftime("%Y%m%d-%H%M%S")
                stem, ext = os.path.splitext(name)
                dst = os.path.join(stale_dir, stem + "." + stamp + ext)
            os.replace(src, dst)
            moved.append(name)
        except OSError:
            continue
    return moved


class ApiError(Exception):
    def __init__(self, code: str, msg: str, hint: str = ""):
        self.code = code
        self.msg = msg
        self.hint = hint
        super().__init__(msg)


def _jsonable(obj):
    import datetime as _dt
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, _dt.datetime):
        return obj.strftime("%Y-%m-%dT%H:%M")
    if isinstance(obj, _dt.date):
        return obj.isoformat()
    if isinstance(obj, set):
        return sorted(obj)
    if isinstance(obj, float):
        return round(obj, 4)
    return obj


def run_pipeline(xlsx_path: str, payload: dict, want_files: bool = True,
                 display_name: str = None) -> dict:
    """读台账 → 清洗 → 实例 → 排程 → 校验 → 出产物。返回 API 响应体。

    display_name：给计划员看的台账文件名。上传路径在临时目录里叫
    upload-xxxx.xlsx，直接写进交接说明会露出无意义的随机串，所以由
    调用方传原始文件名（浏览器上传时的 name）。
    """
    import datetime as _dt
    t0 = _dt.datetime.now()
    src_name = display_name or os.path.basename(xlsx_path)

    # ---- 1. 读 ----
    try:
        raw = reader.read_workbook(xlsx_path)
    except reader.NotXlsxError as e:
        raise ApiError("NOT_XLSX", str(e),
                       "如果文件是 .xls 或 .csv，请先用 Excel 另存为 .xlsx")
    except reader.MissingSheetError as e:
        raise ApiError("MISSING_SHEET", str(e),
                       "台账需要「订单 / 设备 / 工艺路线」三个工作表")
    except reader.HeaderMismatchError as e:
        raise ApiError("HEADER_MISMATCH", str(e), "请检查第 2 行表头是否被改过")
    except reader.EmptyDataError as e:
        raise ApiError("EMPTY_DATA", str(e), "台账里可能只有表头，没有数据行")
    except Exception as e:
        raise ApiError("INTERNAL", f"读取台账失败：{e}")

    # ---- 2. 原点 + 窗口 ----
    opts, origin_str = opts_from_payload(payload)
    if origin_str:
        try:
            start = _dt.date.fromisoformat(str(origin_str)[:10])
        except ValueError:
            raise ApiError("BAD_ORIGIN", f"起始日格式不对：{origin_str}",
                           "请用 YYYY-MM-DD")
    else:
        note = _read_a1_note(xlsx_path)
        m = re.search(r"(\d{4})[-/\.](\d{1,2})[-/\.](\d{1,2})", note or "")
        if m:
            ref = _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        else:
            ref = _dt.date.today()
        start = config.horizon_start(ref)

    horizon = cal.make_horizon(start, opts.window_days)
    pline = config.params_line(opts, start)

    # ---- 3. 清洗 ----
    clean = cleaner.clean(raw, opts, horizon)
    if not clean["orders"]:
        raise ApiError("NO_PLANNABLE",
                       f"没有可排订单（{len(clean['blocked'])} 单被闸门拦住）",
                       "请看返回里的 issues / blocked，先补数据再重跑")

    # ---- 4. 实例 + 排程 ----
    ops = instance.build_ops(clean, opts)
    res = solver.solve_all(ops, clean, horizon, opts)
    sched, unplan, ev = res["scheduled"], res["unplannable"], res["eval"]

    # ---- 5. 校验 ----
    rep = checker.verify_all(ops, clean, horizon, opts, unplan)

    # ---- 6. 产物 ----
    files = []
    stale_archived = []
    risk_rows = report.build_risk_rows(sched, clean, horizon, unplan)
    STALE_TARGETS = ["排单表.xlsx", "甘特图.html", "风险清单.xlsx"]
    if want_files:
        _ensure(OUT_DIR)
        try:
            report.write_health_md(clean, horizon, rep,
                                   os.path.join(OUT_DIR, "体检报告.md"), opts, sched)
            txt = checker.format_report(
                rep, horizon, pline,
                {"generated_at": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                 "source": src_name,
                 "ops_total": len(ops), "ops_planned": len(sched)})
            files += ["体检报告.md"]

            if not rep.ok:
                stale_archived = _archive_stale(OUT_DIR, STALE_TARGETS)
                txt += "\n\n【产物状态】\n"
                txt += "  本次校验未通过，排单表 / 甘特图 / 风险清单【未生成】。\n"
                if stale_archived:
                    txt += "  上一版旧文件已归档到 _stale/：" + "、".join(stale_archived) + "\n"
                    txt += "  请勿使用 _stale/ 里的文件交付。\n"
                else:
                    txt += "  out/ 下没有残留的旧产物。\n"

            _write(os.path.join(OUT_DIR, "校验报告.txt"), txt)
            files += ["校验报告.txt"]

            if rep.ok:
                report.write_schedule_xlsx(sched, clean, horizon,
                                           os.path.join(OUT_DIR, "排单表.xlsx"), opts)
                report.write_gantt_html(sched, clean, horizon,
                                        os.path.join(OUT_DIR, "甘特图.html"),
                                        risk_rows, opts)
                report.write_risk_xlsx(risk_rows, horizon,
                                       os.path.join(OUT_DIR, "风险清单.xlsx"))
                files += STALE_TARGETS

            # 交接说明 + 需求确认单（B1 / B2）
            from core import handover as _handover, confirm as _confirm
            _handover.write_handover_md(
                clean, horizon, rep, os.path.join(OUT_DIR, "交接说明.md"),
                opts, risk_rows, src_name, stale_archived)
            _confirm.write_confirm_md(
                clean, horizon, rep, os.path.join(OUT_DIR, "需求确认单.md"),
                opts, risk_rows, src_name)
            files += ["交接说明.md", "需求确认单.md"]

            _dump(os.path.join(OUT_DIR, "clean.json"),
                  {"meta": clean["meta"], "orders": clean["orders"],
                   "blocked": clean["blocked"], "issues": clean["issues"],
                   "machines": clean["machines"],
                   "capacity": clean["capacity"], "load": clean["load"],
                   "gap": clean["gap"]})
            _dump(os.path.join(OUT_DIR, "schedule.json"),
                  {"operations": sched, "unplannable": unplan,
                   "eval": ev, "best_rule": res["best_rule"]})
            files += ["clean.json", "schedule.json"]
        except Exception as e:
            raise ApiError("RENDER_FAILED", f"生成产物失败：{e}")

    # ---- 7. 组装响应 ----
    return _build_response(clean, horizon, sched, unplan, ev, res, rep,
                           risk_rows, pline, files, start, t0, stale_archived)


def _read_a1_note(path):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb["订单"] if "订单" in wb.sheetnames else wb.worksheets[0]
        v = ws["A1"].value
        return str(v) if v else ""
    except Exception:
        return ""


def _build_response(clean, horizon, sched, unplan, ev, res, rep,
                    risk_rows, pline, files, start, t0, stale_archived=None):
    import datetime as _dt

    # 指标
    total_load = sum(clean["load"].values())
    total_cap = sum(c["window_minutes"] for c in clean["capacity"].values())
    bn = max(clean["gap"].items(), key=lambda kv: kv[1])[0] if clean["gap"] else None
    bn_cap = clean["capacity"].get(bn, {})
    bn_load = clean["load"].get(bn, 0)
    bn_pct = (bn_load / bn_cap.get("window_minutes", 1) * 100) if bn_cap else 0

    from collections import Counter
    cnt = Counter(r["status"] for r in risk_rows)
    timed = [r for r in risk_rows if r["due"] is not None]
    on_time = sum(1 for r in timed if r["status"] in ("ok", "at_risk"))

    metrics = {
        "orders_total": len(clean["orders"]) + len(clean["blocked"]),
        "orders_ok": len(clean["orders"]),
        "orders_blocked": len(clean["blocked"]),
        "ops_total": len(instance.build_ops(clean, config.RunOptions())) if False else None,
        "ops_planned": len(sched),
        "ops_unplanned": len(unplan),
        "total_load_min": round(total_load, 1),
        "total_capacity_min": total_cap,
        "utilization_pct": round(total_load / total_cap * 100, 1) if total_cap else 0,
        "makespan_days": ev["makespan_days"],
        "delayed_count": cnt.get("delayed", 0),
        "at_risk_count": cnt.get("at_risk", 0),
        # 急单·无交期：客户催过但没给硬交期，不能报「准时」
        "urgent_no_due_count": cnt.get("urgent_no_due", 0),
        # 【新枚举 not_in_horizon + 旧名 not_scheduled_in_horizon 都要算】
        # report.py 已把状态改名为 not_in_horizon（旧名留着兼容），这里只查旧名会漏成 0，
        # 导致界面「未排入本周 0」与风险清单/校验报告的 6 条对不上。
        "not_in_horizon_count": (cnt.get("not_in_horizon", 0)
                                 + cnt.get("not_scheduled_in_horizon", 0)),
        "unplannable_count": cnt.get("unplannable", 0),
        # 【前端风险合计条要「准时 N」】风险清单里的 ok（准时）条数，之前没给，
        # 界面只能显示「准时 0」，而实际有 3 张准时单。
        "ok_count": cnt.get("ok", 0),
        "on_time_pct": round(on_time / len(timed) * 100, 1) if timed else 100.0,
        "bottleneck": bn,
        "bottleneck_load_pct": round(bn_pct, 1),
        "best_rule": res["best_rule"],
    }
    metrics["ops_total"] = metrics["ops_planned"] + metrics["ops_unplanned"]

    # 排程（转挂钟）
    schedule = []
    for o in sched:
        s_dt = cal.minutes_to_dt(o["start_axis"], horizon)
        e_dt = cal.minutes_to_dt(o["end_axis"], horizon)
        schedule.append({
            "order_id": o["order_id"],
            "lot_id": o["lot_id"],
            "seq": o["seq"],
            "op": o["op"],
            "product": o.get("product"),
            "machine": o["machine"],
            "qty": o["qty"],
            "duration_min": o["duration"],
            "start": s_dt.strftime("%Y-%m-%dT%H:%M"),
            "end": e_dt.strftime("%Y-%m-%dT%H:%M"),
            "start_axis": o["start_axis"],
            "end_axis": o["end_axis"],
            "shift": "白班" if (o["start_axis"] % config.DAY_MINUTES) < config.SHIFT_MINUTES else "夜班",
        })
    schedule.sort(key=lambda x: (x["machine"], x["start_axis"]))

    # 风险
    risks = []
    for r in risk_rows:
        risks.append({
            "order_id": r["order_id"],
            "type": r["status"],
            "type_cn": r["status_cn"],
            "due": r["due"].isoformat() if r["due"] else None,
            "due_level": r.get("due_level"),
            "planned_end": (cal.fmt(r["planned_end"], horizon)
                            if r["planned_end"] else None),
            "delay_days": r["delay_days"],
            "bottleneck_machine": r["bottleneck_machine"],
            "bottleneck_op": r["bottleneck_op"],
            "qty": r["qty"],
            "action": r["action"],
        })

    # 体检
    issues = []
    for i in clean["issues"]:
        issues.append({
            "row": i.get("row"),
            "locator": i.get("locator"),
            "category": i.get("category"),
            "severity": i.get("severity"),
            "phenomenon": i.get("phenomenon"),
            "handling": i.get("handling"),
            "need_ask": bool(i.get("need_ask")),
        })
    cats = sorted({i["category"] for i in issues})
    ask_cats = sorted({i["category"] for i in issues if i["need_ask"]})

    # 产能
    capacity = []
    for g in sorted(clean["capacity"]):
        c = clean["capacity"][g]
        capacity.append({
            "group": g,
            "machines": c["machines"],
            "window_minutes": c["window_minutes"],
            "load_minutes": round(clean["load"].get(g, 0), 1),
            "gap_minutes": round(clean["gap"].get(g, 0), 1),
            "over": clean["gap"].get(g, 0) > 0,
        })

    elapsed = int((_dt.datetime.now() - t0).total_seconds() * 1000)
    return {
        "ok": True,
        "meta": {
            "version": VERSION,
            "params_line": pline,
            "origin": start.isoformat(),
            "window_start": horizon["days"][0].isoformat(),
            "window_end": horizon["days"][-1].isoformat(),
            "window_days": horizon["window_days"],
            "capacity_per_machine": horizon["cap"],
            "rows_read": clean["meta"].get("rows_read"),
            "elapsed_ms": elapsed,
            "issue_count": len(issues),
            "issue_categories": len(cats),
            "need_ask_categories": len(ask_cats),
        },
        "metrics": metrics,
        "schedule": schedule,
        "risks": risks,
        "issues": issues,
        "blocked": clean["blocked"],
        "capacity": capacity,
        "unplannable": unplan,
        "verify": {
            "h1": "PASS" if rep.h1.passed else "FAIL",
            "h2": "PASS" if rep.h2.passed else "FAIL",
            "h3": "PASS" if rep.h3.passed else "FAIL",
            "h4": "PASS" if rep.h4.passed else "FAIL",
            "h5": "PASS" if rep.h5.passed else "FAIL",
            "checked": {"h1": rep.h1.checked, "h2": rep.h2.checked,
                        "h3": rep.h3.checked, "h4": rep.h4.checked,
                        "h5": rep.h5.checked},
            "violations": [v.to_dict() for v in rep.all_violations()],
            "skipped": (rep.h5.skipped if hasattr(rep.h5, "skipped") else []),
            "result": rep.result,
            "resultCn": RESULT_CN.get(rep.result, rep.result),
            "ok": rep.ok,
            "hardViolations": rep.hard_violations,
            "softViolations": rep.soft_violations,
        },
        "summary": {
            "result": rep.result,
            "resultCn": RESULT_CN.get(rep.result, rep.result),
            "hardViolations": rep.hard_violations,
            "softViolations": rep.soft_violations,
            "delayed": metrics.get("delayed_count", 0),
            "atRisk": metrics.get("at_risk_count", 0),
            "notInHorizon": metrics.get("not_in_horizon_count", 0),
            "unplannable": metrics.get("unplannable_count", 0),
            "bottleneck": metrics.get("bottleneck"),
            "bottleneckLoadPct": metrics.get("bottleneck_load_pct"),
            "makespanDays": metrics.get("makespan_days"),
            "utilizationPct": metrics.get("utilization_pct"),
        },
        "artifacts": _artifacts(files),
        "staleArchived": _artifacts(stale_archived or [], stale=True),
        "handover": _artifact("交接说明.md", files),
        "confirm": _artifact("需求确认单.md", files),
        "files": files,
    }


# ============================================================
# 工具
# ============================================================

def _ensure(d):
    if not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)


def _write(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _dump(path, obj):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(_jsonable(obj), f, ensure_ascii=False, indent=2)


# ============================================================
# HTTP 处理
# ============================================================

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ico": "image/x-icon",
    ".png": "image/png",
}


class Handler(BaseHTTPRequestHandler):
    server_version = f"HongdaAPS/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ---------- 日志 ----------
    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---------- 响应助手 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, code: str, msg: str, hint: str = "", status: int = 400):
        self._send_json({"ok": False, "error_code": code,
                         "error_msg": msg, "hint": hint}, status)

    def _send_file(self, path: str, as_attachment: bool = True):
        """发送文件。

        【关键】as_attachment=False 用于前端静态资源（index.html / app.js / css）：
        只有走 /api/download/ 的产物才加 Content-Disposition: attachment。
        否则浏览器打开首页会变成「下载 index.html」，页面根本渲染不出来。
        """
        if not os.path.isfile(path):
            self._send_error_json("FILE_NOT_FOUND", "文件不存在或已被清理",
                                  "请重新排程生成", 404)
            return
        ext = os.path.splitext(path)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(path, "rb") as f:
            data = f.read()
        name = os.path.basename(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if as_attachment:
            self.send_header("Content-Disposition", content_disposition(name))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ---------- GET ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)

        if path in ("/api/health", "/api/health/"):
            return self._send_json({
                "ok": True, "version": VERSION,
                "python": sys.version.split()[0],
                "openpyxl": _openpyxl_version(),
                "mode": "server",
            })

        if path.startswith("/api/download/"):
            return self._handle_download(path)

        # 静态文件：前端
        return self._serve_static(path)

    def _handle_download(self, path):
        raw = path[len("/api/download/"):].strip("/")
        name = urllib.parse.unquote(raw)
        # 白名单 + 防目录穿越
        if name not in ALLOWED_DOWNLOADS:
            return self._send_error_json(
                "FILE_NOT_ALLOWED", f"不允许下载「{name}」",
                "可下载：" + "、".join(ALLOWED_DOWNLOADS), 403)
        target = os.path.join(OUT_DIR, ALLOWED_DOWNLOADS[name])
        return self._send_file(target)

    def _serve_static(self, path):
        if path in ("/", "", "/index.html"):
            target = os.path.join(WEB_DIR, "index.html")
        else:
            rel = path.lstrip("/")
            target = os.path.normpath(os.path.join(WEB_DIR, rel))
            # 防穿越：必须落在 WEB_DIR 内
            if not os.path.abspath(target).startswith(os.path.abspath(WEB_DIR)):
                return self._send_error_json("FORBIDDEN", "路径不合法", "", 403)
        if not os.path.isfile(target):
            return self._send_error_json(
                "NOT_FOUND", f"页面不存在：{path}",
                "请访问 / 打开首页", 404)
        # 静态资源必须「就地渲染」，不能加 attachment（否则首页变成下载）
        return self._send_file(target, as_attachment=False)

    # ---------- POST ----------
    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        if path not in ("/api/generate", "/api/generate/"):
            return self._send_error_json("NOT_FOUND", f"接口不存在：{path}", "", 404)
        return self._handle_generate()

    def _handle_generate(self):
        # 【不用 cgi.FieldStorage】cgi 在 Python 3.13 已移除，这里手写 multipart 解析
        ctype = self.headers.get("Content-Type", "")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._send_error_json("NO_FILE", "没有收到文件内容",
                                         "请在上传区选择一个 .xlsx 台账")
        if length > 50 * 1024 * 1024:
            return self._send_error_json("TOO_LARGE", "文件太大（>50MB）",
                                         "台账通常只有几十 KB，请检查是否传错文件")

        body = self.rfile.read(length)
        try:
            fields = parse_multipart(body, ctype)
        except Exception as e:
            return self._send_error_json("BAD_REQUEST", f"表单解析失败：{e}",
                                         "请用 multipart/form-data 上传")

        payload = {}
        if "options" in fields:
            try:
                payload = json.loads(fields["options"]["data"].decode("utf-8") or "{}")
            except Exception:
                payload = {}

        if "file" not in fields:
            return self._send_error_json("NO_FILE", "没有收到文件",
                                         "请在上传区选择一个 .xlsx 台账")

        item = fields["file"]
        filename = os.path.basename(item["filename"])
        if not filename.lower().endswith(".xlsx"):
            return self._send_error_json(
                "NOT_XLSX", f"请上传 .xlsx 文件（当前是「{filename}」）",
                "如果文件是 .xls 或 .csv，请先用 Excel 另存为 .xlsx")

        data = item["data"]
        if not data:
            return self._send_error_json("EMPTY_FILE", "上传的文件是空的",
                                         "请检查台账文件是否完整")
        if data[:4] != b"PK\x03\x04":
            return self._send_error_json(
                "NOT_XLSX", "文件内容不是 Excel 工作簿（不是 zip 格式）",
                "请确认没有把 .txt 改名为 .xlsx")

        tmpdir = os.path.join(tempfile.gettempdir(), "aps-upload")
        _ensure(tmpdir)
        tmp_path = os.path.join(tmpdir, f"upload-{uuid.uuid4().hex[:8]}.xlsx")
        try:
            with open(tmp_path, "wb") as f:
                f.write(data)
            result = run_pipeline(tmp_path, payload, want_files=True,
                                  display_name=filename)
            return self._send_json(result)
        except ApiError as e:
            return self._send_error_json(e.code, e.msg, e.hint)
        except Exception as e:
            sys.stderr.write(traceback.format_exc())
            return self._send_error_json(
                "INTERNAL", f"内部错误：{e}",
                "请把服务端日志发给开发同学", 500)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


def parse_multipart(body: bytes, content_type: str) -> dict:
    """手写 multipart/form-data 解析（替代已废弃的 cgi.FieldStorage）。

    返回 {name: {"filename": str|None, "data": bytes}}
    """
    CRLF = chr(13) + chr(10)
    m = re.search(r'boundary="?([^";]+)"?', content_type or "", re.I)
    if not m:
        raise ValueError("Content-Type 里没有 boundary（不是 multipart/form-data）")
    boundary = m.group(1).encode("latin-1")
    delim = b"--" + boundary

    fields = {}
    for part in body.split(delim):
        if not part:
            continue
        part = part.lstrip((CRLF).encode())
        if part.startswith(b"--"):
            continue
        sep = (CRLF + CRLF).encode()
        head_end = part.find(sep)
        if head_end < 0:
            continue
        raw_head = part[:head_end].decode("utf-8", errors="replace")
        data = part[head_end + len(sep):]
        if data.endswith(CRLF.encode()):
            data = data[:-2]

        name, filename = None, None
        for line in raw_head.split(CRLF):
            if line.lower().startswith("content-disposition"):
                nm = re.search(r'name="([^"]*)"', line)
                if nm:
                    name = nm.group(1)
                fn = re.search(r'filename="([^"]*)"', line)
                if fn:
                    filename = fn.group(1)
        if name:
            fields[name] = {"filename": filename, "data": data}
    return fields


def _openpyxl_version():
    try:
        import openpyxl
        return getattr(openpyxl, "__version__", "?")
    except Exception:
        return "未安装"


def content_disposition(filename: str) -> str:
    """中文文件名下载：RFC 5987 的 filename*。

    【坑】直接写 filename="排单表.xlsx" 会乱码（任务书 N5 明确点名）。
    """
    ascii_fallback = re.sub(r"[^\x20-\x7e]", "_", filename)
    quoted = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quoted}"


# ============================================================
# 入口
# ============================================================

def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description="宏达精密 · 排产助手 本地服务")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args(argv)

    _ensure(OUT_DIR)
    httpd = ThreadingHTTPServer((a.host, a.port), Handler)
    url = f"http://{a.host}:{a.port}"
    print(f"宏达精密 · 排产助手 已启动")
    print(f"  打开浏览器访问：{url}")
    print(f"  接口：{url}/api/health  |  POST {url}/api/generate  |  GET {url}/api/download/<文件名>")
    print(f"  前端目录：{WEB_DIR}")
    print(f"  输出目录：{OUT_DIR}")
    print("  按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "buffer"):
        try:
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                          errors="replace")
            sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8",
                                          errors="replace")
        except Exception:
            pass
    sys.exit(main())
