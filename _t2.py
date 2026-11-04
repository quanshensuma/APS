# -*- coding: utf-8 -*-
import sys, io, datetime as dt
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")
import config
from core import reader, cleaner, calendar as cal, instance, solver, checker

raw = reader.read_workbook("data/宏达精密_订单台账.xlsx")
opts = config.RunOptions()
start = config.horizon_start(dt.date(2026,11,8))
horizon = cal.make_horizon(start)
c = cleaner.clean(raw, opts, horizon)

ops = instance.build_ops(c, opts)
print("=== Operation ===")
print("  总数", len(ops))
print("  101 手算:", instance.hand_check(ops, "HD-2026-101"), "min")
print("  103 批数:", len({o['lot_id'] for o in ops if o['order_id']=='HD-2026-103'}))

res = solver.solve_all(ops, c, horizon, opts)
print("\n=== 三种规则 ===")
for r in res["all"]:
    print(f"  {r['rule']:<5} 未排入 {r['unplannable']} | 延期 {r['eval']['delayed']} "
          f"| makespan {r['eval']['makespan_days']}天")
print("  选中:", res["best_rule"])

rep = checker.verify_all(res["scheduled"], c, horizon, opts, res["unplannable"])
print("\n=== 校验 ===")
for r in [rep.h1, rep.h2, rep.h3, rep.h4, rep.h5]:
    print(f"  {r.rule} {'PASS' if r.passed else 'FAIL'} checked={r.checked} "
          f"viol={len(r.violations)} skip={len(r.skipped)}")
    for v in r.violations[:3]:
        print("     ", v.message)
print("  结果:", rep.result)
