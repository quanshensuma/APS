# -*- coding: utf-8 -*-
"""core/solver.py —— 规则排程（FIFO / SPT / MWKR 取最好）+ C3 子批流水。

任务书 N4：「规则排程（FIFO/SPT/MWKR 取最好），每次都能出可行解」。

【设计要点】
1. 日历轴只含可用时间 → end = start + duration 恒成立（跨日不打断加工，假设 A10）
2. 延迟提交：先 staged 不 occupy，全部成功才提交，避免回滚逻辑
3. C3 用「磨床优先」：先枚举磨床空闲窗口，倒推车何时完工
   —— 磨是瓶颈（GRD-01 单台承担 12,350 min），先占瓶颈资源
"""

from __future__ import annotations

import config
from core import calendar as cal
from core import instance


# ============================================================
# 机台时间线
# ============================================================

class Timeline:
    """单机台已占用区间（轴分钟），始终有序且不重叠。"""

    def __init__(self, machine_id):
        self.machine_id = machine_id
        self.busys = []          # [(start, end)]  升序

    def earliest_slot(self, after, duration, cap):
        """返回 >= after 的、能容纳 duration 的最早开始点；不足则 None。"""
        t = max(after, 0)
        for s, e in self.busys:
            if t + duration <= s:
                return t
            if e > t:
                t = e
        if t + duration <= cap:
            return t
        return None

    def occupy(self, start, end):
        for s, e in self.busys:
            if not (end <= s or start >= e):
                raise AssertionError(
                    f"内部错误：{self.machine_id} 区间重叠 "
                    f"[{start},{end}) vs [{s},{e})")
        self.busys.append((start, end))
        self.busys.sort()

    def free_windows(self, min_dur, cap):
        """返回所有 >= min_dur 的空闲窗口 [(s, e)]。"""
        out = []
        prev = 0
        for s, e in self.busys:
            if s - prev >= min_dur:
                out.append((prev, s))
            prev = max(prev, e)
        if cap - prev >= min_dur:
            out.append((prev, cap))
        return out

    def load(self):
        return sum(e - s for s, e in self.busys)


# ============================================================
# 候选机台
# ============================================================

def resolve_candidates(op, clean):
    """返回可用机台 id 列表。

    pinned 非空 → 只返回该机台（且必须 available）
    pinned 为空 → 返回该 group 下所有 available 机台
    """
    machines = clean["machines"]
    if op.get("pinned"):
        m = machines.get(op["pinned"])
        if m and m["status"] == "available":
            return [op["pinned"]]
        return []
    out = []
    for mid, m in machines.items():
        if m["status"] == "available" and op["op"] in m["ops"]:
            out.append(mid)
    return out


def release_axis(op, horizon):
    """首道工序的物料到货约束 → 轴分钟。"""
    if op["seq"] != 1:
        return 0
    rel = op.get("release")
    if rel is None:
        return 0
    import datetime as _dt
    days = horizon["days"]
    if rel <= days[0]:
        return 0
    if rel > days[-1]:
        return horizon["cap"]
    try:
        return cal.dt_to_minutes(_dt.datetime(rel.year, rel.month, rel.day, 8), horizon)
    except cal.CalendarError:
        return 0


# ============================================================
# 普通订单贪心（延迟提交）
# ============================================================

def place_lot(ops_of_lot, timelines, clean, horizon, after_axis=0):
    """排一个 lot 的全部工序。成功返回 True，并把结果写回 ops。"""
    prev_end = after_axis
    staged = []

    for op in sorted(ops_of_lot, key=lambda x: x["seq"]):
        cands = resolve_candidates(op, clean)
        if not cands:
            return _fail(ops_of_lot, op, f"无可用机台（pinned={op.get('pinned')} "
                                        f"或组内无可用机）")
        earliest = max(prev_end, release_axis(op, horizon))

        best = None
        for mid in cands:
            tl = timelines[mid]
            s = tl.earliest_slot(earliest, op["duration"], horizon["cap"])
            if s is None:
                continue
            r = cal.advance(s, op["duration"], horizon)
            if r is None:
                continue
            key = (r[0], tl.load())
            if best is None or key < best[0]:
                best = (key, mid, r)

        if best is None:
            return _fail(ops_of_lot, op,
                         f"机台 {cands} 均无 {op['duration']}min 槽位")

        _, mid, r = best
        staged.append((mid, r))
        op["machine"], op["start_axis"], op["end_axis"] = mid, r[0], r[1]
        prev_end = r[1]

    for mid, r in staged:
        timelines[mid].occupy(*r)
    for op in ops_of_lot:
        op["status"] = "scheduled"
    return True


def _fail(ops_of_lot, op, reason):
    for o in ops_of_lot:
        o["status"] = "unplannable"
        o["machine"] = o.get("machine")
        o["reason"] = reason
    op["reason"] = reason
    return False


# ============================================================
# C3 子批流水（磨床优先）
# ============================================================

def place_flow_lot(ops_of_lot, timelines, clean, horizon, fc, flow_interp="a"):
    """排一个阀芯C 子批，保证 车完工 → 磨开工 ≤ max_gap。

    磨床优先：先枚举磨床空闲窗口，倒推车何时完工。
    """
    car = next((o for o in ops_of_lot if o["seq"] == fc["from_seq"]), None)
    grd = next((o for o in ops_of_lot if o["seq"] == fc["to_seq"]), None)
    if car is None or grd is None:
        return _fail(ops_of_lot, ops_of_lot[0], "流水约束的工序不在该子批中")

    car_cands = resolve_candidates(car, clean)
    grd_cands = resolve_candidates(grd, clean)
    if not car_cands or not grd_cands:
        return _fail(ops_of_lot, car, "流水约束：车床或磨床无可用机台")

    earliest = release_axis(car, horizon)
    max_gap = fc["max_gap_min"]

    # 解读 c 时磨必须延后（磨 35 < 车 40 → gap_a=0 会让完工之差为负）
    gaps = [30, 25, 20, 15, 10, 5] if flow_interp == "c" else [30, 25, 20, 15, 10, 5, 0]
    gaps = [g for g in gaps if g <= max_gap] or [max_gap]

    best = None
    for mid_g in grd_cands:
        tl_g = timelines[mid_g]
        # 磨床的空闲窗口 → 磨必须在「车完工后 0~max_gap 分钟」开工
        for ws, we in tl_g.free_windows(grd["duration"], horizon["cap"]):
            for mid_c in car_cands:
                tl_c = timelines[mid_c]
                s_c = tl_c.earliest_slot(earliest, car["duration"], horizon["cap"])
                if s_c is None:
                    continue
                r_c = cal.advance(s_c, car["duration"], horizon)
                if r_c is None:
                    continue
                car_end = r_c[1]
                # 磨的实际开工点：不早于车完工 + gap，且必须落在磨床空闲窗口内
                for gap in gaps:
                    start_g = max(car_end + gap, ws)
                    if start_g + grd["duration"] > we:
                        continue                      # 该窗口放不下
                    actual_gap = start_g - car_end
                    if actual_gap < 0 or actual_gap > max_gap:
                        continue
                    r_g = cal.advance(start_g, grd["duration"], horizon)
                    if r_g is None:
                        continue
                    if flow_interp == "c":
                        end_gap = r_g[1] - car_end
                        if not (0 <= end_gap <= max_gap):
                            continue
                    score = (actual_gap, r_c[0])
                    if best is None or score < best[0]:
                        best = (score, mid_c, r_c, mid_g, start_g, actual_gap)
                    break

    if best is None:
        return _fail(ops_of_lot, grd,
                     f"磨床在车完工后 {max_gap}min 内无 {grd['duration']}min 空闲窗口")

    _, mid_c, r_c, mid_g, start_g, gap = best
    r_g = cal.advance(start_g, grd["duration"], horizon)
    if r_g is None:
        return _fail(ops_of_lot, grd, "磨床窗口容量不足")

    timelines[mid_c].occupy(*r_c)
    timelines[mid_g].occupy(*r_g)
    car["machine"], car["start_axis"], car["end_axis"] = mid_c, r_c[0], r_c[1]
    grd["machine"], grd["start_axis"], grd["end_axis"] = mid_g, r_g[0], r_g[1]
    car["status"] = grd["status"] = "scheduled"
    car["flow_gap"] = gap
    grd["flow_gap"] = gap
    return True


# ============================================================
# 三种规则
# ============================================================

def _order_index(clean):
    return {o["id"]: o for o in clean["orders"]}


def _sort_orders(orders, rule):
    """三种排序规则。"""
    if rule == "FIFO":
        # 交期优先（EDD），无交期排最后
        import datetime as _dt
        return sorted(orders, key=lambda o: (
            o["due"] or _dt.date.max, -o["priority"], -o["qty"]))
    if rule == "SPT":
        # 总工时短的优先
        return sorted(orders, key=lambda o: (o["_total_min"], o["id"]))
    if rule == "MWKR":
        # 总工时长的优先（Most Work Remaining）
        return sorted(orders, key=lambda o: (-o["_total_min"], o["id"]))
    return list(orders)


def schedule(ops, clean, horizon, opts, rule="FIFO"):
    """按指定规则排程，返回 (scheduled_ops, unplannable, timelines)。"""
    timelines = {mid: Timeline(mid) for mid, m in clean["machines"].items()
                 if m["status"] == "available"}

    order_meta = _order_index(clean)
    grouped = instance.group_ops_by_order(ops)
    # 汇总每单总工时
    totals = {}
    for (oid, lot), lotops in grouped.items():
        totals[oid] = totals.get(oid, 0) + sum(o["duration"] for o in lotops)

    # 按订单分组 lot
    orders = []
    for o in clean["orders"]:
        o2 = dict(o)
        o2["_total_min"] = totals.get(o["id"], 0)
        orders.append(o2)

    fc_map = {fc["product"]: fc for fc in clean.get("flow_constraints", [])}
    unplannable = []
    sorted_orders = _sort_orders(orders, rule)

    # 【关键】C3 流水产品必须【先】排。
    # 理由：它要求「车完工 → 磨开工 ≤30min」，需要磨床上一段连续空闲窗口。
    # 若让普通订单先排，磨床会被切碎，阀芯C 一个子批都排不进去（实测 10/10 失败）。
    # 先排 C3 = 先给自己的强约束占位，普通订单可以塞剩余缝隙（它们无流水约束）。
    flow_orders = [o for o in sorted_orders if o["product"] in fc_map]
    plain_orders = [o for o in sorted_orders if o["product"] not in fc_map]

    for order in flow_orders:
        fc = fc_map[order["product"]]
        for lot_key in sorted([k for k in grouped if k[0] == order["id"]],
                              key=lambda k: k[1]):
            lotops = grouped[lot_key]
            if not place_flow_lot(lotops, timelines, clean, horizon,
                                  fc, opts.flow_interp):
                unplannable.append(_unplannable_rec(lot_key, order, lotops, "H5/产能"))

    for order in plain_orders:
        for lot_key in sorted([k for k in grouped if k[0] == order["id"]],
                              key=lambda k: k[1]):
            lotops = grouped[lot_key]
            if not place_lot(lotops, timelines, clean, horizon):
                unplannable.append(_unplannable_rec(lot_key, order, lotops, "产能"))

    scheduled = [o for o in ops if o["status"] == "scheduled"]
    return scheduled, unplannable, timelines


def _unplannable_rec(lot_key, order, lotops, kind):
    first = lotops[0] if lotops else {}
    return {
        "order_id": lot_key[0],
        "lot_id": lot_key[1],
        "op": first.get("op"),
        "seq": first.get("seq"),
        "reason": first.get("reason") or "无法排出",
        "kind": kind,
        "product": order.get("product"),
        "suggestion": "调大 --lot-size / 启用闲置机台 / 顺延下一窗口",
    }


# ============================================================
# 评价 + 取最好
# ============================================================

def evaluate(scheduled, clean, horizon, opts):
    """算评价指标，用于比较三种规则。返回 dict。"""
    import datetime as _dt
    makespan = max((o["end_axis"] for o in scheduled), default=0)

    # 每单完工 + 延期判定
    per_order = {}
    for o in scheduled:
        cur = per_order.get(o["order_id"], 0)
        per_order[o["order_id"]] = max(cur, o["end_axis"])

    delayed, total_delay = 0, 0
    for order in clean["orders"]:
        end = per_order.get(order["id"])
        if end is None or order["due"] is None:
            continue
        due_axis = cal.due_to_axis(order["due"], horizon)
        if due_axis is None:
            continue                    # 交期在窗口外，不算延期
        if end > due_axis:
            delayed += 1
            total_delay += end - due_axis

    planned_ids = {o["order_id"] for o in scheduled}
    not_in_horizon = [o["id"] for o in clean["orders"]
                      if o["id"] not in planned_ids
                      and o["due"] and o["due"] > horizon["days"][-1]]

    return {
        "makespan_min": makespan,
        "makespan_days": round(makespan / config.DAY_MINUTES, 2),
        "delayed": delayed,
        "total_delay_min": total_delay,
        "planned_orders": len(planned_ids),
        "not_in_horizon": not_in_horizon,
    }


def pick_best(results):
    """按 (未排入 lot 数, 延期单数, 总延期, makespan) 字典序取最优。"""
    def key(r):
        return (len(r["unplannable"]), r["eval"]["delayed"],
                r["eval"]["total_delay_min"], r["eval"]["makespan_min"])
    return min(results, key=key)


def solve_all(ops, clean, horizon, opts):
    """跑三种规则，返回 {best_rule, scheduled, unplannable, timelines, all}。"""
    import copy
    results = []
    for rule in config.ALGO_CANDIDATES:
        ops_copy = copy.deepcopy(ops)
        sched, unplan, tls = schedule(ops_copy, clean, horizon, opts, rule)
        ev = evaluate(sched, clean, horizon, opts)
        results.append({"rule": rule, "scheduled": sched, "unplannable": unplan,
                        "timelines": tls, "eval": ev})
    best = pick_best(results)
    return {
        "best_rule": best["rule"],
        "scheduled": best["scheduled"],
        "unplannable": best["unplannable"],
        "timelines": best["timelines"],
        "eval": best["eval"],
        "all": [{"rule": r["rule"], "eval": r["eval"],
                 "unplannable": len(r["unplannable"])} for r in results],
    }
