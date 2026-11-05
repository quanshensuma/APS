# -*- coding: utf-8 -*-
"""复算 3：订单级明细、交期与窗口关系、理论下界、点名问题的处置选项。"""
import io, datetime
out = io.StringIO()
def P(*a): print(*a, file=out)

SHIFT_MIN, DAY_MIN, NDAYS = 480, 960, 6
CAP1 = DAY_MIN * NDAYS          # 5760 单台窗口
START = datetime.date(2026, 11, 9)
WORK_DAYS = [datetime.date(2026,11,d) for d in range(9, 15)]   # 9~14，周日=15不进
DUE_HOUR = 17

ROUTES = {
    "阀体A": [("下料","下料","SAW-01",20), ("车","车",None,45), ("铣","铣","CNC-03",60),
              ("钻","钻",None,30), ("磨","磨","GRD-01",25)],
    "阀体B": [("下料","下料","SAW-01",15), ("车","车",None,30), ("钻","钻",None,25),
              ("磨","磨","GRD-01",20)],
    "阀芯C": [("车","车",None,40), ("磨","磨","GRD-01",35)],
    "法兰D": [("下料","下料","SAW-01",10), ("车","车",None,25), ("铣","铣",None,40),
              ("钻","钻",None,20)],
    "端盖E": [("车","车",None,20), ("铣","铣",None,30), ("钻","钻",None,15)],
}
ORDERS = [
    ("HD-2026-101","阀体A",40.0, datetime.date(2026,11,10),"exact",3,None,""),
    ("HD-2026-102","阀体A",60.0, datetime.date(2026,11,12),"exact",3,None,"合并建议"),
    ("HD-2026-103","阀芯C",120.0,None,"asap",5,None,"客户催"),
    ("HD-2026-104","阀芯C",80.0, datetime.date(2026,11,14),"exact",3,None,""),
    ("HD-2026-105","法兰D",30.0, None,"asap",5,datetime.date(2026,11,8),"材料11/8到"),
    ("HD-2026-106","法兰D",25.0, datetime.date(2026,11,20),"exact",3,None,""),
    ("HD-2026-107","端盖E",100.0,datetime.date(2026,11,13),"exact",3,None,""),
    ("HD-2026-108","阀体B",50.0, datetime.date(2026,11,30),"inferred",2,None,"月底前"),
    ("HD-2026-109","阀体B",50.0, datetime.date(2026,11,18),"exact",3,None,""),
    ("HD-2026-110","阀芯C",None, datetime.date(2026,11,15),"exact",3,None,"数量空→闸门"),
    ("HD-2026-111","阀体A",20.0, datetime.date(2026,11,11),"exact",5,None,"急单"),
    ("HD-2026-106-R2","法兰D",40.0,datetime.date(2026,11,20),"exact",3,None,"追加"),
    ("HD-2026-112","端盖E",60.0,datetime.date(2026,11,19),"exact",3,None,""),
    ("HD-2026-113","阀体B",17.5,datetime.date(2026,11,22),"exact",3,None,"先做一半"),
]
MACH = {
    "CNC-01":("铣",2,"available"), "CNC-02":("铣",2,"available"), "CNC-03":("铣",2,"down"),
    "LAT-01":("车",2,"available"), "LAT-02":("车",2,"available"), "LAT-03":("车",3,"available"),
    "DRL-01":("钻",2,"available"), "DRL-02":("钻",2,"available"),
    "GRD-01":("磨",2,"available"), "GRD-02":("磨",2,"idle"),
    "SAW-01":("下料",2,"available"), "HT-01":("热处理",3,"outsourced"),
}

# ---------- A. 订单级明细 ----------
P("="*92); P("A. 订单级明细（工时 = 逐工序 分钟/件 × 数量）"); P("="*92)
P(f"  {'单号':<15}{'产品':<6}{'数量':>7}{'单件':>6}{'总工时':>9}  工序链（组/点名）")
rows = []
for oid, prod, qty, due, kind, prio, rel, note in ORDERS:
    if qty is None:
        P(f"  {oid:<15}{prod:<6}{'—':>7}{'—':>6}{'—':>9}  【闸门：数量空白】{note}")
        continue
    unit = sum(m for _,_,_,m in ROUTES[prod])
    tot = unit * qty
    chain = " → ".join(f"{op}({pin or grp}){m:g}" for op,grp,pin,m in ROUTES[prod])
    rows.append((oid, prod, qty, unit, tot, due, kind, prio))
    P(f"  {oid:<15}{prod:<6}{qty:>7g}{unit:>6g}{tot:>9.0f}  {chain}")
P(f"\n  可排订单 {len(rows)} 张，总工时 {sum(r[4] for r in rows):.0f} min = {sum(r[4] for r in rows)/60:.1f} 机时")

# ---------- B. 交期 vs 窗口 ----------
P(); P("="*92); P("B. 交期 vs 排程窗口（窗口 11/09 一 ~ 11/14 六）"); P("="*92)
P(f"  {'单号':<15}{'交期':<12}{'类型':<10}{'相对窗口':<14}{'可用工作日':>10}")
WIN_END = datetime.date(2026,11,14)
for oid, prod, qty, unit, tot, due, kind, prio in rows:
    if due is None:
        P(f"  {oid:<15}{'—':<12}{kind:<10}{'无硬交期':<14}{'—':>10}")
        continue
    if due > WIN_END: rel = "窗口外"
    elif due < START: rel = "窗口前(已过)"
    else: rel = "窗口内"
    nwd = sum(1 for d in WORK_DAYS if d <= due)
    P(f"  {oid:<15}{str(due):<12}{kind:<10}{rel:<14}{nwd:>10}")
P(f"\n  窗口外订单（未排入本周不构成延期）：", )
outs = [r[0] for r in rows if r[5] and r[5] > WIN_END]
P(f"    {outs}  共 {len(outs)} 张")
P(f"  无硬交期：", )
nodue = [r[0] for r in rows if r[5] is None]
P(f"    {nodue}")

# ---------- C. 关键机器下界（理论最短 makespan） ----------
P(); P("="*92); P("C. 理论下界：给定产能，各单最早能何时完成（关键路径 + 排队下界）"); P("="*92)
P("  单台的「不排队下界」= 该单自身工序链串行时长（不可能更快）")
P(f"  {'单号':<15}{'串行下界(min)':>14}{'折算工作日':>12}{'交期':>12}{'可行性':>10}")
for oid, prod, qty, unit, tot, due, kind, prio in rows:
    serial = sum(m*qty for _,_,_,m in ROUTES[prod])
    days = serial / DAY_MIN
    if due is None:
        feas = "无交期"
    else:
        nwd = sum(1 for d in WORK_DAYS if d <= due)
        feas = "够" if days <= nwd else "紧"
        if due > WIN_END: feas = "窗口外"
    P(f"  {oid:<15}{serial:>14.0f}{days:>12.2f}{str(due or '—'):>12}{feas:>10}")

# 关键：磨床一台的下界
P()
P("  磨床（GRD-01 单台）承担全部磨工序：")
GRD = sum(m*q for _,p,q,_,_,_,_ in [(r[0],r[1],r[2],r[3],r[4],r[5],r[6]) for r in rows]
          for _,g,pin,m in ROUTES[p] if g=="磨")
P(f"    磨负荷 = {GRD:.0f} min")
P(f"    GRD-01 窗口容量 = {CAP1} min（{NDAYS}天 × 960）")
P(f"    → 仅磨工序就需要 {GRD/DAY_MIN:.2f} 个工作日（单台），窗口只有 {NDAYS} 天")
P(f"    → 缺口 {GRD-CAP1:.0f} min = {(GRD-CAP1)/DAY_MIN:.2f} 天")
P(f"    ★ 这是「任何排法都不可能一周做完」的硬证据（与算法无关）")

# ---------- D. 点名问题：三种处置 --------------------------------------------------
P(); P("="*92); P("D. 「磨（GRD-01）」点名的三种处置与各自后果"); P("="*92)
P("""
  台账事实：5 个产品的磨工序全部写「磨（GRD-01）」，而设备表里磨有 GRD-01（在用）
            和 GRD-02（闲置）两台。同表里「车（LAT）」「铣（CNC）」写的是组，
            「铣（CNC-03）」「磨（GRD-01）」「下料（SAW-01）」写的是点名。
""")
P("  处置 A：严格尊重点名 → 磨只能用 GRD-01 单台")
P(f"    磨容量 {CAP1} min，负荷 {GRD:.0f} min，缺口 {GRD-CAP1:.0f} min（{(GRD-CAP1)/DAY_MIN:.2f} 天）")
P(f"    GRD-02 无论启不启用都闲置 → Q1（GRD-02 能否开）在此口径下【无意义】")
P(f"    结论：磨是唯一死结，且无法靠加机器解决")
P()
P("  处置 B：视为笔误，磨按组（GRD-01/GRD-02 任选）→ 需客户确认（新 Q6）")
P(f"    磨容量 {CAP1*2} min，负荷 {GRD:.0f} min，缺口 {max(0,GRD-CAP1*2):.0f} min")
P(f"    但要叠加 C3 空等：L=20 空等 1350 → 有效 {(CAP1*2)-1350} min → 缺口 {GRD-((CAP1*2)-1350):.0f} min")
P(f"    结论：仍不够，但缺口从 {(GRD-CAP1)/DAY_MIN:.2f} 天降到 {max(0,GRD-((CAP1*2)-1350))/DAY_MIN:.2f} 天")
P()
P("  处置 C：部分替代（GRD-02 只做不需高精度的产品）→ 需客户确认精度要求（新 Q7）")
P("    台账无精度/工艺要求数据 → 无法建模，只能记为待确认")

# ---------- E. C3 在单台磨下的完整结论 ----------
P(); P("="*92); P("E. C3「阀芯C 车→磨 ≤30min」在「磨=GRD-01 单台」下的完整后果"); P("="*92)
VC = [(r[0], r[2]) for r in rows if r[1]=="阀芯C"]
vc_total = sum(q for _,q in VC)
P(f"  阀芯C 订单：{VC}，合计 {vc_total:g} 件")
P(f"  C3 要求：每件的「车完工 → 磨开工」≤ 30 min")
P()
P(f"  件级严格连续：节拍 = max(40,35) = 40 min/件")
P(f"    总跨度 = {vc_total:g} × 40 = {vc_total*40:.0f} min = {vc_total*40/DAY_MIN:.2f} 天")
P(f"    单台磨窗口 {CAP1} min = {CAP1/DAY_MIN:.0f} 天 → 超窗 {vc_total*40-CAP1:.0f} min")
P(f"    ★ 不可行")
P()
P(f"  子批流水（批内连续、批间可断），单台磨：")
P(f"    {'L':>4}{'批数':>5}{'空等':>7}{'有效容量':>10}{'磨总缺口':>10}{'其中阀芯C 占':>12}")
for L in (10,20,40,100,200):
    nb = int(vc_total)//L
    if nb*L != vc_total: continue
    idle = (40 + (L-1)*5) * nb
    eff = CAP1 - idle
    P(f"    {L:>4}{nb:>5}{idle:>7}{eff:>10}{GRD-eff:>10.0f}{(vc_total*35):>12.0f}")
P()
P("  → 单台磨 + C3 子批(L=20)：磨有效容量仅 4410 min，而磨总负荷 12350 min")
P("     缺口 7940 min = 8.27 天。这不是「排得散不散」的问题，是产能根本不够。")

# ---------- F. 若客户确认 110 数量 ----------
P(); P("="*92); P("F. 敏感性：若 Q3 确认 HD-110 数量（示例 +100 件）"); P("="*92)
P(f"  当前磨负荷（不含 110）= {GRD:.0f} min")
for q in (50, 80, 100, 120):
    add = q * 35
    P(f"    若 110 定为 {q:>3} 件 → 磨负荷 {GRD+add:>7.0f} min（+{add}），"
      f"单台磨缺口 {(GRD+add)-CAP1:>6.0f} min")

io.open("_复算3_明细.txt","w",encoding="utf-8",newline="\n").write(out.getvalue())
print("WROTE _复算3_明细.txt")
