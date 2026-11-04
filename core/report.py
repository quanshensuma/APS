# -*- coding: utf-8 -*-
"""core/report.py —— 四件产物。

1. 排单表.xlsx     日期/班次/机台/单号/工序/数量/开工/完工/工时，可打印
2. 甘特图.html     单文件、内联 CSS + 内联数据、零外部引用（断网可开）
3. 风险清单.xlsx   单号/类型/交期/预计完工/差额/卡在哪台机/建议动作
4. 体检报告.md     13 类 issue + 闸门清单 + 负荷核算
"""

from __future__ import annotations

import datetime as _dt
import html
import os

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

import config
from core import calendar as cal


# ============================================================
# 公共样式
# ============================================================

_FONT = "微软雅黑"
_HDR_FILL = PatternFill("solid", fgColor="2C7BE5")
_HDR_FONT = Font(name=_FONT, bold=True, color="FFFFFF", size=10)
_BODY_FONT = Font(name=_FONT, size=9)
_BOTTLENECK_FILL = PatternFill("solid", fgColor="FFF5F5")
_DELAYED_FILL = PatternFill("solid", fgColor="FFE3E3")
_THIN = Side(style="thin", color="CCCCCC")
_BORDER = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)


def _style_header(ws, ncol, row=1):
    for c in range(1, ncol + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = _HDR_FILL
        cell.font = _HDR_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = _BORDER


def _autofit(ws, widths):
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w


# ============================================================
# 1. 排单表
# ============================================================

def write_schedule_xlsx(sched, clean, horizon, path, opts=None):
    """生成排单表。每台机一页 + 汇总页，A4 横向可打印。"""
    wb = Workbook()
    wb.remove(wb.active)

    by_machine = {}
    for o in sched:
        by_machine.setdefault(o["machine"], []).append(o)

    order_info = {o["id"]: o for o in clean["orders"]}
    deficit = {g: (clean["load"].get(g, 0) - c["window_minutes"])
               for g, c in clean["capacity"].items()}

    # ---- 每台机一页 ----
    for mid in sorted(by_machine):
        ops = sorted(by_machine[mid], key=lambda x: x["start_axis"])
        ws = wb.create_sheet(mid)
        heads = ["日期", "班次", "机台", "单号", "产品", "工序", "数量",
                 "开工", "完工", "工时(min)"]
        ws.append(heads)
        _style_header(ws, len(heads))

        for o in ops:
            s_dt = cal.minutes_to_dt(o["start_axis"], horizon)
            e_dt = cal.minutes_to_dt(o["end_axis"], horizon)
            shift = "白班" if (o["start_axis"] % config.DAY_MINUTES) < config.SHIFT_MINUTES else "夜班"
            # 【关键】跨日工序的完工必须带日期，否则 21:50 → 17:30 看起来像倒流
            cross_days = (e_dt.date() - s_dt.date()).days
            end_txt = e_dt.strftime("%H:%M")
            if cross_days > 0:
                end_txt = e_dt.strftime("%m-%d %H:%M")
            ws.append([
                s_dt.strftime("%Y-%m-%d"), shift, mid,
                f"{o['order_id']}" + (f"/{o['lot_id'].split('-')[-1]}"
                                      if o["lot_id"] != o["order_id"] else ""),
                o.get("product"), o["op"], o["qty"],
                s_dt.strftime("%H:%M"), end_txt, o["duration"],
            ])

        for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(heads)):
            for cell in row:
                cell.font = _BODY_FONT
                cell.border = _BORDER
                cell.alignment = Alignment(horizontal="center")
        _autofit(ws, [11, 6, 8, 20, 7, 6, 7, 7, 7, 10])
        # 打印设置
        ws.page_setup.orientation = "landscape"
        ws.page_setup.paperSize = ws.PAPERSIZE_A4
        ws.page_setup.fitToWidth = 1
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        ws.print_title_rows = "1:1"

    # ---- 汇总页 ----
    ws = wb.create_sheet("汇总")
    heads = ["机台", "工序组", "总负荷(min)", "窗口容量", "利用率", "状态"]
    ws.append(heads)
    _style_header(ws, len(heads))

    group_of = {}
    for g, c in clean["capacity"].items():
        for m in c["all_machines"]:
            group_of[m] = g

    for mid in sorted(clean["machines"]):
        m = clean["machines"][mid]
        g = group_of.get(mid, "?")
        capinfo = clean["capacity"].get(g, {})
        avail = mid in capinfo.get("machines", [])
        load_min = sum(o["duration"] for o in sched if o["machine"] == mid)
        cap = m.get("daily_minutes", 0) * horizon["window_days"] if avail else 0
        util = (load_min / cap) if cap else 0
        st = {"available": "在用", "down": "停机维修", "idle": "闲置",
              "outsourced": "外协不计本厂"}.get(m["status"], m["status"])
        ws.append([mid, g, load_min, cap, f"{util*100:.1f}%" if cap else "—", st])
        if avail and util > 1:
            for c2 in range(1, len(heads) + 1):
                ws.cell(row=ws.max_row, column=c2).fill = _DELAYED_FILL

    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(heads)):
        for cell in row:
            cell.font = _BODY_FONT
            cell.border = _BORDER
            cell.alignment = Alignment(horizontal="center")
    _autofit(ws, [10, 8, 14, 12, 10, 16])

    # 汇总页末尾写校验结论
    ws.append([])
    ws.append([f"窗口：{horizon['days'][0]} ~ {horizon['days'][-1]}（{horizon['window_days']} 个工作日）"])
    ws.append([f"本次参数：{config.params_line(opts, horizon['start']) if opts else ''}"])
    ws.append([f"已排 Operation：{len(sched)} 条"])

    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_area = f"A1:F{ws.max_row}"

    wb.save(path)
    return path


# ============================================================
# 2. 甘特图（单文件，零外部引用）
# ============================================================

_PROD_COLOR = {
    "阀体A": "#5B9BD5", "阀体B": "#70AD47", "阀芯C": "#ED7D31",
    "法兰D": "#A5A5A5", "端盖E": "#FFC000",
}


def write_gantt_html(sched, clean, horizon, path, risk_rows=None, opts=None):
    """单文件甘特图。断网可开：无 http / 无 <script src> / 无外部字体。"""
    days = horizon["days"]
    per_day = horizon["per_day"]
    cap = horizon["cap"]

    machines = sorted({o["machine"] for o in sched})
    # 顺序：下料 → 车 → 铣 → 钻 → 磨，磨放最后并标瓶颈
    group_order = ["下料", "车", "铣", "钻", "磨", "热处理"]
    group_of = {m: g for g, c in clean["capacity"].items() for m in c["all_machines"]}
    machines.sort(key=lambda m: (group_order.index(group_of.get(m, "热处理"))
                                 if group_of.get(m) in group_order else 99, m))

    bottleneck = max(clean["gap"].items(), key=lambda kv: kv[1])[0] if clean["gap"] else ""

    def prod_color(p):
        return _PROD_COLOR.get(p, "#4472C4")

    # 每天宽度（百分比）
    day_w = 100.0 / len(days)
    row_h = 26
    bars = []
    for o in sched:
        left = (o["start_axis"] / cap) * 100
        width = max((o["end_axis"] - o["start_axis"]) / cap * 100, 0.15)
        label = f"{o['order_id']} {o['op']}"
        tip = (f"{o['order_id']}  {o['product']}  {o['op']}\n"
               f"{cal.fmt(o['start_axis'], horizon)} → {cal.fmt(o['end_axis'], horizon)}\n"
               f"{o['qty']:g} 件  {o['duration']} min")
        bars.append({
            "machine": o["machine"], "left": round(left, 3),
            "width": round(width, 3), "color": prod_color(o.get("product")),
            "label": label, "tip": tip, "order_id": o["order_id"],
        })

    # 流水连线（C3）：同一子批的车 → 磨
    links = []
    fc = (clean.get("flow_constraints") or [{}])[0]
    if fc:
        for key in {(o["order_id"], o["lot_id"]) for o in sched
                    if o["product"] == fc.get("product")}:
            a = next((o for o in sched if o["order_id"] == key[0]
                      and o["lot_id"] == key[1] and o["seq"] == fc["from_seq"]), None)
            b = next((o for o in sched if o["order_id"] == key[0]
                      and o["lot_id"] == key[1] and o["seq"] == fc["to_seq"]), None)
            if a and b:
                links.append({"lot": key[1], "gap": b["start_axis"] - a["end_axis"]})

    day_labels = "".join(
        f'<div class="day" style="width:{day_w}%">'
        f'{d.strftime("%m-%d")}<br><span class="wd">周{"一二三四五六日"[d.weekday()]}</span>'
        f'</div>' for d in days)

    rows_html = []
    for mid in machines:
        mrow = [b for b in bars if b["machine"] == mid]
        cls = "row bottleneck" if group_of.get(mid) == bottleneck else "row"
        cells = "".join(
            f'<div class="bar" style="left:{b["left"]}%;width:{b["width"]}%;'
            f'background:{b["color"]}" title="{html.escape(b["tip"])}">'
            f'<span>{html.escape(b["label"])}</span></div>' for b in mrow)
        # 日分隔线
        seps = "".join(
            f'<div class="sep" style="left:{i*day_w}%"></div>'
            for i in range(1, len(days)))
        rows_html.append(
            f'<div class="{cls}"><div class="mname">{mid}</div>'
            f'<div class="track">{seps}{cells}</div></div>')

    gap_txt = ", ".join(f"{g}:{v:.0f}" for g, v in sorted(clean["gap"].items()) if v > 0)
    risk_n = len(risk_rows or [])
    params = config.params_line(opts, horizon["start"]) if opts else ""

    html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>宏达精密 · 周排程甘特图</title>
<style>
* {{ box-sizing: border-box; }}
body {{ font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif;
        margin: 20px; color: #333; background: #fff; }}
h1 {{ font-size: 20px; margin: 0 0 6px; }}
.meta {{ font-size: 12px; color: #666; margin-bottom: 14px; line-height: 1.7; }}
.legend {{ font-size: 12px; margin: 10px 0 16px; }}
.legend span {{ margin-right: 14px; display: inline-block; }}
.sw {{ display: inline-block; width: 12px; height: 12px; border-radius: 2px;
       vertical-align: -2px; margin-right: 4px; }}
.chart {{ border: 1px solid #ddd; border-radius: 4px; overflow: hidden; }}
.days {{ display: flex; background: #f7f9fc; border-bottom: 1px solid #ddd;
         font-size: 11px; text-align: center; }}
.day {{ padding: 5px 0; border-right: 1px solid #e5e5e5; }}
.wd {{ color: #999; }}
.row {{ display: flex; align-items: stretch; border-bottom: 1px solid #eee; }}
.row:last-child {{ border-bottom: none; }}
.row.bottleneck {{ background: #fff5f5; border-left: 4px solid #d9534f; }}
.mname {{ width: 78px; flex: 0 0 78px; font-size: 12px; padding: 6px;
          background: #fafafa; border-right: 1px solid #ddd;
          display: flex; align-items: center; }}
.row.bottleneck .mname {{ font-weight: 700; color: #d9534f; background: #ffeeee; }}
.track {{ position: relative; flex: 1; height: {row_h}px; }}
.bar {{ position: absolute; top: 4px; height: {row_h - 8}px; border-radius: 3px;
        font-size: 9px; color: #fff; overflow: hidden; white-space: nowrap;
        display: flex; align-items: center; padding: 0 3px; opacity: .92; }}
.bar:hover {{ opacity: 1; outline: 1px solid #333; z-index: 5; }}
.sep {{ position: absolute; top: 0; bottom: 0; width: 1px; background: #eee; }}
.note {{ font-size: 12px; color: #666; margin-top: 14px; line-height: 1.8; }}
.warn {{ color: #d9534f; font-weight: 600; }}
@media print {{
  @page {{ size: A3 landscape; margin: 8mm; }}
  body {{ margin: 0; }}
  .chart {{ page-break-inside: avoid; }}
}}
</style></head>
<body>
<h1>宏达精密 · 周排程甘特图</h1>
<div class="meta">
窗口 {days[0]} ~ {days[-1]}（{len(days)} 个工作日，周日不排）｜已排 {len(sched)} 道工序<br>
本次参数：{html.escape(params)}
</div>

<div class="legend">
  <span><i class="sw" style="background:#5B9BD5"></i>阀体A</span>
  <span><i class="sw" style="background:#70AD47"></i>阀体B</span>
  <span><i class="sw" style="background:#ED7D31"></i>阀芯C</span>
  <span><i class="sw" style="background:#A5A5A5"></i>法兰D</span>
  <span><i class="sw" style="background:#FFC000"></i>端盖E</span>
  <span style="border-left:4px solid #d9534f;padding-left:6px">瓶颈机台</span>
</div>

<div class="chart">
  <div class="days">{day_labels}</div>
  {''.join(rows_html)}
</div>

<div class="note">
  <div>★ 瓶颈：<span class="warn">{html.escape(bottleneck)}</span>　缺口 {html.escape(gap_txt) if gap_txt else '无'}</div>
  <div>风险条目：{risk_n} 条（详见风险清单）</div>
  <div>阀芯C 的「车→磨」间隔已按 ≤30 分钟校验，共 {len(links)} 个子批</div>
</div>
</body></html>"""

    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(html_doc)
    return path


# ============================================================
# 3. 风险清单
# ============================================================

def decide_status(planned_end, due, qty_total, qty_planned, horizon):
    """纯函数：判定订单状态。

    【与前端 engine.js 的 summarize 判定顺序严格对齐】
      1. 一道都没排 / 没排全        → unplannable
      2. 交期（顺延周日）在窗口之后  → not_in_horizon（不算延期）
      3. 无硬交期                    → ok（只报预计完工）
      4. 完工 > 交期                 → delayed
      5. 余量 < 一个班次             → at_risk
      6. 其它                        → ok
    """
    if qty_planned <= 0 or planned_end is None:
        return "unplannable"
    if qty_planned + config.EPS < qty_total:
        return "unplannable"             # 与前端一致：没排全也算排不进

    info = cal.due_info(due, horizon)
    if due is not None and not info["in_horizon"]:
        return "not_in_horizon"          # 交期在窗口后，本周排不排都不算延期
    if info["axis"] is None:
        return "ok"                      # 无硬交期
    if planned_end > info["axis"]:
        return "delayed"
    if info["axis"] - planned_end < config.AT_RISK_MINUTES:
        return "at_risk"
    return "ok"


_STATUS_CN = {
    "ok": "准时",
    "delayed": "延期",
    "at_risk": "预警",
    "not_in_horizon": "未排入本周",
    "not_scheduled_in_horizon": "未排入本周",   # 兼容旧枚举
    "unplannable": "排不进",
}


def build_risk_rows(sched, clean, horizon, unplannable=None):
    """生成风险清单行。"""
    unplannable = unplannable or []
    per_order_end, per_order_qty = {}, {}
    per_order_bottleneck = {}

    for o in sched:
        oid = o["order_id"]
        if o["end_axis"] > per_order_end.get(oid, -1):
            per_order_end[oid] = o["end_axis"]
            per_order_bottleneck[oid] = (o["machine"], o["seq"], o["op"])
        per_order_qty[oid] = per_order_qty.get(oid, 0) + (
            o["qty"] if o["seq"] == 1 else 0)

    unplan_by_order = {}
    for u in unplannable:
        unplan_by_order.setdefault(u["order_id"], []).append(u)

    rows = []

    # 【与前端对齐】被闸门拦住的订单也要出现在风险清单里（记为 unplannable），
    # 否则客户看到「14 单」但清单只有 13 行，会以为漏了一单。
    for b in clean.get("blocked", []):
        rows.append({
            "order_id": b.get("order_id") or "—",
            "status": "unplannable",
            "status_cn": _STATUS_CN["unplannable"],
            "due": None,
            "due_level": None,
            "planned_end": None,
            "delay_days": None,
            "bottleneck_machine": None,
            "bottleneck_op": None,
            "qty": None,
            "qty_planned": 0,
            "product": b.get("product"),
            "action": f"排不进：{b.get('category','')}——{b.get('handling','')}",
            "from_gate": True,
        })

    for order in sorted(clean["orders"], key=lambda x: x["id"]):
        oid = order["id"]
        planned_end = per_order_end.get(oid)
        qty_planned = per_order_qty.get(oid, 0)
        if oid in unplan_by_order and qty_planned <= 0:
            qty_planned = 0
        st = decide_status(planned_end, order["due"], order["qty"],
                           qty_planned, horizon)

        bn_m, bn_seq, bn_op = per_order_bottleneck.get(oid, (None, None, None))
        delay_days = None
        if st == "delayed" and order["due"]:
            due_axis = cal.due_to_axis(order["due"], horizon)
            if due_axis is not None:
                delay_days = round((planned_end - due_axis) / config.DAY_MINUTES, 1)

        rows.append({
            "order_id": oid,
            "status": st,
            "status_cn": _STATUS_CN[st],
            "due": order["due"],
            "due_level": order.get("due_level"),
            "planned_end": planned_end,
            "delay_days": delay_days,
            "bottleneck_machine": bn_m,
            "bottleneck_op": bn_op,
            "qty": order["qty"],
            "qty_planned": qty_planned,
            "product": order["product"],
            "action": _action_text(st, delay_days, bn_m, unplan_by_order.get(oid)),
        })
    return rows


def _action_text(st, delay_days, bn_m, unplan):
    if st == "delayed":
        return f"卡在 {bn_m}：启用闲置机台 / 与客户协商延期 {delay_days:g} 天 / 调大 --lot-size"
    if st == "at_risk":
        return "余量不足一个班次，建议提前确认物料与人员"
    if st in ("not_in_horizon", "not_scheduled_in_horizon"):
        return "交期在窗口外，建议顺延下一窗口，本周不排"
    if st == "unplannable":
        if unplan:
            r = unplan[0].get("reason") or ""
            return f"排不进：{r[:50]}"
        return "排不进：数量待确认或产能不足，需决策"
    return "—"


def write_risk_xlsx(rows, horizon, path):
    """生成风险清单。含「类型」列（必需，否则会把窗口外订单误报为延期）。"""
    wb = Workbook()
    ws = wb.active
    ws.title = "风险清单"

    heads = ["单号", "类型", "交期", "预计完工", "差额", "卡在哪台机",
             "卡在哪个工序", "数量", "已排数量", "建议动作"]
    ws.append(heads)
    _style_header(ws, len(heads))

    for r in rows:
        due_s = r["due"].strftime("%m-%d") if r["due"] else "—"
        if r.get("due_level") == "inferred":
            due_s += "*"
        end_s = cal.fmt(r["planned_end"], horizon) if r["planned_end"] else "—"
        diff = "—"
        if r["delay_days"] is not None:
            diff = f"+{r['delay_days']:g}天" if r["delay_days"] > 0 else f"{r['delay_days']:g}天"
        ws.append([
            r["order_id"], r["status_cn"], due_s, end_s, diff,
            r["bottleneck_machine"] or "—", r["bottleneck_op"] or "—",
            r["qty"], r["qty_planned"], r["action"],
        ])
        if r["status"] == "delayed":
            for c in range(1, len(heads) + 1):
                cell = ws.cell(row=ws.max_row, column=c)
                cell.fill = _DELAYED_FILL
                cell.font = Font(name=_FONT, size=9, color="C00000", bold=(c == 2))

    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, max_col=len(heads)):
        for cell in row:
            if not cell.font.bold:
                cell.font = _BODY_FONT
            cell.border = _BORDER
            cell.alignment = Alignment(horizontal="center" if cell.column != 10
                                       else "left", vertical="center")

    # 合计行
    from collections import Counter
    cnt = Counter(r["status"] for r in rows)
    ws.append([])
    ws.append([f"合计 {len(rows)} 单",
               f"延期 {cnt.get('delayed',0)} / 预警 {cnt.get('at_risk',0)} / "
               f"未排入本周 {cnt.get('not_in_horizon',0)+cnt.get('not_scheduled_in_horizon',0)} / "
               f"排不进 {cnt.get('unplannable',0)}"])
    ws.cell(row=ws.max_row, column=1).font = Font(name=_FONT, size=9, bold=True)
    ws.cell(row=ws.max_row, column=2).font = Font(name=_FONT, size=9, bold=True)

    # 脚注（固定写法）
    ws.append([])
    for line in [
        "说明：",
        "1. 「类型」含义：",
        "   · 延期       = 已排入且预计完工晚于交期",
        "   · 预警       = 已排入且余量不足一个班次",
        "   · 未排入本周 = 交期在窗口之后，本周不排，不算延期",
        "   · 排不进     = 受产能或流水约束无法安排，需决策",
        "2. 带 * 的交期为推算值（如「月底前」→ 当月末），非客户原始承诺。",
        "3. 「卡在哪个工序」指该订单最后完工的那道工序。",
    ]:
        ws.append([line])
        ws.cell(row=ws.max_row, column=1).font = Font(name=_FONT, size=9)

    _autofit(ws, [16, 12, 10, 14, 8, 11, 11, 7, 8, 52])
    ws.freeze_panes = "A2"
    wb.save(path)
    return path


# ============================================================
# 4. 体检报告
# ============================================================

def write_health_md(clean, horizon, report, path, opts=None, sched=None):
    """生成数据体检报告（Markdown）。"""
    issues = clean["issues"]
    blocked = clean["blocked"]
    cats = {}
    for i in issues:
        cats.setdefault(i["category"], []).append(i)

    need_ask = sorted({i["category"] for i in issues if i.get("need_ask")})

    L = []
    L.append("# 宏达精密 · 数据体检报告")
    L.append("")
    L.append("| 项 | 内容 |")
    L.append("|---|---|")
    L.append(f"| 数据源 | {clean['meta'].get('path','—')} |")
    L.append(f"| 生成时间 | {_dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} |")
    L.append(f"| 窗口 | {horizon['days'][0]} ~ {horizon['days'][-1]}"
             f"（{horizon['window_days']} 个工作日，周日不排） |")
    if opts:
        L.append(f"| 本次参数 | {config.params_line(opts, horizon['start'])} |")
    L.append("")
    L.append("## 一、总览")
    L.append("")
    L.append("| 指标 | 值 |")
    L.append("|---|---:|")
    L.append(f"| 台账原始行数 | {clean['meta'].get('rows_read','—')} |")
    L.append(f"| 可排订单 | {len(clean['orders'])} |")
    L.append(f"| 进闸门（阻断） | {len(blocked)} |")
    L.append(f"| 问题条目 | {len(issues)} |")
    L.append(f"| **问题类别** | **{len(cats)} 类** |")
    L.append(f"| 其中需客户确认 | **{len(need_ask)} 类** |")
    L.append("")
    if len(cats) >= 8 and len(need_ask) >= 3:
        L.append("> ✅ 满足任务书要求：体检 ≥8 类，其中「要问客户」的 ≥3 类。")
    else:
        L.append(f"> ⚠️ 未达任务书要求（需 ≥8 类、≥3 类需问客户）。"
                 f"当前 {len(cats)} 类 / {len(need_ask)} 类。")
    L.append("")

    # 逐类
    L.append("## 二、逐类问题")
    L.append("")
    for ci, (cat, items) in enumerate(sorted(cats.items()), start=1):
        ask = any(i.get("need_ask") for i in items)
        flag = " ⚠️ 需客户确认" if ask else ""
        L.append(f"### 类别 {ci} · {cat}{flag}")
        L.append("")
        L.append("| 位置 | 现象 | 处理方式 |")
        L.append("|---|---|---|")
        for i in items[:12]:
            loc = i.get("locator") or f"r{i.get('row')}"
            L.append(f"| `{loc}` | {_md(i.get('phenomenon',''))} | {_md(i.get('handling',''))} |")
        if len(items) > 12:
            L.append(f"| … | 另有 {len(items)-12} 条同类 | |")
        L.append("")

    # 闸门
    L.append("## 三、数据闸门清单（不猜，等复核）")
    L.append("")
    if blocked:
        L.append("| 单号 | 位置 | 原因 | 建议动作 | 级别 |")
        L.append("|---|---|---|---|---|")
        for b in blocked:
            L.append(f"| {b.get('order_id') or '—'} | `{b.get('locator','—')}` | "
                     f"{_md(b.get('category',''))}：{_md(b.get('phenomenon',''))} | "
                     f"{_md(b.get('handling',''))} | 阻断 |")
    else:
        L.append("（无）")
    L.append("")

    # 负荷
    L.append("## 四、负荷核算")
    L.append("")
    L.append("| 机台组 | 可用机台 | 容量(min) | 负荷(min) | 缺口(min) | 判定 |")
    L.append("|---|---|---:|---:|---:|---|")
    for g in sorted(clean["capacity"]):
        cap = clean["capacity"][g]
        load = clean["load"].get(g, 0)
        gap = clean["gap"].get(g, 0)
        verdict = "❌ 超窗" if gap > 0 else "✅ 装得下"
        L.append(f"| {g} | {', '.join(cap['machines']) or '无'} | "
                 f"{cap['window_minutes']} | {load:.1f} | {gap:.1f} | {verdict} |")
    L.append("")
    total_load = sum(clean["load"].values())
    L.append(f"总负荷 **{total_load:.0f} min** = {total_load/60:.1f} 机时")
    L.append("")

    # 校验结论
    if report is not None:
        L.append("## 五、校验结论")
        L.append("")
        L.append("| 约束 | 结果 | 检查数 | 违规 | 跳过 |")
        L.append("|---|---|---:|---:|---:|")
        for r in [report.h1, report.h2, report.h3, report.h4, report.h5]:
            L.append(f"| {r.rule} | {'✅ PASS' if r.passed else '❌ FAIL'} | "
                     f"{r.checked} | {len(r.violations)} | {len(r.skipped)} |")
        L.append("")
        L.append(f"**总结果：{report.result}**")
        L.append("")

    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L))
    return path


def _md(s):
    """Markdown 表格里转义竖线。"""
    return str(s or "").replace("|", "／").replace("\n", " ")
