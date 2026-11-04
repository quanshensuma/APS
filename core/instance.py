# -*- coding: utf-8 -*-
"""core/instance.py —— 订单 → 工序任务（Operation）。

【最大的坑】单位是「分钟/件」不是「分钟/批」。
阀体A 40 件：180 × 40 = 7200 min（不是 180）。
若当每批，总量差 40 倍，风险清单一条不报。

任务书 N4 验收点：「抽一单手算，分钟数对得上」。
"""

from __future__ import annotations

import config


def op_duration(min_per_unit, qty) -> int:
    """时长 = 单件工时 × 数量，四舍五入到整数分钟。"""
    return int(round(float(min_per_unit) * float(qty)))


def split_lots(qty: float, lot_size: int) -> list:
    """拆子批。返回每批件数列表。

    120 / 20 → [20]*6
    80  / 20 → [20]*4
    35  / 20 → [20, 15]
    21  / 20 → [21]        ← 余 1 件 < 20*0.3=6，并入前一批，避免碎批
    17.5/ 20 → [17.5]      ← 不足一批
    """
    if lot_size <= 0:
        return [qty]
    if qty <= lot_size:
        return [qty]
    n_full = int(qty // lot_size)
    tail = qty - n_full * lot_size
    lots = [float(lot_size)] * n_full
    if tail > config.EPS:
        if tail < lot_size * config.LOT_TAIL_RATIO:
            lots[-1] += tail          # 余数太小，并入前一批
        else:
            lots.append(tail)
    return lots


def is_flow_product(product: str, clean: dict) -> bool:
    """该产品是否受 C3 流水约束（需要拆子批）。"""
    return any(fc["product"] == product for fc in clean.get("flow_constraints", []))


def build_ops(clean: dict, opts) -> list:
    """订单 × 路线 → Operation 列表。

    非 C3 产品：一单一个 lot（lot_id == order_id）
    C3 产品：按 opts.lot_size 拆子批
    """
    ops = []
    for o in clean["orders"]:
        route = clean["routes"][o["product"]]
        flow = is_flow_product(o["product"], clean)
        lots = split_lots(o["qty"], opts.lot_size) if flow else [o["qty"]]

        for li, lot_qty in enumerate(lots, start=1):
            lot_id = f"{o['id']}-L{li}" if flow else o["id"]
            for op in route:
                ops.append({
                    "order_id": o["id"],
                    "lot_id": lot_id,
                    "lot_index": li,
                    "lots_total": len(lots),
                    "seq": op["seq"],
                    "op": op["op"],
                    "group": op["group"],
                    "pinned": op["pinned"] if not _override_pinned(op, opts) else None,
                    "min_per_unit": op["min_per_unit"],
                    "qty": lot_qty,
                    "duration": op_duration(op["min_per_unit"], lot_qty),
                    "product": o["product"],
                    "priority": o["priority"],
                    "due": o["due"],
                    "release": o.get("release"),
                    # 排程后填充
                    "machine": None,
                    "start_axis": None,
                    "end_axis": None,
                    "status": "pending",
                })
    return ops


def _override_pinned(op: dict, opts) -> bool:
    """按参数把「点名」降级为「组」。

    Q2：--allow-mill-substitute → 铣的点名不算数，走组
    Q6：--morning-as-group       → 磨的点名不算数，走组
    """
    if op["op"] == "铣" and opts.allow_mill_substitute:
        return True
    if op["op"] == "磨" and opts.morning_as_group:
        return True
    return False


def order_sort_key(order: dict) -> tuple:
    """排序键：(优先级降序, 交期升序, 数量降序, 单号)。"""
    import datetime as _dt
    due = order.get("due") or _dt.date.max
    return (-order.get("priority", 3), due, -order.get("qty", 0), order["id"])


def group_ops_by_order(ops: list) -> dict:
    """按 (order_id, lot_id) 分组，组内按 seq 排序。"""
    out = {}
    for op in ops:
        out.setdefault((op["order_id"], op["lot_id"]), []).append(op)
    for k in out:
        out[k].sort(key=lambda x: x["seq"])
    return out


def hand_check(ops: list, order_id: str) -> int:
    """手算校验用：返回该订单全部工序的时长之和。

    【注意】必须传「全部 ops」（含未排入的），不是只传 scheduled。
    否则未排入的单会算出 0。
    """
    return sum(op["duration"] for op in ops if op["order_id"] == order_id)
