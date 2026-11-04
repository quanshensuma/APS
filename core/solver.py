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
from core import workcal as cal
from core import instance


# ============================================================
# 机台时间线
# ============================================================

class Timeline:
    """单机台已占用区间（轴分钟），始终有序且不重叠。"""

    def __init__(self, machine_id):
        self.machine_id = machine_id
        self.busys = []          # [(start, end)]  升序

    def earliest_slot(self, after, duration, cap=None):
        """返回 >= after 的、能容纳 duration 的最早开始点。

        【与前端对齐】不再受窗口 cap 限制 —— 排不下就往后排（排到下周），
        而不是把整单标成"排不进"。"本周排不完"由风险清单按类型体现。
        """
        t = max(after, 0)
        for s, e in self.busys:
            if t + duration <= s:
                return t
            if e > t:
                t = e
        return t

    def occupy(self, start, end):
        for s, e in self.busys:
            if not (end <= s or start >= e):
                raise AssertionError(
                    f"内部错误：{self.machine_id} 区间重叠 "
                    f"[{start},{end}) vs [{s},{e})")
        self.busys.append((start, end))
        self.busys.sort()

    def free_windows(self, min_dur, cap=None):
        """返回所有 >= min_dur 的空闲窗口 [(s, e)]，含末尾无限延伸的那一段。"""
        out = []
        prev = 0
        for s, e in self.busys:
            if s - prev >= min_dur:
                out.append((prev, s))
            prev = max(prev, e)
        # 末尾：给一个足够大的上界（相当于"永远有空"）
        tail_end = max(prev + min_dur, (cap or 0) + min_dur)
        out.append((prev, tail_end))
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
    """标记整条 lot 未排入。

    【关键】reason 只挂在【失败的那道工序】上（op["fail_reason"]），
    不能敷到整条链 —— 否则报告里会出现「下料：钻床没槽位」这种错位描述。
    其它工序只标 unplannable + blocked_by 指回失败工序。
    """
    for o in ops_of_lot:
        o["status"] = "unplannable"
    op["fail_reason"] = reason
    op["fail_seq"] = op.get("seq")
    op["fail_op"] = op.get("op")
    for o in ops_of_lot:
        o["blocked_by"] = {"seq": op.get("seq"), "op": op.get("op"),
                           "reason": reason}
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
        # 【与前端 engine.js 对齐】紧贴放不进去时，不让整单消失：
        # 退化为「顺排」—— 车照排，磨排到磨床下一个可用窗口，
        # 并在 op 上标记 flow_violation，由校验器 H5 如实报出违规。
        # 理由：客户要看到「这单到底哪天能做完」，而不是「排不进」三个字。
        return _place_flow_fallback(ops_of_lot, timelines, clean, horizon,
                                    car, grd, car_cands, grd_cands, max_gap)

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


def place_flow_group(order, lots, grouped, timelines, clean, horizon,
                     fc, opts, unplannable):
    """C3 子批分组排程：先并行排所有车，再逐个排磨。

    【与前端 engine.js 对齐】这样才能吃到多台车床的并行度，
    makespan 比"一个子批车磨一起排完再下一个"小得多。
    """
    max_gap = fc["max_gap_min"]
    stages = []          # [(lot_key, lotops, car, grd, r_car)]

    # ---- ① 所有子批先排车 ----
    for lot_key in lots:
        lotops = grouped[lot_key]
        car = next((o for o in lotops if o["seq"] == fc["from_seq"]), None)
        grd = next((o for o in lotops if o["seq"] == fc["to_seq"]), None)
        if car is None or grd is None:
            _fail(lotops, lotops[0], "流水约束的工序不在该子批中")
            unplannable.append(_unplannable_rec(lot_key, order, lotops, "H5/产能"))
            continue

        cands = resolve_candidates(car, clean)
        if not cands:
            _fail(lotops, car, "流水约束：车床无可用机台")
            unplannable.append(_unplannable_rec(lot_key, order, lotops, "H5/产能"))
            continue

        earliest = release_axis(car, horizon)
        best = None
        for mid in cands:
            sl = timelines[mid].earliest_slot(earliest, car["duration"], horizon["cap"])
            if sl is None:
                continue
            r = cal.advance(sl, car["duration"], horizon)
            if r is None:
                continue
            key = (r[0], timelines[mid].load())
            if best is None or key < best[0]:
                best = (key, mid, r)
        if best is None:
            _fail(lotops, car, "流水约束：车床无可用槽位")
            unplannable.append(_unplannable_rec(lot_key, order, lotops, "H5/产能"))
            continue

        _, mid, r = best
        timelines[mid].occupy(*r)
        car["machine"], car["start_axis"], car["end_axis"] = mid, r[0], r[1]
        car["status"] = "scheduled"
        stages.append((lot_key, lotops, car, grd, r))

    # ---- ② 逐个把磨排到车完工之后 ----
    gaps = [30, 25, 20, 15, 10, 5] if opts.flow_interp == "c" else [30, 25, 20, 15, 10, 5, 0]
    gaps = [g for g in gaps if g <= max_gap] or [max_gap]

    # 【关键】磨床占用顺序 = 按「订单优先级 → 车完工时间」。
    # 不能只按车完工排：低优先级订单的车可能抢在前面，
    # 结果高优先级订单的磨被挤到后面，gap 爆掉（实测 2030~4030min）。
    stages.sort(key=lambda x: (-order.get("priority", 3), x[4][1]))

    for lot_key, lotops, car, grd, r_car in stages:
        grd_cands = resolve_candidates(grd, clean)
        car_end = r_car[1]
        best = None
        if grd_cands:
            for mid_g in grd_cands:
                tl_g = timelines[mid_g]
                for ws, we in tl_g.free_windows(grd["duration"], horizon["cap"]):
                    for gap in gaps:
                        start_g = max(car_end + gap, ws)
                        if we is not None and start_g + grd["duration"] > we:
                            continue
                        actual = start_g - car_end
                        if actual < 0 or actual > max_gap:
                            continue
                        r_g = cal.advance(start_g, grd["duration"], horizon)
                        if r_g is None:
                            continue
                        if opts.flow_interp == "c":
                            eg = r_g[1] - car_end
                            if not (0 <= eg <= max_gap):
                                continue
                        # gap 越小越好（越紧贴车完工），其次开工越早越好
                        score = (actual, r_g[0])
                        if best is None or score < best[0]:
                            best = (score, mid_g, r_g, actual)
                        break

        if best is None:
            # 退化：顺排，交给 H5 报违规（与前端一致）
            if not _place_flow_fallback_single(lotops, timelines, clean, horizon,
                                               car, grd, r_car, max_gap):
                unplannable.append(_unplannable_rec(lot_key, order, lotops, "H5/产能"))
            continue

        _, mid_g, r_g, gap = best
        timelines[mid_g].occupy(*r_g)
        grd["machine"], grd["start_axis"], grd["end_axis"] = mid_g, r_g[0], r_g[1]
        grd["status"] = "scheduled"
        car["flow_gap"] = grd["flow_gap"] = gap
    return True


def _place_flow_fallback_single(lotops, timelines, clean, horizon,
                                car, grd, r_car, max_gap):
    """车已排好，磨退化为"车完工后第一个可用窗口"（不再要求 ≤max_gap）。"""
    grd_cands = resolve_candidates(grd, clean)
    if not grd_cands:
        return _fail(lotops, grd, "流水约束：磨床无可用机台")
    car_end = r_car[1]
    best = None
    for mid_g in grd_cands:
        sl = timelines[mid_g].earliest_slot(car_end, grd["duration"], horizon["cap"])
        if sl is None:
            continue
        r = cal.advance(sl, grd["duration"], horizon)
        if r is None:
            continue
        key = (r[0], timelines[mid_g].load())
        if best is None or key < best[0]:
            best = (key, mid_g, r)
    if best is None:
        return _fail(lotops, grd, "流水约束：磨床无可用槽位")
    _, mid_g, r_g = best
    timelines[mid_g].occupy(*r_g)
    grd["machine"], grd["start_axis"], grd["end_axis"] = mid_g, r_g[0], r_g[1]
    grd["status"] = "scheduled"
    gap = grd["start_axis"] - car["end_axis"]
    car["flow_gap"] = grd["flow_gap"] = gap
    grd["flow_violation"] = gap > max_gap
    return True


def _place_flow_fallback(ops_of_lot, timelines, clean, horizon,
                        car, grd, car_cands, grd_cands, max_gap):
    """C3 紧贴失败时的退化路径：顺排 + 标记违规。

    优先保证「每道工序都有排程」，让 H5 去报间隔超标，
    而不是让整张单从排程表里消失。
    """
    earliest = release_axis(car, horizon)

    # 先排车（取最早可用）
    best_car = None
    for mid_c in car_cands:
        s_c = timelines[mid_c].earliest_slot(earliest, car["duration"], horizon["cap"])
        if s_c is None:
            continue
        r_c = cal.advance(s_c, car["duration"], horizon)
        if r_c is None:
            continue
        key = (r_c[0], timelines[mid_c].load())
        if best_car is None or key < best_car[0]:
            best_car = (key, mid_c, r_c)
    if best_car is None:
        return _fail(ops_of_lot, car, "流水约束：车床无可用槽位")

    _, mid_c, r_c = best_car
    car_end = r_c[1]

    # 磨排在车完工之后的第一个可用窗口（不再要求 ≤ max_gap）
    best_g = None
    for mid_g in grd_cands:
        s_g = timelines[mid_g].earliest_slot(car_end, grd["duration"], horizon["cap"])
        if s_g is None:
            continue
        r_g = cal.advance(s_g, grd["duration"], horizon)
        if r_g is None:
            continue
        key = (r_g[0], timelines[mid_g].load())
        if best_g is None or key < best_g[0]:
            best_g = (key, mid_g, r_g)
    if best_g is None:
        return _fail(ops_of_lot, grd, "流水约束：磨床无可用槽位")

    _, mid_g, r_g = best_g
    timelines[mid_c].occupy(*r_c)
    timelines[mid_g].occupy(*r_g)

    car["machine"], car["start_axis"], car["end_axis"] = mid_c, r_c[0], r_c[1]
    grd["machine"], grd["start_axis"], grd["end_axis"] = mid_g, r_g[0], r_g[1]
    car["status"] = grd["status"] = "scheduled"
    gap = grd["start_axis"] - car["end_axis"]
    car["flow_gap"] = gap
    grd["flow_gap"] = gap
    # 交给校验器 H5 报违规（不在这里下结论）
    grd["flow_violation"] = gap > max_gap
    return True


# ============================================================
# 三种规则 ============================================================

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
        lots = sorted([k for k in grouped if k[0] == order["id"]],
                      key=lambda k: k[1])
        # 【与前端对齐】先给所有子批的「车」排位（车床有 3 台，可并行），
        # 再逐个把「磨」排到各自车完工之后最紧的窗口。
        # 串行"车磨一起排"会让 L2 白等 L1 的磨，makespan 明显偏大。
        if not place_flow_group(order, lots, grouped, timelines, clean,
                                horizon, fc, opts, unplannable):
            continue

    for order in plain_orders:
        for lot_key in sorted([k for k in grouped if k[0] == order["id"]],
                              key=lambda k: k[1]):
            lotops = grouped[lot_key]
            if not place_lot(lotops, timelines, clean, horizon):
                unplannable.append(_unplannable_rec(lot_key, order, lotops, "产能"))

    scheduled = [o for o in ops if o["status"] == "scheduled"]
    return scheduled, unplannable, timelines


def _unplannable_rec(lot_key, order, lotops, kind):
    """构造未排入记录。

    【关键】定位到【真正排不进的那道工序】：优先找带 fail_reason 的，
    找不到才回退到首道。这样报告里「卡在哪道工序」才对得上。
    """
    failed = next((o for o in lotops if o.get("fail_reason")), None)
    if failed is None:
        failed = lotops[0] if lotops else {}
    reason = failed.get("fail_reason") or "无法排出"
    return {
        "order_id": lot_key[0],
        "lot_id": lot_key[1],
        "op": failed.get("op"),
        "seq": failed.get("seq"),
        "reason": reason,
        "kind": kind,
        "product": order.get("product"),
        "planned_seq_before_fail": [o["seq"] for o in lotops
                                    if o.get("status") == "scheduled"],
        "suggestion": _suggest(reason),
    }


def _suggest(reason: str) -> str:
    """按失败原因给可执行的建议（不是套话）。"""
    r = reason or ""
    if "磨床" in r or "GRD" in r:
        return "磨床是单台瓶颈：调大 --lot-size 减少批数 / 启用 GRD-02 / 顺延"
    if "CNC" in r or "铣" in r:
        return "CNC-03 停机：确认能否走其他立加（--allow-mill-substitute）"
    if "无可用机台" in r:
        return "点名机台不可用：确认是否可换机（Q2/Q6）"
    if "槽位" in r:
        return "该机台窗口已被占满：顺延下一窗口 / 增开班次"
    return "调大 --lot-size / 启用闲置机台 / 顺延下一窗口"


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
    """跑三种规则，取最好，并把【选中那一次】的状态写回传入的 ops。

    【关键】必须把结果写回原 ops 列表（in-place），
    否则调用方拿到的 ops 全是 status=pending，校验器会误判全部漏排。
    用 deepcopy 试算、最后回填，既能比较三种规则又不污染。
    """
    import copy

    results = []
    for rule in config.ALGO_CANDIDATES:
        ops_copy = copy.deepcopy(ops)
        sched, unplan, tls = schedule(ops_copy, clean, horizon, opts, rule)
        ev = evaluate(sched, clean, horizon, opts)
        results.append({"rule": rule, "ops": ops_copy, "scheduled": sched,
                        "unplannable": unplan, "timelines": tls, "eval": ev})

    best = pick_best(results)

    # 回填状态到原 ops（按 (order_id, lot_id, seq) 对齐）
    idx = {(o["order_id"], o["lot_id"], o["seq"]): o for o in ops}
    for o in best["ops"]:
        key = (o["order_id"], o["lot_id"], o["seq"])
        target = idx.get(key)
        if target is None:
            continue
        for f in ("machine", "start_axis", "end_axis", "status", "reason", "flow_gap"):
            if f in o:
                target[f] = o[f]

    return {
        "best_rule": best["rule"],
        "scheduled": [o for o in ops if o["status"] == "scheduled"],
        "unplannable": best["unplannable"],
        "timelines": best["timelines"],
        "eval": best["eval"],
        "all": [{"rule": r["rule"], "eval": r["eval"],
                 "unplannable": len(r["unplannable"])} for r in results],
    }
