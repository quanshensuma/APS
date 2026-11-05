# -*- coding: utf-8 -*-
"""复算 2：负荷、产能、缺口、C3 流水约束影响。
关键变量：工艺路线里「点名(pinned)」vs「机台组(group)」如何处理。"""
import io, datetime

out = io.StringIO()
def P(*a): print(*a, file=out)

SHIFT_MIN = 480
DAY_MIN = 960          # 两班 08:00-24:00
NDAYS = 6              # 11/09(一)~11/14(六)，周日不排
CAP_PER_MACHINE = DAY_MIN * NDAYS   # 5760

# ---- 台账解析结果（来自 _复算1_解析.txt，逐字转录）----
# 产品: [(seq, op, group, pinned, min/件)]
ROUTES = {
    "阀体A": [(1,"下料","下料","SAW-01",20), (2,"车","车",None,45),
              (3,"铣","铣","CNC-03",60),    (4,"钻","钻",None,30),
              (5,"磨","磨","GRD-01",25)],
    "阀体B": [(1,"下料","下料","SAW-01",15), (2,"车","车",None,30),
              (3,"钻","钻",None,25),         (4,"磨","磨","GRD-01",20)],
    "阀芯C": [(1,"车","车",None,40),        (2,"磨","磨","GRD-01",35)],
    "法兰D": [(1,"下料","下料","SAW-01",10), (2,"车","车",None,25),
              (3,"铣","铣",None,40),         (4,"钻","钻",None,20)],
    "端盖E": [(1,"车","车",None,20),        (2,"铣","铣",None,30),
              (3,"钻","钻",None,15)],
}

# 设备（12 行，4 态）
MACHINES = {
    "CNC-01": ("铣", 2, "available"),
    "CNC-02": ("铣", 2, "available"),
    "CNC-03": ("铣", 2, "down"),
    "LAT-01": ("车", 2, "available"),
    "LAT-02": ("车", 2, "available"),
    "LAT-03": ("车", 3, "available"),
    "DRL-01": ("钻", 2, "available"),
    "DRL-02": ("钻", 2, "available"),
    "GRD-01": ("磨", 2, "available"),
    "GRD-02": ("磨", 2, "idle"),
    "SAW-01": ("下料", 2, "available"),
    "HT-01":  ("热处理", 3, "outsourced"),
}

# 订单（14 张，110 数量空进闸门；113 先做一半）
ORDERS = [
    # (id, product, qty, due, due_kind, priority, release)
    ("HD-2026-101", "阀体A", 40.0,  datetime.date(2026,11,10), "exact", 3, None),
    ("HD-2026-102", "阀体A", 60.0,  datetime.date(2026,11,12), "exact", 3, None),
    ("HD-2026-103", "阀芯C", 120.0, None,                      "asap",  5, None),
    ("HD-2026-104", "阀芯C", 80.0,  datetime.date(2026,11,14), "exact", 3, None),
    ("HD-2026-105", "法兰D", 30.0,  None,                      "asap",  5, datetime.date(2026,11,8)),
    ("HD-2026-106", "法兰D", 25.0,  datetime.date(2026,11,20), "exact", 3, None),
    ("HD-2026-107", "端盖E", 100.0, datetime.date(2026,11,13), "exact", 3, None),
    ("HD-2026-108", "阀体B", 50.0,  datetime.date(2026,11,30), "inferred", 2, None),
    ("HD-2026-109", "阀体B", 50.0,  datetime.date(2026,11,18), "exact", 3, None),
    ("HD-2026-110", "阀芯C", None,  datetime.date(2026,11,15), "exact", 3, None),  # 数量空→闸门
    ("HD-2026-111", "阀体A", 20.0,  datetime.date(2026,11,11), "exact", 5, None),
    ("HD-2026-106-R2","法兰D",40.0, datetime.date(2026,11,20), "exact", 3, None),
    ("HD-2026-112", "端盖E", 60.0,  datetime.date(2026,11,19), "exact", 3, None),
    ("HD-2026-113", "阀体B", 17.5,  datetime.date(2026,11,22), "exact", 3, None),
]

P("="*86); P("A. 基准常量（按手册口径：两班8h、周日不排、交期17:00）"); P("="*86)
P(f"  单班 = {SHIFT_MIN} min；每日 = {DAY_MIN} min（08:00–24:00）")
P(f"  窗口 = {NDAYS} 个工作日 × {DAY_MIN} = {CAP_PER_MACHINE} min/台")
P(f"  窗口日历 = 2026-11-09(一) ~ 2026-11-14(六)，2026-11-15(日) 不排")
P()

# ---- 负荷计算 ----
def load(include_blocked_cnc03=False, include_blocked_110=False):
    """返回 {group: minutes}, 明细"""
    detail = {}
    for oid, prod, qty, due, kind, prio, rel in ORDERS:
        if qty is None and not include_blocked_110:
            continue
        if qty is None: qty = 0
        for seq, op, grp, pin, m in ROUTES[prod]:
            key = grp
            detail.setdefault(key, []).append((oid, prod, op, pin, m * qty))
    agg = {}
    for g, rows in detail.items():
        agg[g] = sum(r[4] for r in rows)
    return agg, detail

LOAD, DETAIL = load()
P("="*86); P("B. 总负荷（14 单，110 剔除；113 按 17.5）"); P("="*86)
for g in ["下料","车","铣","钻","磨","热处理"]:
    if g in LOAD:
        P(f"  {g:<5} {LOAD[g]:>9.1f} min = {LOAD[g]/60:>7.1f} 机时")
P(f"  {'合计':<5} {sum(LOAD.values()):>9.1f} min = {sum(LOAD.values())/60:>7.1f} 机时")
P()

# ---- 产能（分三种口径）----
P("="*86); P("C. 产能口径（三种），以及「点名」如何限制可用机台"); P("="*86)

def cap(group, mode="a1_two_shift"):
    """mode: a1_two_shift = 三班按两班(手册口径)
             allow_three = LAT-03 三班生效
             enable_idle = GRD-02 启用"""
    tot = 0
    ids = []
    for mid,(g,sh,st) in MACHINES.items():
        if g != group: continue
        if st in ("down","outsourced"): continue
        if st == "idle": continue
        sh_eff = min(sh, 2) if mode == "a1_two_shift" else sh
        tot += sh_eff * SHIFT_MIN * NDAYS
        ids.append(mid)
    return tot, ids

for g in ["下料","车","铣","钻","磨"]:
    c, ids = cap(g)
    P(f"  {g:<4} 可用机台 {ids}")
    P(f"       两班口径容量 = {c:>6} min | 负荷 {LOAD[g]:>9.1f} | 缺口 {max(0,LOAD[g]-c):>8.1f}")

P()
P("  ★ 关键：工艺路线里「点名」会锁死可用机台")
P("  " + "-"*80)
# 磨：所有产品都写 磨（GRD-01）
P("  磨工序：5 个产品全部写「磨（GRD-01）」→ 点名，组内有 GRD-01、GRD-02 两台")
P("          → 若严格按点名执行，GRD-02【闲置】开不开都用不上")
P("          → 磨负荷 100% 压在 GRD-01 一台")
# 铣：阀体A 点名 CNC-03
P("  铣工序：阀体A 写「铣（CNC-03）」点名（该机停机）")
P("         法兰D/端盖E 写「铣（CNC）」组（CNC-01/02/03 任选）")

# 铣的两种情形
mill_de = sum(m*q for oid,p,q,due,k,pr,rel in ORDERS if q and p in ("法兰D","端盖E")
              for seq,op,grp,pin,m in ROUTES[p] if grp=="铣")
mill_a = sum(m*q for oid,p,q,due,k,pr,rel in ORDERS if q and p=="阀体A"
             for seq,op,grp,pin,m in ROUTES[p] if grp=="铣")
P(f"\n         铣负荷拆解：阀体A {mill_a:.0f} min（点名 CNC-03，停机）+ 其余 {mill_de:.0f} min（组）")
P(f"          情形 R1 阀体A 可走 CNC-01/02 → 铣共 {mill_a+mill_de:.0f} min，容量 11520 → 缺 {max(0,mill_a+mill_de-11520):.0f}")
P(f"          情形 R2 阀体A 不能走       → 阀体A 3 单全拦，铣 {mill_de:.0f} min，容量 11520 → 缺 {max(0,mill_de-11520):.0f}")

# 磨的两种情形
grd_a = sum(m*q for oid,p,q,due,k,pr,rel in ORDERS if q and p=="阀体A"
            for seq,op,grp,pin,m in ROUTES[p] if grp=="磨")
grd_b = sum(m*q for oid,p,q,due,k,pr,rel in ORDERS if q and p=="阀体B"
            for seq,op,grp,pin,m in ROUTES[p] if grp=="磨")
grd_c = sum(m*q for oid,p,q,due,k,pr,rel in ORDERS if q and p=="阀芯C"
            for seq,op,grp,pin,m in ROUTES[p] if grp=="磨")
P(f"\n         磨负荷拆解：阀体A {grd_a:.0f} + 阀体B {grd_b:.0f} + 阀芯C {grd_c:.0f} = {grd_a+grd_b+grd_c:.0f} min")
P(f"          情形 M1 GRD-01 单台（严格点名）  → 容量 {CAP_PER_MACHINE} → 缺 {max(0,LOAD['磨']-CAP_PER_MACHINE):.0f}")
P(f"          情形 M2 允许同组替代(GRD-02启用) → 容量 {CAP_PER_MACHINE*2} → 缺 {max(0,LOAD['磨']-CAP_PER_MACHINE*2):.0f}")

P()
P("="*86); P("D. C3 流水约束（阀芯C 车→磨 ≤30min）的产能代价"); P("="*86)
VC_QTY = 120 + 80   # 103 + 104（110 数量空，不计）
T_CAR, T_GRD = 40, 35
P(f"  阀芯C 确定量 = {VC_QTY} 件（103 的 120 + 104 的 80；110 待定）")
P(f"  车 {T_CAR} min/件、磨 {T_GRD} min/件")
P()
P("  口径①：件级严格连续（第 i 件车完工 → 第 i 件磨开工 ≤30）")
takt = max(T_CAR, T_GRD)
P(f"    节拍 = max({T_CAR},{T_GRD}) = {takt} min/件")
P(f"    总跨度 = {VC_QTY} × {takt} = {VC_QTY*takt} min = {VC_QTY*takt/DAY_MIN:.2f} 天（单台磨）")
P(f"    单台磨窗口 = {CAP_PER_MACHINE} min → 超窗 {VC_QTY*takt-CAP_PER_MACHINE} min "
  f"= {(VC_QTY*takt-CAP_PER_MACHINE)/DAY_MIN:.2f} 天")
P(f"    ★ 件级连续 + 单台磨 = 物理不可行（仅阀芯C 一项就要 {VC_QTY*takt/DAY_MIN:.2f} 天）")
P()
P("  口径②：子批流水（批内连续，批间可断）")
P(f"    {'L':>4} {'批数':>5} {'单批车完跨度':>12} {'单批磨完跨度':>12} {'单批磨床空等':>12} {'全部空等':>10}")
lots = []
for L in (10, 20, 40, 60, 80, 100, 200):
    if VC_QTY % L: continue
    nb = VC_QTY // L
    car_end = L * T_CAR
    idle_per = T_CAR + (L-1)*(T_CAR - T_GRD)
    grd_end = car_end + T_GRD
    total_idle = idle_per * nb
    lots.append((L, nb, car_end, grd_end, idle_per, total_idle))
    P(f"    {L:>4} {nb:>5} {car_end:>12} {grd_end:>12} {idle_per:>12} {total_idle:>10}")

P()
P("  磨床有效容量 = 窗口容量 − 空等；真实缺口 = 磨负荷 − 有效容量")
P(f"    {'L':>4} {'空等':>7} {'有效容量(1台)':>14} {'缺口(1台)':>11} {'有效(2台)':>11} {'缺口(2台)':>11}")
for L, nb, ce, ge, ipl, ti in lots:
    eff1 = CAP_PER_MACHINE - ti
    eff2 = CAP_PER_MACHINE*2 - ti
    P(f"    {L:>4} {ti:>7} {eff1:>14} {LOAD['磨']-eff1:>11.0f} {eff2:>11} {LOAD['磨']-eff2:>11.0f}")

P()
P("="*86); P("E. 全组缺口汇总（B1 口径：阀体A 可排 + 磨严格点名 GRD-01）"); P("="*86)
P(f"  {'组':<5} {'负荷':>9} {'容量(在用)':>11} {'缺口':>9} {'判定':<10}")
tot_gap = 0
for g in ["下料","车","铣","钻","磨"]:
    c, ids = cap(g)
    gap = max(0, LOAD[g] - c)
    tot_gap += gap
    P(f"  {g:<5} {LOAD[g]:>9.1f} {c:>11} {gap:>9.1f} {'超窗' if gap>0 else '装得下':<10}")
P(f"  合计缺口 {tot_gap:.1f} min")
P()
P("  说明：车床 3 台全在用（LAT-03 三班按两班 → 960 min/台/日 口径下 17280）")
P("        铣床 CNC-03 停机，剩 CNC-01/02 = 11520")
P("        磨床 GRD-02 闲置，严格点名 → 仅 GRD-01 = 5760")

io.open("_复算2_负荷缺口.txt", "w", encoding="utf-8", newline="\n").write(out.getvalue())
print("WROTE _复算2_负荷缺口.txt")
