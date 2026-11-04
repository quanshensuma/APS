# -*- coding: utf-8 -*-
import sys, io, datetime as dt
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, ".")
import config
from core import reader, cleaner, calendar as cal

raw = reader.read_workbook("data/宏达精密_订单台账.xlsx")
print(reader.preview(raw, 3))

opts = config.RunOptions()
ref = dt.date(2026, 11, 8)          # 台账整理日（周日）
start = config.horizon_start(ref)
horizon = cal.make_horizon(start)
print("\n=== 窗口 ===")
print("  台账整理日", ref, "周" + "一二三四五六日"[ref.weekday()])
print("  排程原点  ", start, "周" + "一二三四五六日"[start.weekday()])
print("  工作日", horizon["days"], "容量", horizon["cap"])
print(" ", config.params_line(opts, start))

c = cleaner.clean(raw, opts, horizon)
print("\n=== 清洗结果 ===")
print("  可排订单", c["meta"]["orders_ok"], "| 闸门", c["meta"]["orders_blocked"],
      "| issues", c["meta"]["issue_count"], "| 类别", len(c["meta"]["issue_categories"]))
print("  需问客户类别", len(c["meta"]["need_ask_categories"]))
print("\n=== 负荷 ===")
for g in ["下料","车","铣","钻","磨"]:
    cap = c["capacity"].get(g, {})
    print(f"  {g:<4} 负荷 {c['load'].get(g,0):>9.1f} | 可用机台 {cap.get('machines')} "
          f"| 容量 {cap.get('window_minutes',0):>6} | 缺口 {c['gap'].get(g,0):>7.1f}")
print("  总负荷", sum(c["load"].values()))
print("\n=== 闸门 ===")
for b in c["blocked"]:
    print(f"  {b.get('order_id')}: {b['category']} | {b['phenomenon'][:60]}")
