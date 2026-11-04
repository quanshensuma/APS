# -*- coding: utf-8 -*-
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

# 只排阀芯C，看能不能排进去
fc = c["flow_constraints"][0]
vc = [o for o in ops if o["product"]=="阀芯C"]
grouped = instance.group_ops_by_order(vc)
tls = {mid: solver.Timeline(mid) for mid,m in c["machines"].items() if m["status"]=="available"}
print("磨容量", horizon["cap"], "| GRD-01 磨总负荷", c["load"]["磨"])
print("阀芯C 磨负荷", sum(o["duration"] for o in vc if o["op"]=="磨"))
print()
for k in sorted(grouped):
    lotops = grouped[k]
    g = next(o for o in lotops if o["op"]=="磨")
    free = tls["GRD-01"].free_windows(g["duration"], horizon["cap"])
    ok = solver.place_flow_lot(lotops, tls, c, horizon, fc, opts.flow_interp)
    print(f"  {k[1]:<6} 磨需{g['duration']:>4}min 空闲窗{len(free)}个 -> {'OK' if ok else 'FAIL'}")
    if not ok: print("     原因:", g.get("reason"))
print("\nGRD-01 已占:", sorted(tls["GRD-01"].busys))
print("总占用", tls["GRD-01"].load(), "/", horizon["cap"])
