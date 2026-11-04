# -*- coding: utf-8 -*-
"""core/workcal.py —— 工作日历换算。

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


def make_horizon(start: _dt.date, window_days: int = None,
                 max_days: int = None) -> dict:
    """构造排程日历。

    返回 {start, days, per_day, cap, window_days, day_at, extend_to}

    【重要】语义与前端 engine.js 的 makeCalendar 对齐：
      · window_days 是「本周窗口」（6 天），只用于判定「未排入本周」
      · cap 是窗口容量（用于产能核算），【不是排程硬上限】
      · 排程可以向后扩展（day_at(i) 自动往后生成工作日），
        否则产能不足时会把整单标成「排不进」，而实际只是排到下周
    """
    if window_days is None:
        window_days = config.WINDOW_DAYS
    per_day = config.DAY_MINUTES
    state = {
        "start": start,
        "per_day": per_day,
        "_days": list(config.working_days(start, window_days)),
        "window_days": window_days,
        "_max_days": max_days or (window_days * 6),   # 最多延伸到 6 倍窗口
    }
    state["cap"] = per_day * window_days
    # days = 窗口内固定的 6 天（用于"未排入本周"判定、甘特图横轴）
    state["days"] = list(state["_days"])
    return state


def day_at(hz: dict, i: int) -> _dt.date:
    """第 i 个工作日（自动向后扩展，跳过周日）。"""
    days = hz["_days"]
    while len(days) <= i:
        d = days[-1] + _dt.timedelta(days=1)
        while d.weekday() in config.SKIP_WEEKDAYS:
            d += _dt.timedelta(days=1)
        days.append(d)
        if len(days) > hz["_max_days"]:
            raise CalendarError(
                f"排程超出 {hz['_max_days']} 个工作日，产能严重不足")
    return days[i]


def extend(hz: dict, duration: int, from_axis: int) -> int:
    """确保从 from_axis 起有 duration 分钟可用，返回需要的工作日数。"""
    need = from_axis + duration
    while hz["per_day"] * len(hz["_days"]) < need:
        day_at(hz, len(hz["_days"]))
    return len(hz["_days"])


# ------------------------------------------------------------
# 轴 → 挂钟
# ------------------------------------------------------------

def minutes_to_dt(axis: int, horizon: dict) -> _dt.datetime:
    """轴分钟 → 挂钟时刻（支持超出窗口，自动扩展日历）。"""
    if axis < 0:
        raise CalendarError(f"轴 {axis} 不能为负")
    day_idx, off = divmod(axis, horizon["per_day"])
    day = day_at(horizon, day_idx)
    base = _dt.datetime(day.year, day.month, day.day, config.DAY_START_HOUR)
    return base + _dt.timedelta(minutes=off)


def dt_to_minutes(dt: _dt.datetime, horizon: dict) -> int:
    """挂钟时刻 → 轴分钟。落在夜间/周日则抛错。"""
    d = dt.date()
    days = horizon["_days"]
    if d in days:
        day_idx = days.index(d)
    else:
        # 窗口外但仍是工作日 → 按需扩展
        if d.weekday() in config.SKIP_WEEKDAYS:
            raise CalendarError(f"{d} 是周日，不排产")
        if d < horizon["start"]:
            raise CalendarError(f"{d} 早于排程原点 {horizon['start']}")
        day_idx = 0
        while day_at(horizon, day_idx) != d:
            day_idx += 1
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
    if start_axis < 0:
        start_axis = 0
    if duration <= 0:
        return (start_axis, start_axis)

    # 【关键】不再用窗口 cap 拒绝：排程可以向后扩展（与前端 engine.js 一致）。
    # 超出 _max_days 时 day_at 会抛 CalendarError，由调用方转成 unplannable。
    if cross_day:
        try:
            extend(horizon, duration, start_axis)
        except CalendarError:
            return None
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
            if di >= len(horizon["_days"]):
                return None
    return (start_axis, di * per_day + off)


def fmt(axis: int, horizon: dict) -> str:
    """轴分钟 → 'MM-DD HH:MM'（给报告用，计划员看得懂）。"""
    try:
        dt = minutes_to_dt(axis, horizon)
        return dt.strftime("%m-%d %H:%M")
    except CalendarError:
        return f"axis{axis}"


def index_on_or_after(d: _dt.date, horizon: dict) -> int:
    """交期日 → 工作日序号（落在周日则顺延到下一个工作日）。

    【与前端 engine.js 的 cal.indexOnOrAfter 对齐】
    工厂周日不排，所以「周日到期」实际按周一算。
    """
    if d is None:
        return None
    i = 0
    while True:
        day = day_at(horizon, i)
        if day >= d:
            return i
        i += 1
        if i > 400:
            raise CalendarError(f"{d} 太远，超出可排范围")


def due_info(due: _dt.date, horizon: dict, hour: int = None) -> dict:
    """交期 → {in_horizon, index, axis}。

    in_horizon：交期（顺延周日后的工作日）是否落在本周窗口内
    axis      ：交付截止的轴分钟（当日 17:00）；不在窗口内则为 None
    """
    if due is None:
        return {"in_horizon": False, "index": None, "axis": None}
    if hour is None:
        hour = config.DUE_HOUR
    idx = index_on_or_after(due, horizon)
    window_end_idx = horizon["window_days"] - 1
    in_horizon = (idx is not None) and (0 <= idx <= window_end_idx)
    if not in_horizon:
        return {"in_horizon": False, "index": idx, "axis": None}
    axis = idx * horizon["per_day"] + (hour - config.DAY_START_HOUR) * 60
    return {"in_horizon": True, "index": idx, "axis": axis}


def due_to_axis(due: _dt.date, horizon: dict, hour: int = None) -> Optional[int]:
    """兼容旧调用：窗口内返回轴分钟，窗口外返回 None。"""
    return due_info(due, horizon, hour)["axis"]
