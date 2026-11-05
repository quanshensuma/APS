# -*- coding: utf-8 -*-
"""core/cleaner.py —— 洗脏数据 + 体检记录。

职责：把 raw 变成 clean，每一个改动都记 issue（任务书 N4：「逐条记 issues，
每条都有处理方式」）。

顺序很重要：先 machines（决定产能）→ 再 routes（决定可行性）→ 最后 orders
（用前两者判定）。因为「阀体A 的铣点名 CNC-03，而 CNC-03 停机」这个判定，
需要先知道机台状态、再知道路线、才能判订单。反过来会漏判。
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Optional

import config


class DataGate(Exception):
    """数据不足，进闸门。这是【正常业务分支】，必须被捕获。"""

    def __init__(self, row, locator, category, phenomenon, handling, need_ask=True):
        self.row = row
        self.locator = locator
        self.category = category
        self.phenomenon = phenomenon
        self.handling = handling
        self.need_ask = need_ask
        super().__init__(f"{locator}: {phenomenon}")


# ============================================================
# 一、单号归一
# ============================================================

_RE_HD = re.compile(r"^HD[-_]?(\d{4})[-_]?(\d{2,3})$", re.I)
_RE_NUM = re.compile(r"^(\d{2,3})$")


def norm_order_id(raw_id, ref_year: int = 2026):
    """单号归一，返回 (归一后, 提示列表)。

    "HD-2026-101" → ("HD-2026-101", [])
    "HD2026102"   → ("HD-2026-102", ["单号缺连字符，已归一"])
    "104"         → ("HD-2026-104", ["单号仅数字，已补 HD-2026- 前缀"])
    """
    s = str(raw_id or "").strip().upper()
    notes = []
    m = _RE_HD.match(s)
    if m:
        if s != f"HD-{m.group(1)}-{int(m.group(2)):03d}":
            notes.append("单号格式不标准（缺连字符或位数不足），已归一")
        return f"HD-{m.group(1)}-{int(m.group(2)):03d}", notes
    m = _RE_NUM.match(s)
    if m:
        notes.append(f"单号仅数字，已补 HD-{ref_year}- 前缀")
        return f"HD-{ref_year}-{int(m.group(1)):03d}", notes
    raise DataGate(None, "订单!A?", "单号无法识别",
                   f"单号「{raw_id}」既不是 HD 开头也不是纯数字",
                   "跳过该行，需人工确认", need_ask=True)


# ============================================================
# 二、日期解析
# ============================================================

_RE_D1 = re.compile(r"^(\d{4})[/\.\-](\d{1,2})[/\.\-](\d{1,2})$")
_RE_D2 = re.compile(r"^(\d{1,2})月(\d{1,2})日$")
_RE_D3 = re.compile(r"^(\d{1,2})[/\.\-](\d{1,2})$")


def parse_date(v, ref_year: int = 2026):
    """日期解析，返回 (date|None, level, note)。

    处理：2026/11/3、2026-11-03、2026.11.4、11月12日
    【注意】openpyxl 读出的可能是 str 不是 datetime，不能只 isinstance 判断。
    """
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, "none", "空白"
    if isinstance(v, _dt.datetime):
        return v.date(), "exact", ""
    if isinstance(v, _dt.date):
        return v, "exact", ""
    s = str(v).strip()
    m = _RE_D1.match(s)
    if m:
        return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))), "exact", ""
    m = _RE_D2.match(s)
    if m:
        return _dt.date(ref_year, int(m.group(1)), int(m.group(2))), "exact", \
               f"日期缺年份，按台账整理年 {ref_year} 补齐"
    m = _RE_D3.match(s)
    if m:
        return _dt.date(ref_year, int(m.group(1)), int(m.group(2))), "exact", \
               f"日期缺年份，按台账整理年 {ref_year} 补齐"
    return None, "none", f"无法解析：{s}"


def parse_due(v, ref_year: int = 2026):
    """交期解析，比 parse_date 多处理人话。

    返回 (date|None, level, note, priority_hint)
    level ∈ {"exact","inferred","none"}
    """
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, "none", "交期空白，无硬交期", None
    s = str(v).strip()
    if "尽快" in s:
        return None, "none", "「尽快」→ 无硬交期，按最高优先级", 5
    if "月底" in s:
        # 当月末：取该月最后一天
        d = _dt.date(ref_year, 12, 31) if False else None
        today = _dt.date(ref_year, 11, 1)
        nxt = _dt.date(ref_year + (today.month // 12), (today.month % 12) + 1, 1)
        last = nxt - _dt.timedelta(days=1)
        return last, "inferred", f"「月底前」→ 推断为 {last}（推算值）", None
    d, level, note = parse_date(v, ref_year)
    return d, level, note, None


# ============================================================
# 三、数量
# ============================================================

def parse_qty(v, remark: str, row=None, locator="", is_half=False):
    """数量解析 + 「先做一半」规则。空白 → DataGate。"""
    if v is None or (isinstance(v, str) and not v.strip()):
        raise DataGate(row, locator, "数量空白",
                       "数量为空" + ("，备注写「等客户确认」" if "确认" in (remark or "") else ""),
                       "进闸门，不参与排程；需客户确认数量后回填", need_ask=True)
    try:
        q = float(str(v).strip())
    except ValueError:
        raise DataGate(row, locator, "数量无法解析",
                       f"数量「{v}」不是数字", "进闸门，需人工确认")
    if q <= 0:
        raise DataGate(row, locator, "数量非正",
                       f"数量为 {q}", "进闸门，需人工确认")
    if is_half or "先做一半" in (remark or ""):
        q = q * 0.5
    return q


# ============================================================
# 四、备注规则
# ============================================================

def apply_remark(remark: str, order: dict, ref_year: int = 2026) -> list:
    """备注 → 约束。直接修改 order，返回提示列表。"""
    notes = []
    r = remark or ""

    if "急单" in r or "客户催" in r:
        order["priority"] = 5
        notes.append(f"备注「{r}」→ 优先级 5（最急）")

    if "材料" in r and "到" in r:
        m = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*日", r)
        if m:
            rel = _dt.date(ref_year, int(m.group(1)), int(m.group(2)))
            order["release"] = rel
            notes.append(f"备注「{r}」→ 首道工序最早 {rel}（材料到货）")

    if "先做一半" in r:
        order["split_half"] = True
        notes.append(f"备注「{r}」→ 按一半数量算（工艺路线!A9 明确了该规则）")

    if "一起做" in r or "合并" in r:
        order["batch_merge_hint"] = True
        notes.append(f"备注「{r}」→ 记录合并建议（v1 不自动合并）")

    return notes


# ============================================================
# 五、设备
# ============================================================

def classify_status(raw_status: str) -> str:
    """设备状态四态。

    【关键陷阱】HT-01 原文 = "在用（外协，不计本厂）"，同时含「在用」和「外协」。
    必须先判「外协」，再判「停机」，再判「闲置」，最后才是「在用」。
    顺序错了会把外协炉当成可用产能。
    """
    s = str(raw_status or "")
    if "外协" in s:
        return "outsourced"
    if "停机" in s:
        return "down"
    if "闲置" in s:
        return "idle"
    if "在用" in s:
        return "available"
    return "unknown"


def parse_shifts(raw) -> int:
    """提取班次数。 '2 班' → 2；'3 班' → 3。"""
    m = re.search(r"(\d+)", str(raw or ""))
    return int(m.group(1)) if m else 2


def build_machines(machines_raw: list, opts) -> tuple[dict, list]:
    """建设备池。返回 (machines, issues)。

    应用三处覆盖：
      - effective_shifts = min(shifts, 3 if opts.three_shift else 2)   ← A1
      - GRD-02: idle → available 若 opts.enable_grd02                   ← Q1
      - CNC-03: down → available 若 opts.enable_cnc03                   ← Q2
    """
    issues = []
    out = {}
    for m in machines_raw:
        mid = str(m.get("编号") or "").strip()
        if not mid:
            issues.append({
                "row": m.get("row"), "locator": f"设备!A{m.get('row')}",
                "category": "设备号缺失", "severity": "info",
                "phenomenon": "「设备号」列为空（HT-01 那行）",
                "handling": "按「编号」列判行数，不受影响", "need_ask": False,
                "changed": False,
            })
        ops_raw = str(m.get("可做工序") or "").strip()
        ops = [x.strip() for x in re.split(r"[、,，]", ops_raw) if x.strip()]
        status = classify_status(m.get("状态"))
        shifts = parse_shifts(m.get("每日班次"))
        cap = 3 if opts.three_shift else 2
        eff = min(shifts, cap)

        # 状态覆盖
        if mid == "GRD-02" and opts.enable_grd02:
            if status == "idle":
                issues.append({
                    "row": m.get("row"), "locator": f"设备!F{m.get('row')}",
                    "category": "设备状态覆盖", "severity": "warn",
                    "phenomenon": f"GRD-02 原文「{m.get('状态')}」",
                    "handling": "按参数 --enable-grd02 视为可用",
                    "need_ask": True, "changed": True,
                })
            status = "available"
        if mid == "CNC-03" and opts.enable_cnc03:
            if status == "down":
                issues.append({
                    "row": m.get("row"), "locator": f"设备!F{m.get('row')}",
                    "category": "设备状态覆盖", "severity": "warn",
                    "phenomenon": f"CNC-03 原文「{m.get('状态')}」",
                    "handling": "按参数 --enable-cnc03 视为已恢复",
                    "need_ask": True, "changed": True,
                })
            status = "available"

        if shifts != eff:
            issues.append({
                "row": m.get("row"), "locator": f"设备!E{m.get('row')}",
                "category": "班次与全厂口径不一致", "severity": "warn",
                "phenomenon": f"{mid} 台账写「{m.get('每日班次')}」，全厂口径两班",
                "handling": f"按 {eff} 班算（假设 A1），不偷加产能",
                "need_ask": True, "changed": True,
            })

        out[mid] = {
            "id": mid,
            "ops": ops,
            "model": m.get("型号"),
            "shifts": shifts,
            "effective_shifts": eff,
            "status": status,
            "status_raw": str(m.get("状态") or ""),
            "daily_minutes": eff * config.SHIFT_MINUTES,
            "row": m.get("row"),
        }
    return out, issues


# ============================================================
# 六、工艺路线
# ============================================================

_RE_OP = re.compile(r"^(.+?)（(.+?)）\s*(\d+(?:\.\d+)?)$")


def parse_op_cell(text, machines: dict, groups: dict):
    """解析 "铣（CNC-03）60" → {op, ident, kind, group, pinned, min_per_unit}。

    【关键】这是区分「点名」和「机台组」的唯一地方。
      ident 是机台编号 → pinned（点名）
      ident 是组名     → group（组内任选）
    """
    s = str(text or "").strip()
    m = _RE_OP.match(s)
    if not m:
        return None
    op, ident, mins = m.group(1).strip(), m.group(2).strip(), float(m.group(3))
    if ident in machines:
        return {"op": op, "ident": ident, "kind": "pinned",
                "group": _group_of(ident, machines), "pinned": ident,
                "min_per_unit": mins}
    if ident in groups:
        return {"op": op, "ident": ident, "kind": "group",
                "group": ident, "pinned": None, "min_per_unit": mins}
    # 形如 CNC / LAT 的组名别名
    alias = {"CNC": "铣", "LAT": "车", "DRL": "钻", "GRD": "磨", "SAW": "下料"}
    if ident in alias and alias[ident] in groups:
        return {"op": op, "ident": ident, "kind": "group",
                "group": alias[ident], "pinned": None, "min_per_unit": mins}
    return None


def _group_of(mid: str, machines: dict) -> str:
    ops = machines.get(mid, {}).get("ops", [])
    return ops[0] if ops else "?"


def build_routes(routes_raw: list, machines: dict, groups: dict) -> tuple[dict, list]:
    """建工艺路线，并校验「单件工时合计」是否等于逐工序求和。"""
    issues = []
    routes = {}
    for r in routes_raw:
        prod = str(r.get("产品") or "").strip()
        seq = []
        for i in range(1, 6):
            cell = r.get(f"工序{i}")
            if cell is None or not str(cell).strip():
                continue
            p = parse_op_cell(cell, machines, groups)
            if p is None:
                issues.append({
                    "row": r.get("row"), "locator": f"工艺路线!{'BCDEF'[i-1]}{r.get('row')}",
                    "category": "工艺工序无法解析", "severity": "block",
                    "phenomenon": f"{prod} 工序{i} 原文「{cell}」无法拆解",
                    "handling": "该产品整体进闸门", "need_ask": False, "changed": False,
                })
                continue
            p["seq"] = len(seq) + 1
            seq.append(p)
        if not seq:
            continue
        routes[prod] = seq

        # 校验合计
        total = sum(x["min_per_unit"] for x in seq)
        declared = r.get("单件工时合计")
        if declared is not None:
            try:
                if abs(float(declared) - total) > config.EPS:
                    issues.append({
                        "row": r.get("row"), "locator": f"工艺路线!G{r.get('row')}",
                        "category": "单件工时合计不符", "severity": "warn",
                        "phenomenon": f"{prod} 逐工序求和 {total:g} ≠ 合计列 {declared}",
                        "handling": "以逐工序求和为准，并记录",
                        "need_ask": False, "changed": False,
                    })
            except (TypeError, ValueError):
                pass

        # 记录「磨点名」这一关键事实（影响整份产能结论）
        for x in seq:
            if x["op"] == "磨" and x["kind"] == "pinned":
                issues.append({
                    "row": r.get("row"), "locator": f"工艺路线!{'BCDEF'[x['seq']-1]}{r.get('row')}",
                    "category": "磨工序点名机台", "severity": "warn",
                    "phenomenon": f"{prod} 磨工序原文点名 {x['pinned']}（不是机台组）",
                    "handling": "严格按点名执行；组内另一台（GRD-02）用不上。需客户确认（Q6）",
                    "need_ask": True, "changed": False,
                })
    return routes, issues


# ============================================================
# 七、订单
# ============================================================

def check_route_feasible(seq: list, machines: dict, opts) -> Optional[str]:
    """检查一条路线是否可排。返回不可排原因（None = 可排）。"""
    for op in seq:
        if op["pinned"]:
            mid = op["pinned"]
            # Q2：阀体A 铣削允许走其他立加
            if (op["op"] == "铣" and opts.allow_mill_substitute
                    and machines.get(mid, {}).get("status") != "available"):
                continue        # 视为组，后面按组选机
            # Q6：磨视为组
            if (op["op"] == "磨" and opts.morning_as_group
                    and machines.get(mid, {}).get("status") != "available"):
                continue
            st = machines.get(mid, {}).get("status")
            if st != "available":
                return (f"工序{op['seq']}({op['op']}) 点名机台 {mid}，"
                        f"该机状态为 {_status_cn(st)}")
        else:
            g = op["group"]
            avail = [m for m, v in machines.items()
                     if v["status"] == "available" and op["op"] in v["ops"]]
            if not avail:
                return f"工序{op['seq']}({op['op']}) 所属机台组「{g}」无可用机台"
    return None


def _status_cn(st: str) -> str:
    return {"down": "停机维修", "idle": "闲置", "outsourced": "外协不计本厂",
            "available": "在用"}.get(st, st or "未知")


def build_orders(orders_raw: list, routes: dict, machines: dict,
                 groups: dict, opts, ref_year: int = 2026):
    """建订单。返回 (orders, blocked, issues)。"""
    orders, blocked, issues = [], [], []
    seen_ids = {}
    dup_count = {}          # 原单号 → 已重命名的次数（第 2 次出现=1 → -R2）

    for r in orders_raw:
        row = r.get("row")
        raw_id = r.get("单号")
        prod = str(r.get("产品") or "").strip()
        remark = str(r.get("备注") or "").strip()
        loc_id = f"订单!A{row}"

        # ---- 1. 单号归一 ----
        try:
            oid, id_notes = norm_order_id(raw_id, ref_year)
        except DataGate as e:
            blocked.append(_gate(r, e, prod, raw_id))
            continue
        for n in id_notes:
            issues.append({
                "row": row, "locator": loc_id, "category": "单号写法不一致",
                "severity": "info", "phenomenon": f"原文「{raw_id}」→ 归一为 {oid}",
                "handling": n, "need_ask": False, "changed": True,
            })

        # ---- 2. 单号重复 → 递增改名 -R2 / -R3 / -Rn ----
        # 【关键】必须递增：同一单号出现 14 次时，若都叫 -R2，
        # instance.build_ops() 用 (order_id, lot_id) 分组会互相覆盖，
        # 13 个单塌缩成 8 个键，风险清单整列「预计完工」变成同一个值。
        if oid in seen_ids:
            dup_count[oid] = dup_count.get(oid, 0) + 1
            n = dup_count[oid] + 1
            new_id = f"{oid}-R{n}"
            issues.append({
                "row": row, "locator": loc_id, "category": "单号重复",
                "severity": "warn",
                "phenomenon": f"与第 {seen_ids[oid]} 行单号相同（{oid}），数量不同",
                "handling": f"标为 {new_id}，两单都排（不合并）。需客户确认是否追加单（Q4）",
                "need_ask": True, "changed": True,
            })
            oid = new_id
        else:
            seen_ids[oid] = row

        # ---- 3. 产品 ----
        if prod not in routes:
            blocked.append({
                "order_id": oid, "row": row, "locator": f"订单!E{row}",
                "category": "产品无工艺路线", "severity": "block",
                "phenomenon": f"产品「{prod}」在工艺路线表里找不到",
                "handling": "进闸门，需补充该产品的工艺路线",
                "need_ask": True, "product": prod,
            })
            continue

        # ---- 4. 数量 ----
        try:
            qty = parse_qty(r.get("数量"), remark, row, f"订单!F{row}",
                            is_half=("先做一半" in remark))
        except DataGate as e:
            blocked.append(_gate(r, e, prod, oid))
            continue

        # ---- 5. 交期 ----
        due, due_level, due_note, prio_hint = parse_due(r.get("交期"), ref_year)
        if due_level != "exact":
            issues.append({
                "row": row, "locator": f"订单!D{row}",
                "category": "交期写成文字或空白", "severity": "warn",
                "phenomenon": f"原文「{r.get('交期')}」→ {due_note}",
                "handling": "能解析就解析；不能则转优先级或兜底日期，风险清单标 *",
                "need_ask": True, "changed": (due is not None),
            })

        # ---- 6. 接单日期 ----
        od, od_level, od_note = parse_date(r.get("接单日期"), ref_year)
        if od is None:
            issues.append({
                "row": row, "locator": f"订单!C{row}", "category": "接单日期缺失",
                "severity": "info", "phenomenon": "接单日期为空",
                "handling": "不影响排程（只用交期），但影响按周接单量统计",
                "need_ask": False, "changed": False,
            })

        order = {
            "id": oid, "id_raw": str(raw_id), "row": row,
            "customer": r.get("客户"), "product": prod,
            "qty": qty, "qty_raw": r.get("数量"),
            "due": due, "due_raw": r.get("交期"), "due_level": due_level,
            "order_date": od, "priority": prio_hint or 3,
            "release": None, "split_half": False, "batch_merge_hint": False,
        }
        for n in apply_remark(remark, order, ref_year):
            issues.append({
                "row": row, "locator": f"订单!G{row}", "category": "备注藏业务规则",
                "severity": "info", "phenomenon": remark,
                "handling": n, "need_ask": ("一半" in remark or "一起" in remark),
                "changed": True,
            })

        # ---- 7. 路线可行性 ----
        reason = check_route_feasible(routes[prod], machines, opts)
        if reason:
            blocked.append({
                "order_id": oid, "row": row, "locator": f"工艺路线!D{row}",
                "category": "工艺路线点名机台不可用", "severity": "block",
                "phenomenon": reason,
                "handling": "进闸门，不参与排程。需客户确认（Q2/Q6）",
                "need_ask": True, "product": prod,
            })
            continue

        orders.append(order)

    return orders, blocked, issues


def _gate(r, e: DataGate, prod, oid) -> dict:
    return {
        "order_id": oid if isinstance(oid, str) else None,
        "row": r.get("row"), "locator": e.locator,
        "category": e.category, "severity": "block",
        "phenomenon": e.phenomenon, "handling": e.handling,
        "need_ask": e.need_ask, "product": prod,
    }


# ============================================================
# 八、产能 / 负荷 / 缺口
# ============================================================

def calc_capacity(machines: dict, groups: dict, horizon: dict) -> dict:
    """算各组窗口容量（只算 available 的机台）。"""
    out = {}
    for g, mids in groups.items():
        avail = [m for m in mids if machines[m]["status"] == "available"]
        daily = sum(machines[m]["daily_minutes"] for m in avail)
        out[g] = {
            "machines": avail,
            "all_machines": mids,
            "daily_minutes": daily,
            "window_minutes": daily * horizon["window_days"],
        }
    return out


def calc_load(orders: list, routes: dict, opts) -> dict:
    """算各组负荷（分钟/件 × 数量）。

    磨按 Q6 口径归组：默认按点名（仍算进「磨」组的总负荷，
    但可用机台只有一台，缺口由 capacity 决定）。
    """
    out = {}
    for o in orders:
        for op in routes[o["product"]]:
            v = op["min_per_unit"] * o["qty"]
            out[op["group"]] = out.get(op["group"], 0.0) + v
    return out


def calc_gap(capacity: dict, load: dict) -> dict:
    out = {}
    for g, cap in capacity.items():
        l = load.get(g, 0.0)
        out[g] = max(0.0, l - cap["window_minutes"])
    return out


# ============================================================
# 九、主流程
# ============================================================

def clean(raw: dict, opts, horizon: dict, ref_year: int = 2026) -> dict:
    """读 raw → 洗净 → 返回 clean dict。"""
    machines, m_issues = build_machines(raw["machines_raw"], opts)
    groups = config.build_groups(machines)
    routes, r_issues = build_routes(raw["routes_raw"], machines, groups)
    orders, blocked, o_issues = build_orders(
        raw["orders_raw"], routes, machines, groups, opts, ref_year)

    issues = m_issues + r_issues + o_issues

    # 注释行跳过也要记
    for s in raw.get("skipped_rows", []):
        issues.append({
            "row": s["row"], "locator": f"订单!A{s['row']}",
            "category": "非订单行（注释）", "severity": "info",
            "phenomenon": f"「{s['raw'][:40]}」",
            "handling": s["reason"], "need_ask": False, "changed": False,
        })

    capacity = calc_capacity(machines, groups, horizon)
    load = calc_load(orders, routes, opts)
    gap = calc_gap(capacity, load)

    return {
        "orders": orders,
        "blocked": blocked,
        "issues": issues,
        "machines": machines,
        "groups": groups,
        "routes": routes,
        "route_notes": raw.get("route_notes", []),
        "flow_constraints": [dict(fc) for fc in config.FLOW_CONSTRAINTS],
        "capacity": capacity,
        "load": load,
        "gap": gap,
        "meta": {
            **raw["meta"],
            "orders_ok": len(orders),
            "orders_blocked": len(blocked),
            "issue_categories": sorted({i["category"] for i in issues}),
            "issue_count": len(issues),
            "need_ask_categories": sorted(
                {i["category"] for i in issues if i.get("need_ask")}),
        },
    }
