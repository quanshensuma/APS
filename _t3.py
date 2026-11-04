# -*- coding: utf-8 -*-
import sys, io, datetime as dt
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")
import config
from core import reader, cleaner, calendar as cal, instance, solver

raw = reader.read_workbook("data/宏达精密_订单台账.xlsx")
opts = config.RunOptions()
start = config.horizon_start(dt.date(2026,11,8))
horizon = cal.make_horizon(start)
c = cleaner.clean(raw, opts, horizon)
ops = instance.build_ops(c, opts)

print("=== 可排订单 ===")
for o in sorted(c["orders"], key=lambda x:x["id"]):
    n = len([x for x in ops if x["order_id"]==o["id"]])
    lots = len({x["lot_id"] for x in ops if x["order_id"]==o["id"]})
    dur = instance.hand_check(ops, o["id"])
    print(f"  {o['id']:<16}{o['product']:<6}qty={o['qty']:>6g} ops={n:>2} lots={lots} 工时={dur:>6} due={o['due']}")
print("\n  ops 总数", len(ops), "| 101 手算 =", instance.hand_check(ops,"HD-2026-101"))

res = solver.solve_all(ops, c, horizon, opts)
print("\n=== 未排入明细（%d 项）===" % len(res["unplannable"]))
from collections import Counter
cnt = Counter(u["reason"][:50] for u in res["unplannable"])
for r,n in cnt.most_common():
    print(f"  {n:>2}x {r}")
print("\n=== 按订单 ===")
byid = Counter(u["order_id"] for u in res["unplannable"])
for k,v in sorted(byid.items()):
    print(f"  {k:<16}{v} 个 lot 未排入")
