# -*- coding: utf-8 -*-
"""诊断：为什么 place_flow_lot 找不到。"""
import sys, io, datetime as dt
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")
import config
from core import reader, cleaner, calendar as cal, instance, solver

raw = reader.read_workbook("data/宏达精密_订单台账.xlsx")
opts = config.RunOptions()
horizon = cal.make_horizon(config.horizon_start(dt.date(2026,11,8)))
c = cleaner.clean(raw, opts, horizon)
ops = instance.build_ops(c, opts)
fc = c["flow_constraints"][0]

lot = [o for o in ops if o["lot_id"]=="HD-2026-103-L1"]
car = next(o for o in lot if o["op"]=="车")
grd = next(o for o in lot if o["op"]=="磨")
print("车 duration", car["duration"], "磨 duration", grd["duration"])
print("窗口 cap", horizon["cap"])
print("磨 free_windows(700):", solver.Timeline("X").free_windows(700, horizon["cap"]))

tls = {mid: solver.Timeline(mid) for mid,m in c["machines"].items() if m["status"]=="available"}
car_c = solver.resolve_candidates(car, c); grd_c = solver.resolve_candidates(grd, c)
print("car cands", car_c, "grd cands", grd_c)
earliest = solver.release_axis(car, horizon)
print("earliest", earliest)

for mid_g in grd_c:
    wins = tls[mid_g].free_windows(grd["duration"], horizon["cap"])
    print(f"  磨 {mid_g} windows:", wins)
    for ws, we in wins:
        for gap in [30,25,20,15,10,5,0]:
            tce = ws - gap
            print(f"    gap={gap:<3} target_car_end={tce:<5} >= earliest({earliest})? {tce>=earliest}")
            if tce < earliest: continue
            for mid_c in car_c:
                s_c = tls[mid_c].earliest_slot(earliest, car["duration"], horizon["cap"])
                r_c = cal.advance(s_c, car["duration"], horizon) if s_c is not None else None
                print(f"       车 {mid_c} s={s_c} r={r_c} actual_gap={ws - r_c[1] if r_c else None}")
                break
            break
