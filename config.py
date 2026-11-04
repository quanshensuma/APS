# -*- coding: utf-8 -*-
"""config.py —— 常驻配置。

按手册 §3.4 ①「参数分三类，不要混」：
  · 常驻配置      → 放本文件（班次、日历、交期口径）
  · 可推导        → 代码里算，不要让客户填（本周起始日 = 最近的周一）
  · 真·每周变     → 就写在设备表状态列 / 订单备注里，不放这里

改本文件会影响所有运行，改动需记入交接说明。
"""

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Optional

# ============================================================
# 一、日历（常驻配置）
# ============================================================

SHIFT_HOURS = 8                    # 单班小时数
SHIFTS_PER_DAY = 2                 # 每日班次数（全厂口径 08:00–24:00）
DAY_START_HOUR = 8                 # 每日开工时刻
DAY_END_HOUR = 24                  # 每日收工时刻（= 次日 00:00）
SKIP_WEEKDAYS = (6,)               # 不排的星期（6 = 周日）
WINDOW_DAYS = 6                    # 一周窗口的工作日数（周一~周六）

SHIFT_MINUTES = SHIFT_HOURS * 60                   # 480
DAY_MINUTES = SHIFTS_PER_DAY * SHIFT_MINUTES       # 960
WINDOW_MINUTES = DAY_MINUTES * WINDOW_DAYS         # 5760（单台窗口容量）

# ============================================================
# 二、交期口径
# ============================================================

DUE_HOUR = 17                      # 交期默认时刻 17:00（手册 §3.4）
AT_RISK_MINUTES = SHIFT_MINUTES    # 余量不足一个班次 → 预警

# ============================================================
# 三、数值
# ============================================================

EPS = 1e-6                         # 浮点比较容差

# ============================================================
# 四、排程
# ============================================================

DEFAULT_LOT_SIZE = 20              # C3 子批大小（见设计文档附录 D）
DEFAULT_FLOW_INTERP = "a"          # C3 解读：a = 车完工→磨开工等待
ALGO_CANDIDATES = ("FIFO", "SPT", "MWKR")
LOT_TAIL_RATIO = 0.3               # 余数 < lot_size*该比例时并入前一批，避免碎批

# ============================================================
# 五、机台主数据（从台账「设备」sheet 转录，12 台）
# ============================================================
# 字段：编号 -> (可做工序列表, 台账班次数, 状态)
# 状态四态：available / down / idle / outsourced
# 注意 HT-01 原文「在用（外协，不计本厂）」必须判为 outsourced

MACHINES = {
    "CNC-01": {"ops": ["铣"],            "shifts": 2, "status": "available",  "model": "立式加工中心 VMC850"},
    "CNC-02": {"ops": ["铣"],            "shifts": 2, "status": "available",  "model": "立式加工中心 VMC850"},
    "CNC-03": {"ops": ["铣", "镗"],       "shifts": 2, "status": "down",       "model": "卧式加工中心 HMC630"},
    "LAT-01": {"ops": ["车"],            "shifts": 2, "status": "available",  "model": "数控车 CK6140"},
    "LAT-02": {"ops": ["车"],            "shifts": 2, "status": "available",  "model": "数控车 CK6140"},
    "LAT-03": {"ops": ["车"],            "shifts": 3, "status": "available",  "model": "数控车 CK6150"},
    "DRL-01": {"ops": ["钻", "攻丝"],     "shifts": 2, "status": "available",  "model": "钻攻中心 T5"},
    "DRL-02": {"ops": ["钻", "攻丝"],     "shifts": 2, "status": "available",  "model": "钻攻中心 T5"},
    "GRD-01": {"ops": ["磨"],            "shifts": 2, "status": "available",  "model": "外圆磨 M1432"},
    "GRD-02": {"ops": ["磨"],            "shifts": 2, "status": "idle",       "model": "平面磨 M7130"},
    "SAW-01": {"ops": ["下料"],           "shifts": 2, "status": "available",  "model": "带锯床 GB4028"},
    "HT-01":  {"ops": ["热处理"],         "shifts": 3, "status": "outsourced", "model": "热处理炉"},
}

# ============================================================
# 六、工艺路线（从台账「工艺路线」sheet 转录，5 个产品）
# ============================================================
# 每个工序：(seq, op, group, pinned, min_per_unit)
#   pinned = 机台编号 → 点名，只能用那一台
#   pinned = None    → 机台组，组内任选
#
# 【关键】磨工序全部点名 GRD-01（台账原文「磨（GRD-01）」），
#         所以 GRD-02（闲置）在严格口径下永远用不上。见设计文档 §3.2 / Q6。

ROUTES = {
    "阀体A": [
        (1, "下料", "下料", "SAW-01", 20),
        (2, "车",   "车",   None,      45),
        (3, "铣",   "铣",   "CNC-03",  60),   # 点名，且该机停机 → 整单进闸门
        (4, "钻",   "钻",   None,      30),
        (5, "磨",   "磨",   "GRD-01",  25),   # 点名
    ],
    "阀体B": [
        (1, "下料", "下料", "SAW-01", 15),
        (2, "车",   "车",   None,      30),
        (3, "钻",   "钻",   None,      25),
        (4, "磨",   "磨",   "GRD-01",  20),
    ],
    "阀芯C": [
        (1, "车",   "车",   None,      40),
        (2, "磨",   "磨",   "GRD-01",  35),
    ],
    "法兰D": [
        (1, "下料", "下料", "SAW-01", 10),
        (2, "车",   "车",   None,      25),
        (3, "铣",   "铣",   None,      40),   # 组，CNC-01/02/03 任选
        (4, "钻",   "钻",   None,      20),
    ],
    "端盖E": [
        (1, "车",   "车",   None,      20),
        (2, "铣",   "铣",   None,      30),
        (3, "钻",   "钻",   None,      15),
    ],
}

# 台账「单件工时合计」列，用于校验 ROUTES 是否正确（防转录错误）
ROUTE_TOTALS = {
    "阀体A": 180,
    "阀体B": 90,
    "阀芯C": 75,
    "法兰D": 95,
    "端盖E": 65,
}

# ============================================================
# 七、C3 流水约束（客户 2026-10-28 澄清）
# ============================================================
# 「阀芯C 里的备注意思是两道工序之间的间隔不能超过 30 分钟」
# 台账备注原文（工艺路线!H5）：磨是瓶颈，别排太散

FLOW_CONSTRAINTS = [
    {
        "product": "阀芯C",
        "from_seq": 1,          # 车
        "to_seq": 2,            # 磨
        "max_gap_min": 30,
        "source": "客户澄清 C3 / 工艺路线!H5「磨是瓶颈，别排太散」",
        "confirmed": False,     # Q7 确认后改 True
    },
]

# ============================================================
# 八、运行参数（每次运行可覆盖，不写死）
# ============================================================

@dataclass
class RunOptions:
    """每次运行的参数。由 CLI 或 API 传入。"""
    # 设备与班次
    enable_grd02: bool = False       # Q1/Q6：是否允许用 GRD-02
    morning_as_group: bool = False   # Q6：磨是否视为机台组（不点名）
    enable_cnc03: bool = False       # Q2：是否假设 CNC-03 已恢复
    allow_mill_substitute: bool = True   # Q2：阀体A 铣削是否允许走其他立加
                                         # 【与前端对齐】engine.js DEFAULT_OPTS.allowSwap = true
    three_shift: bool = False        # A1：是否允许 LAT-03 三班

    # C3
    lot_size: int = DEFAULT_LOT_SIZE
    flow_interp: str = DEFAULT_FLOW_INTERP   # "a" | "c"

    # 窗口
    origin_date: Optional[date] = None       # None = 从台账整理日推
    window_days: int = WINDOW_DAYS

    # 输出
    out_dir: str = "out"
    verbose: bool = False


# ============================================================
# 九、可推导项（函数，不是常量）
# ============================================================

def horizon_start(ref_date: date) -> date:
    """取 ref_date 之后【最近的下一个周一】。

    台账整理日是 2026-11-08（周日），下一个周一是 11-09。
    若用 ref_date - timedelta(days=weekday) 会得到 11-02，【整周错位】。
    """
    days_ahead = (0 - ref_date.weekday()) % 7
    if days_ahead == 0:      # 正好是周一 → 取下一个周一
        days_ahead = 7
    return ref_date + timedelta(days=days_ahead)


def working_days(start: date, window_days: int = WINDOW_DAYS) -> list[date]:
    """从 start 起，取 window_days 个工作日（跳过 SKIP_WEEKDAYS）。"""
    days, d = [], start
    while len(days) < window_days:
        if d.weekday() not in SKIP_WEEKDAYS:
            days.append(d)
        d += timedelta(days=1)
    return days


def effective_machines(opts: RunOptions) -> dict:
    """按 RunOptions 覆盖设备状态与班次，返回可用机台字典（深拷贝，不改 MACHINES）。"""
    out = {}
    for mid, m in MACHINES.items():
        m2 = dict(m, ops=list(m["ops"]))
        # 班次覆盖（A1：默认两班封顶）
        cap = 3 if opts.three_shift else 2
        m2["effective_shifts"] = min(m["shifts"], cap)
        # GRD-02 状态覆盖（Q1）
        if mid == "GRD-02" and opts.enable_grd02:
            m2["status"] = "available"
        # CNC-03 状态覆盖（Q2）
        if mid == "CNC-03" and opts.enable_cnc03:
            m2["status"] = "available"
        m2["daily_minutes"] = m2["effective_shifts"] * SHIFT_MINUTES
        out[mid] = m2
    return out


def build_groups(machines: dict) -> dict:
    """从设备表「可做工序」反推机台组。"""
    groups = {}
    for mid, m in machines.items():
        for g in m["ops"]:
            groups.setdefault(g, []).append(mid)
    return groups


def params_line(opts: RunOptions, start: date) -> str:
    """手册 §3.4：每次输出必须打印一行「本次参数」，事后不扯皮。"""
    return (
        f"原点 {start} | 两班{SHIFT_HOURS}h | 周日不排 | 交期{DUE_HOUR}:00 | "
        f"窗口{opts.window_days}天 | GRD02={'on' if opts.enable_grd02 else 'off'} | "
        f"磨组={'on' if opts.morning_as_group else 'off'} | "
        f"CNC03={'on' if opts.enable_cnc03 else 'off'} | "
        f"LAT03={'3班' if opts.three_shift else '2班'} | "
        f"lot={opts.lot_size} | C3=解读{opts.flow_interp}"
    )
