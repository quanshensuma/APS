# -*- coding: utf-8 -*-
"""重新复算：完全从 文件/宏达精密_订单台账.xlsx 出发，不引用上一版任何数字。
严格按任务书/手册的口径：两班16h、周六排周日不排、交期口径17:00、分钟/件×数量。"""
import io, sys, datetime
import openpyxl

out = io.StringIO()
def P(*a): print(*a, file=out)

XLSX = "宏达精密_订单台账.xlsx"

# ============ 1. 原样读台账 ============
wb = openpyxl.load_workbook(XLSX, data_only=True)
ws_o, ws_m, ws_r = wb["订单"], wb["设备"], wb["工艺路线"]

P("="*84); P("1. 台账原样读取（按表头名定位列，不按索引）"); P("="*84)
hdr = [c.value for c in ws_o[2]]
P(f"  订单表头 r2: {hdr}")
col = {name: i for i, name in enumerate(hdr) if name}
P(f"  列映射: {col}")

orders_raw = []
for r in range(3, ws_o.max_row + 1):
    row = [c.value for c in ws_o[r]]
    if not row[0]: continue
    orders_raw.append({
        "row": r,
        "id_raw": str(row[col["单号"]]).strip() if row[col["单号"]] else "",
        "customer": row[col["客户"]],
        "order_date_raw": row[col["接单日期"]],
        "due_raw": row[col["交期"]],
        "product": str(row[col["产品"]]).strip() if row[col["产品"]] else "",
        "qty_raw": row[col["数量"]],
        "remark": str(row[col["备注"]]).strip() if row[col["备注"]] else "",
    })
P(f"\n  订单行数 = {len(orders_raw)}")
for o in orders_raw:
    P(f"   r{o['row']:>2} {o['id_raw']:<14} {o['product']:<5} qty={o['qty_raw']!s:<5} "
      f"due={o['due_raw']!s:<14} | {o['remark']}")

# 设备
P()
hdr_m = [c.value for c in ws_m[2]]
col_m = {n: i for i, n in enumerate(hdr_m) if n}
P(f"  设备表头: {hdr_m}")
machines = []
for r in range(3, ws_m.max_row + 1):
    row = [c.value for c in ws_m[r]]
    if not row[col_m["编号"]]: continue
    machines.append({
        "row": r,
        "dev_no": row[col_m["设备号"]],
        "id": str(row[col_m["编号"]]).strip(),
        "model": row[col_m["型号"]],
        "ops": str(row[col_m["可做工序"]]).strip() if row[col_m["可做工序"]] else "",
        "shifts_raw": str(row[col_m["每日班次"]]).strip() if row[col_m["每日班次"]] else "",
        "status_raw": str(row[col_m["状态"]]).strip() if row[col_m["状态"]] else "",
    })
P(f"\n  设备行数 = {len(machines)}")
for m in machines:
    P(f"   r{m['row']:>2} {m['id']:<8} 可做={m['ops']:<8} {m['shifts_raw']:<4} {m['status_raw']}")

# 工艺
P()
P("  工艺路线原样（工序列文本）：")
routes_raw = {}
for r in range(3, ws_r.max_row + 1):
    prow = [c.value for c in ws_r[r]]
    if not prow[0]: continue
    prod = str(prow[0]).strip()
    ops = [prow[i] for i in range(1, 6) if prow[i]]
    total = prow[6]
    note = prow[7] if len(prow) > 7 else ""
    routes_raw[prod] = {"ops": ops, "total": total, "note": note, "row": r}
    P(f"   r{r:>2} {prod:<5} total={total!s:<4} note={note}")
    for o in ops:
        P(f"        {o}")

# ============ 2. 剖析工艺文本（区分组 vs 点名） ============
import re
P(); P("="*84); P("2. 工艺路线解析：区分「机台组」与「点名某台」"); P("="*84)

# 组名 → 组内机台（从设备表「可做工序」反推）
group_members = {}
for m in machines:
    for g in re.split(r"[、,，]", m["ops"]):
        g = g.strip()
        if g:
            group_members.setdefault(g, []).append(m["id"])
P("  从设备表反推机台组：")
for g, ms in group_members.items():
    P(f"    {g:<6} → {ms}")

def parse_op(text):
    """解析 '铣（CNC-03）60' / '车（LAT）45' / '下料（SAW-01）20'
    返回 (工序名, 括号内标识, 分钟, 是点名还组)"""
    s = str(text).strip()
    mo = re.match(r"^(.+?)（(.+?)）\s*(\d+(?:\.\d+)?)$", s)
    if not mo:
        return None
    op, ident, mins = mo.group(1).strip(), mo.group(2).strip(), float(mo.group(3))
    # 判断：ident 是否是某台机台的编号
    all_ids = {m["id"] for m in machines}
    if ident in all_ids:
        kind = "pinned"
    elif ident in group_members:
        kind = "group"
    else:
        # 形如 CNC 这种组名
        kind = "group" if ident in ("CNC","LAT","DRL","GRD","SAW") else "unknown"
    return (op, ident, mins, kind)

ROUTES = {}
P("\n  逐工序解析：")
for prod, info in routes_raw.items():
    seq = []
    P(f"   {prod}:")
    for i, t in enumerate(info["ops"], 1):
        p = parse_op(t)
        if p is None:
            P(f"      !! 无法解析: {t}")
            continue
        op, ident, mins, kind = p
        # 映射到组
        if kind == "pinned":
            grp = next((m["ops"] for m in machines if m["id"] == ident), "")
            grp = grp.split("、")[0] if grp else "?"
        else:
            grp = ident if ident in group_members else {"CNC":"铣","LAT":"车",
                                                        "DRL":"钻","GRD":"磨","SAW":"下料"}.get(ident,"?")
        seq.append({"seq": i, "op": op, "ident": ident, "kind": kind,
                    "group": grp, "min_per_unit": mins})
        P(f"      工序{i} {op:<3} ident={ident:<7} kind={kind:<6} group={grp:<4} {mins:g} min/件")
    ROUTES[prod] = seq

# 校验合计
P("\n  单件工时合计校验：")
for prod, seq in ROUTES.items():
    s = sum(x["min_per_unit"] for x in seq)
    P(f"    {prod:<5} 逐工序求和={s:>5g}  台账合计={routes_raw[prod]['total']}  "
      f"{'OK' if s == routes_raw[prod]['total'] else '★不一致'}")

# ============ 3. 设备状态分类 ============
P(); P("="*84); P("3. 设备状态分类（四态）"); P("="*84)
def classify(status):
    if "停机" in status: return "down"
    if "闲置" in status: return "idle"
    if "外协" in status: return "outsourced"
    if "在用" in status: return "available"
    return "unknown"

for m in machines:
    m["status"] = classify(m["status_raw"])
    m["shifts"] = int(re.search(r"(\d+)", m["shifts_raw"]).group(1))
    P(f"   {m['id']:<8} {m['status_raw']:<22} → {m['status']:<11} shifts={m['shifts']}")

P(f"\n  台账 12 行，其中：")
from collections import Counter
c = Counter(m["status"] for m in machines)
for k, v in c.items():
    P(f"    {k:<12} {v} 台")

# ============ 4. 日历与产能（严格按手册口径） ============
P(); P("="*84); P("4. 日历与窗口（按手册：两班8h、周六排周日不排）"); P("="*84)
SHIFT_H = 8
SHIFTS_PER_DAY = 2
SHIFT_MIN = SHIFT_H * 60
DAY_MIN = SHIFTS_PER_DAY * SHIFT_MIN
P(f"  单班 {SHIFT_H}h = {SHIFT_MIN} min；每日 {SHIFTS_PER_DAY} 班 = {DAY_MIN} min（= {DAY_MIN/60}h，08:00–24:00）")

# 起始日 = 台账整理日 2026-11-08 之后最近的周一
base = datetime.date(2026, 11, 8)
P(f"  台账整理日 = {base}（周{'一二三四五六日'[base.weekday()]}）")
days_ahead = (0 - base.weekday()) % 7
if days_ahead == 0: days_ahead = 7
start = base + datetime.timedelta(days=days_ahead)
P(f"  → 「最近的周一」= {start}（周{'一二三四五六日'[start.weekday()]}）")

work_days = []
d = start
while len(work_days) < 6:          # 一周 = 到周日为止，周日不排 → 6 个工作日
    if d.weekday() != 6:
        work_days.append(d)
    d += datetime.timedelta(days=1)
P(f"  窗口工作日（周日不排）：")
for x in work_days:
    P(f"    {x} 周{'一二三四五六日'[x.weekday()]}")
NDAYS = len(work_days)
P(f"  → 可用工作日 = {NDAYS} 天；窗口总分钟（单台）= {NDAYS*DAY_MIN}")
P(f"  → 交期口径（手册 3.4）= 当日 17:00")

# ============ 5. 订单解析与数量 ============
P(); P("="*84); P("5. 订单解析"); P("="*84)
YEAR = 2026
def parse_date(v):
    if v is None or str(v).strip() == "": return (None, "empty")
    if isinstance(v, datetime.datetime): return (v.date(), "datetime")
    if isinstance(v, datetime.date): return (v, "date")
    s = str(v).strip()
    m = re.match(r"^(\d{4})[/\.\-](\d{1,2})[/\.\-](\d{1,2})$", s)
    if m: return (datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3))), "str-date")
    m = re.match(r"^(\d{1,2})月(\d{1,2})日$", s)
    if m: return (datetime.date(YEAR, int(m.group(1)), int(m.group(2))), "cn-date")
    if "尽快" in s: return (None, "asap")
    if "月底" in s: return (None, "month-end")
    return (None, f"unparsed:{s}")

def norm_id(raw):
    s = str(raw).strip().upper()
    m = re.match(r"^HD[-_]?(\d{4})[-_]?(\d{2,3})$", s)
    if m: return f"HD-{m.group(1)}-{int(m.group(2)):03d}"
    m = re.match(r"^(\d{2,3})$", s)
    if m: return f"HD-{YEAR}-{int(m.group(1)):03d}"
    return s

S = {}  # 统计
due_tbl = []
for o in orders_raw:
    oid = norm_id(o["id_raw"])
    dval, dkind = parse_date(o["due_raw"])
    due_tbl.append((o["row"], o["id_raw"], oid, o["due_raw"], dval, dkind))
P("  交期解析：")
for row, raw, oid, dra, dv, dk in due_tbl:
    P(f"   r{row:>2} {raw:<14}→{oid:<14} {str(dra):<14} → {dv} [{dk}]")

# 数量处理
P("\n  数量处理：")
qty_notes = []
for o in orders_raw:
    if o["qty_raw"] is None or str(o["qty_raw"]).strip() == "":
        qty_notes.append((o["row"], o["id_raw"], None, "空白 → 闸门（需客户确认）"))
    else:
        q = float(o["qty_raw"])
        if "先做一半" in o["remark"]:
            qty_notes.append((o["row"], o["id_raw"], q * 0.5, f"备注「先做一半」→ {q}/2 = {q*0.5}"))
        else:
            qty_notes.append((o["row"], o["id_raw"], q, ""))
for row, oid, q, note in qty_notes:
    P(f"   r{row:>2} {oid:<14} qty={q if q is not None else '—':<8} {note}")

io.open("_复算1_解析.txt", "w", encoding="utf-8", newline="\n").write(out.getvalue())
print("WROTE _复算1_解析.txt")
