# -*- coding: utf-8 -*-
"""core/calendar.py —— 工作日历换算。

【设计核心】轴（axis）是「只含可用时间」的分钟计数器：
    轴 0    = 第 1 个工作日 08:00
    轴 479  = 第 1 个工作日 15:59
    轴 480  = 第 1 个工作日 16:00
    轴 959  = 第 1 个工作日 23:59
    轴 960  = 第 2 个工作日 08:00   ← 跳过夜间 8 小时
    轴 5759 = 第 6 个工作日 23:59（窗口末）

因为轴上全是可用时间，区间运算会自动跳过夜间和周日，
不需要每次加法后检查班次边界 —— 这是本设计最重要的简化。
"""

from __future__ import annotations

import datetime as _dt
from typing import Optional

import config


class CalendarError(Exception):
    """时间落在不可排区域（夜间 / 周日 / 窗口外）。"""


def make_horizon(start: _dt.date, window_days: int = None) -> dict:
    """构造一个排程窗口。返回 {days, per_day, cap, start}。"""
    if window_days is None:
        window_days = config.WINDOW_DAYS
    days = config.working_days(start, window_days)
    per_day = config.DAY_MINUTES
    return {
        "start": start,
        "days": days,
        "per_day": per_day,
        "cap": per_day * len(days),
        "window_days": len(days),
    }


# ------------------------------------------------------------
# 轴 → 挂钟
# ------------------------------------------------------------

def minutes_to_dt(axis: int, horizon: dict) -> _dt.datetime:
    """轴分钟 → 挂钟时刻。"""
    if axis < 0 or axis >= horizon["cap"]:
        raise CalendarError(f"轴 {axis} 超出窗口 [0,{horizon['cap']})")
    day_idx, off = divmod(axis, horizon["per_day"])
    day = horizon["days"][day_idx]
    base = _dt.datetime(day.year, day.month, day.day, config.DAY_START_HOUR)
    return base + _dt.timedelta(minutes=off)


def dt_to_minutes(dt: _dt.datetime, horizon: dict) -> int:
    """挂钟时刻 → 轴分钟。落在夜间/周日/窗口外则抛错。"""
    d = dt.date()
    if d not in horizon["days"]:
        raise CalendarError(f"{d} 不在窗口工作日内（可能落在周日）")
    day_idx = horizon["days"].index(d)
    minutes_of_day = (dt.hour - config.DAY_START_HOUR) * 60 + dt.minute
    if minutes_of_day < 0 or minutes_of_day >= horizon["per_day"]:
        raise CalendarError(
            f"{dt} 不在 {config.DAY_START_HOUR}:00–{config.DAY_END_HOUR}:00 内")
    return day_idx * horizon["per_day"] + minutes_of_day


# ------------------------------------------------------------
# 推进
# ------------------------------------------------------------

def advance(start_axis: int, duration: int, horizon: dict,
            cross_day: bool = True) -> Optional[tuple[int, int]]:
    """从 start_axis 占用 duration 分钟，返回 (start, end)；不可行返回 None。

    【v1 性质】因为轴上全是可用时间，且假设 A10 允许跨日不打断加工，
    所以 end == start + duration 恒成立。

    cross_day=False 时（对应「每天 24:00 强制停机」），
    加工不能跨日，需要按日切分 —— 保留该分支作为扩展点。
    """
    cap = horizon["cap"]
    if start_axis < 0:
        start_axis = 0
    if start_axis >= cap:
        return None
    if duration <= 0:
        return (start_axis, start_axis)
    if duration > cap - start_axis:
        return None

    if cross_day:
        return (start_axis, start_axis + duration)

    # 不跨日：逐日消耗
    per_day = horizon["per_day"]
    di, off = divmod(start_axis, per_day)
    remain = duration
    while remain > 0:
        room = per_day - off
        take = min(room, remain)
        off += take
        remain -= take
        if off == per_day and remain > 0:
            di += 1
            off = 0
            if di >= len(horizon["days"]):
                return None
    return (start_axis, di * per_day + off)


def fmt(axis: int, horizon: dict) -> str:
    """轴分钟 → 'MM-DD HH:MM'（给报告用，计划员看得懂）。"""
    try:
        dt = minutes_to_dt(axis, horizon)
        return dt.strftime("%m-%d %H:%M")
    except CalendarError:
        return f"axis{axis}"


def due_to_axis(due: _dt.date, horizon: dict, hour: int = None) -> Optional[int]:
    """交期日 → 交付截止的轴分钟（当日 17:00）。窗口外返回 None。

    交期在窗口之前 → 0（已过期，按最早算）
    交期在窗口之后 → None（不算延期）
    """
    if due is None:
        return None
    if hour is None:
        hour = config.DUE_HOUR
    days = horizon["days"]
    if due < days[0]:
        return 0
    if due > days[-1]:
        return None
    try:
        return dt_to_minutes(_dt.datetime(due.year, due.month, due.day, hour), horizon)
    except CalendarError:
        # 交期是周日 → 取该周最后一个工作日末
        for d in reversed(days):
            if d <= due:
                return (days.index(d) + 1) * horizon["per_day"]
        return 0
