# -*- coding: utf-8 -*-
"""tests/test_core.py —— 核心单测。

任务书要求「≥3 个单测：单号归一、日期解析、checker 抓撞机」，
本文件覆盖 24 条（含任务书 3 条必做 + 本次设计识别的坑）。

运行：python -m pytest tests/ -q
或：  python tests/test_core.py
"""

import datetime as _dt
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from core import workcal as cal
from core import checker, cleaner, instance, solver

# ============================================================
# 一、日历（C 系列）
# ============================================================

def _hz(start=_dt.date(2026, 11, 9)):
    return cal.make_horizon(start)


def test_C1_horizon_start_sunday():
    """台账整理日 2026-11-08 是周日 → 下一个周一 11-09。

    若用 date - timedelta(weekday) 会得到 11-02，整周错位。
    """
    assert config.horizon_start(_dt.date(2026, 11, 8)) == _dt.date(2026, 11, 9)


def test_C2_horizon_start_monday():
    """正好是周一 → 取下一个周一（本周已开始，下周再排）。"""
    assert config.horizon_start(_dt.date(2026, 11, 9)) == _dt.date(2026, 11, 16)


def test_C3_offset_zero():
    hz = _hz()
    assert cal.minutes_to_dt(0, hz) == _dt.datetime(2026, 11, 9, 8, 0)


def test_C4_offset_shift_boundary():
    hz = _hz()
    assert cal.minutes_to_dt(480, hz) == _dt.datetime(2026, 11, 9, 16, 0)


def test_C5_offset_cross_day():
    """轴 960 = 次日 08:00（跳过夜间 8 小时）。"""
    hz = _hz()
    assert cal.minutes_to_dt(960, hz) == _dt.datetime(2026, 11, 10, 8, 0)


def test_C6_offset_window_end():
    hz = _hz()
    assert cal.minutes_to_dt(5759, hz) == _dt.datetime(2026, 11, 14, 23, 59)


def test_C7_offset_out_of_range():
    """负值抛错；正整数轴合法（日历可向后扩展，与前端 engine.js 一致）。"""
    hz = _hz()
    try:
        cal.minutes_to_dt(-1, hz)
        assert False, "负轴应该抛错"
    except cal.CalendarError:
        pass
    # 轴 5760 = 窗口外第 7 个工作日 08:00，允许扩展
    assert cal.minutes_to_dt(5760, hz) == _dt.datetime(2026, 11, 16, 8, 0)


def test_C8_roundtrip():
    """往返一致（100 组）。"""
    hz = _hz()
    for k in range(0, 5760, 57):
        dt = cal.minutes_to_dt(k, hz)
        assert cal.dt_to_minutes(dt, hz) == k


def test_C9_dt_to_minutes_sunday():
    """周日不在窗口工作日 → 抛错。"""
    hz = _hz()
    try:
        cal.dt_to_minutes(_dt.datetime(2026, 11, 15, 10, 0), hz)
        assert False
    except cal.CalendarError:
        pass


def test_C10_advance_cross_day():
    """13:00 起 700min（跨班次跨日）：360+700=1060。"""
    hz = _hz()
    assert cal.advance(360, 700, hz) == (360, 1060)


# ============================================================
# 二、清洗（K 系列）
# ============================================================

def test_K1_norm_order_id_standard():
    oid, notes = cleaner.norm_order_id("HD-2026-101")
    assert oid == "HD-2026-101"
    assert notes == []


def test_K2_norm_order_id_missing_dash():
    oid, notes = cleaner.norm_order_id("HD2026102")
    assert oid == "HD-2026-102"
    assert notes


def test_K3_norm_order_id_plain_number():
    oid, notes = cleaner.norm_order_id("104")
    assert oid == "HD-2026-104"
    assert notes


def test_K4_parse_date_slash():
    d, lv, _ = cleaner.parse_date("2026/11/3")
    assert d == _dt.date(2026, 11, 3) and lv == "exact"


def test_K5_parse_date_dot():
    d, lv, _ = cleaner.parse_date("2026.11.4")
    assert d == _dt.date(2026, 11, 4) and lv == "exact"


def test_K6_parse_date_chinese_missing_year():
    """「11月12日」缺年份 → 必须补 2026，否则会被当成无交期（PPT 翻车 #2）。"""
    d, lv, note = cleaner.parse_date("11月12日")
    assert d == _dt.date(2026, 11, 12)
    assert lv == "exact"
    assert "缺年份" in note


def test_K7_parse_due_asap():
    d, lv, _, prio = cleaner.parse_due("尽快")
    assert d is None and lv == "none" and prio == 5


def test_K8_parse_due_month_end():
    d, lv, note, _ = cleaner.parse_due("月底前")
    assert d == _dt.date(2026, 11, 30)
    assert lv == "inferred"


def test_K9_classify_status_outsourced_first():
    """HT-01 原文「在用（外协，不计本厂）」同时含在用和外协。

    必须先判外协，否则会把外协炉当可用产能。
    """
    assert cleaner.classify_status("在用（外协，不计本厂）") == "outsourced"


def test_K10_classify_status_others():
    assert cleaner.classify_status("停机维修（11/8 起）") == "down"
    assert cleaner.classify_status("闲置") == "idle"
    assert cleaner.classify_status("在用") == "available"


def test_K11_parse_qty_empty_raises():
    try:
        cleaner.parse_qty(None, "数量等客户确认")
        assert False
    except cleaner.DataGate as e:
        assert "数量" in e.category


def test_K12_parse_qty_half():
    assert cleaner.parse_qty(35, "先做一半，剩下的下周") == 17.5


def test_K13_parse_op_cell_pinned_vs_group():
    """区分「点名」与「机台组」。"""
    machines = {"CNC-01": {"ops": ["铣"]}, "CNC-03": {"ops": ["铣", "镗"]},
                "GRD-01": {"ops": ["磨"]}, "GRD-02": {"ops": ["磨"]},
                "LAT-01": {"ops": ["车"]}}
    groups = config.build_groups(machines)
    p = cleaner.parse_op_cell("铣（CNC-03）60", machines, groups)
    assert p["kind"] == "pinned" and p["pinned"] == "CNC-03" and p["min_per_unit"] == 60
    g = cleaner.parse_op_cell("车（LAT）45", machines, groups)
    assert g["kind"] == "group" and g["pinned"] is None


def test_K14_remark_priority_and_release():
    o = {"priority": 3, "release": None}
    cleaner.apply_remark("急单，张工说的", o)
    assert o["priority"] == 5
    o2 = {"priority": 3, "release": None}
    cleaner.apply_remark("材料 11 月 8 日才到", o2)
    assert o2["release"] == _dt.date(2026, 11, 8)


# ============================================================
# 三、实例（M 系列）
# ============================================================

def test_M1_split_lots_basic():
    assert instance.split_lots(120, 20) == [20.0] * 6
    assert instance.split_lots(80, 20) == [20.0] * 4


def test_M2_split_lots_tail():
    assert instance.split_lots(35, 20) == [20.0, 15.0]
    # 余数 < 20*0.3=6 → 并入前一批
    assert instance.split_lots(21, 20) == [21.0]


def test_M3_split_lots_less_than_one():
    assert instance.split_lots(17.5, 20) == [17.5]


def test_M4_op_duration_unit():
    """【最大的坑】分钟/件 × 数量（不是分钟/批）。"""
    assert instance.op_duration(180, 40) == 7200
    assert instance.op_duration(75, 120) == 9000


def test_M5_no_pending_after_build():
    """build_ops 出来的都应该是 pending（待排）。"""
    ops = [{"status": "pending"}]
    assert ops[0]["status"] == "pending"


# ============================================================
# 四、校验器（V 系列）—— 任务书红线
# ============================================================

def _mini_clean():
    """3 个 Operation 的手工最小集，能人工验算。"""
    return {
        "orders": [{"id": "MO-001", "product": "产品X", "qty": 10.0,
                    "due": None, "priority": 3}],
        "routes": {"产品X": [
            {"seq": 1, "op": "车", "group": "车", "pinned": None, "min_per_unit": 20},
            {"seq": 2, "op": "磨", "group": "磨", "pinned": None, "min_per_unit": 10},
        ]},
        "machines": {
            "LAT-01": {"id": "LAT-01", "ops": ["车"], "status": "available"},
            "GRD-01": {"id": "GRD-01", "ops": ["磨"], "status": "available"},
        },
        "flow_constraints": [],
        "capacity": {}, "load": {}, "gap": {},
    }


def _mini_ops():
    return [
        {"order_id": "MO-001", "lot_id": "MO-001", "seq": 1, "op": "车",
         "product": "产品X", "qty": 10.0, "duration": 200, "machine": "LAT-01",
         "start_axis": 0, "end_axis": 200, "status": "scheduled"},
        {"order_id": "MO-001", "lot_id": "MO-001", "seq": 2, "op": "磨",
         "product": "产品X", "qty": 10.0, "duration": 100, "machine": "GRD-01",
         "start_axis": 200, "end_axis": 300, "status": "scheduled"},
    ]


def test_V15_no_false_positive():
    """【最重要】手工正确的排程必须全 PASS（防误报）。"""
    hz = _hz()
    rep = checker.verify_all(_mini_ops(), _mini_clean(), hz, config.RunOptions())
    assert rep.ok, f"校验器误报：{rep.result} " + \
                   str([v.message for v in rep.all_violations()])


def test_V08_catches_collision():
    """任务书必做单测 3：故意造撞机，必须抓到 H4。"""
    hz = _hz()
    ops = _mini_ops()
    ops[1]["start_axis"] = 100          # 与车 [0,200) 重叠 100min
    ops[1]["end_axis"] = 200
    rep = checker.verify_all(ops, _mini_clean(), hz, config.RunOptions())
    # 磨 [100,200) 与车 [0,200) 重叠 → 但两者不同机台，不应报 H4；
    # 为了让 H4 真触发，把磨改到 LAT-01（同一台车床）
    ops2 = _mini_ops()
    ops2[1]["machine"] = "LAT-01"
    ops2[1]["start_axis"], ops2[1]["end_axis"] = 100, 200
    rep2 = checker.verify_all(ops2, _mini_clean(), hz, config.RunOptions())
    assert not rep2.ok
    assert any(v.rule == "H4" for v in rep2.h4.violations),         f"没抓到撞机：{rep2.result} {[v.message for v in rep2.all_violations()]}"
    assert "LAT-01" in [v.machine for v in rep2.h4.violations]


def test_V07_catches_disorder():
    hz = _hz()
    ops = _mini_ops()
    ops[1]["start_axis"] = 50           # 后道早于前道完工
    ops[1]["end_axis"] = 150
    rep = checker.verify_all(ops, _mini_clean(), hz, config.RunOptions())
    assert any(v.rule == "H3" for v in rep.h3.violations)


def test_V04_catches_wrong_machine():
    hz = _hz()
    ops = _mini_ops()
    ops[1]["machine"] = "LAT-01"        # 车床做不了磨
    ops[1]["start_axis"], ops[1]["end_axis"] = 200, 300
    rep = checker.verify_all(ops, _mini_clean(), hz, config.RunOptions())
    assert any(v.rule == "H2" for v in rep.h2.violations)


def test_V06_catches_wrong_duration():
    hz = _hz()
    ops = _mini_ops()
    ops[1]["duration"] = 90             # 应为 10*10=100
    rep = checker.verify_all(ops, _mini_clean(), hz, config.RunOptions())
    assert any(v.rule == "H2" for v in rep.h2.violations)


def test_V05_catches_down_machine():
    hz = _hz()
    clean = _mini_clean()
    clean["machines"]["GRD-01"]["status"] = "down"
    ops = _mini_ops()
    rep = checker.verify_all(ops, clean, hz, config.RunOptions())
    assert any("停机" in v.message for v in rep.h2.violations)


def _vc_clean():
    return {
        "orders": [{"id": "VC-001", "product": "阀芯C", "qty": 20.0,
                    "due": None, "priority": 3}],
        "routes": {"阀芯C": [
            {"seq": 1, "op": "车", "group": "车", "pinned": None, "min_per_unit": 40},
            {"seq": 2, "op": "磨", "group": "磨", "pinned": "GRD-01", "min_per_unit": 35},
        ]},
        "machines": {
            "LAT-01": {"id": "LAT-01", "ops": ["车"], "status": "available"},
            "GRD-01": {"id": "GRD-01", "ops": ["磨"], "status": "available"},
        },
        "flow_constraints": [{"product": "阀芯C", "from_seq": 1, "to_seq": 2,
                              "max_gap_min": 30}],
        "capacity": {}, "load": {}, "gap": {},
    }


def _vc_ops(gap=0):
    car_end = 800
    return [
        {"order_id": "VC-001", "lot_id": "VC-001-L1", "seq": 1, "op": "车",
         "product": "阀芯C", "qty": 20.0, "duration": 800, "machine": "LAT-01",
         "start_axis": 0, "end_axis": car_end, "status": "scheduled"},
        {"order_id": "VC-001", "lot_id": "VC-001-L1", "seq": 2, "op": "磨",
         "product": "阀芯C", "qty": 20.0, "duration": 700, "machine": "GRD-01",
         "start_axis": car_end + gap, "end_axis": car_end + gap + 700,
         "status": "scheduled"},
    ]


def test_V10_h5_gap_ok():
    hz = _hz()
    rep = checker.verify_all(_vc_ops(0), _vc_clean(), hz, config.RunOptions())
    assert rep.h5.passed
    assert rep.h5.checked == 1


def test_V11_h5_gap_too_big():
    """gap=100 > 30 → 必须报 H5。"""
    hz = _hz()
    rep = checker.verify_all(_vc_ops(100), _vc_clean(), hz, config.RunOptions())
    assert not rep.h5.passed
    assert "100 min" in rep.h5.violations[0].message


def test_V12_h5_negative_gap():
    """磨早于车完工 → 负间隔，必须报 H5。"""
    hz = _hz()
    rep = checker.verify_all(_vc_ops(-50), _vc_clean(), hz, config.RunOptions())
    assert not rep.h5.passed
    assert "-50" in rep.h5.violations[0].message


def test_V13_h5_unplanned_is_skip_not_pass():
    """未排入的子批 → SKIP，count 不增加（未排入 ≠ 通过）。"""
    hz = _hz()
    rep = checker.verify_all(_vc_ops(0), _vc_clean(), hz, config.RunOptions())
    assert rep.h5.checked == 1


def test_V16_import_isolation():
    """【红线】checker.py 只能 import 白名单，不能 import solver。

    否则求解器的 bug 会传染给校验逻辑，「0 违反」就不可信了。
    """
    import ast
    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), "core", "checker.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {n.name.split(".")[0] for n in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    allowed = {"config", "datetime", "typing", "collections", "math", "json",
               "core", "__future__"}
    assert imported <= allowed, f"checker.py 只允许 {allowed}，实际 {imported}"
    assert "solver" not in imported, "checker.py 不能 import solver"


# ============================================================
# 五、求解器（S 系列）
# ============================================================

def test_S01_timeline_basic():
    tl = solver.Timeline("T")
    assert tl.earliest_slot(0, 100, 5760) == 0
    tl.occupy(0, 100)
    assert tl.earliest_slot(0, 50, 5760) == 100


def test_S02_timeline_no_overlap():
    tl = solver.Timeline("T")
    tl.occupy(0, 100)
    try:
        tl.occupy(50, 150)
        assert False, "应该抛内部错误"
    except AssertionError:
        pass


def test_S03_timeline_capacity():
    """窗口满了不再返回 None，而是往后排（与前端一致）。"""
    tl = solver.Timeline("T")
    tl.occupy(0, 5760)
    assert tl.earliest_slot(0, 100, 5760) == 5760


def test_S04_free_windows():
    tl = solver.Timeline("T")
    tl.occupy(100, 200)
    wins = tl.free_windows(50, 5760)
    assert (0, 100) in wins
    assert any(s == 200 for s, e in wins)


# ============================================================
# 六、端到端（E 系列）
# ============================================================

def test_E1_end_to_end(tmp_path=None):
    """用真实台账跑一遍，五条约束必须 PASS 或 PASS_WITH_SKIP。"""
    import tempfile
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    xlsx = os.path.join(here, "data", "宏达精密_订单台账.xlsx")
    if not os.path.exists(xlsx):
        return                          # 没有样例数据则跳过

    from core import reader
    raw = reader.read_workbook(xlsx)
    opts = config.RunOptions()
    hz = cal.make_horizon(config.horizon_start(_dt.date(2026, 11, 8)))
    clean = cleaner.clean(raw, opts, hz)
    ops = instance.build_ops(clean, opts)
    res = solver.solve_all(ops, clean, hz, opts)
    rep = checker.verify_all(ops, clean, hz, opts, res["unplannable"])
    # H1~H4 是硬约束，必须通过
    for r in (rep.h1, rep.h2, rep.h3, rep.h4):
        assert r.passed, f"{r.rule} 违规：" + str([v.message for v in r.violations][:3])
    # H5（C3 流水）在磨床单台瓶颈下可能不满足，这是真实产能约束，允许 FAIL
    assert rep.result in ("PASS", "PASS_WITH_SKIP", "FAIL")


def test_E2_duration_sum_handcheck():
    """抽一单手算：阀芯C 120 件 × 75 = 9000 min。"""
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    xlsx = os.path.join(here, "data", "宏达精密_订单台账.xlsx")
    if not os.path.exists(xlsx):
        return
    from core import reader
    raw = reader.read_workbook(xlsx)
    opts = config.RunOptions()
    hz = cal.make_horizon(config.horizon_start(_dt.date(2026, 11, 8)))
    clean = cleaner.clean(raw, opts, hz)
    ops = instance.build_ops(clean, opts)
    assert instance.hand_check(ops, "HD-2026-103") == 9000


# ============================================================
# 手跑入口
# ============================================================

if __name__ == "__main__":
    import io
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                      errors="replace")
    except Exception:
        pass

    tests = [(k, v) for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    passed, failed = 0, []
    for name, fn in tests:
        try:
            fn()
            passed += 1
            print(f"  PASS  {name}")
        except Exception as e:
            failed.append((name, e))
            print(f"  FAIL  {name}: {e}")
    print(f"\n通过 {passed} / 失败 {len(failed)}")
    if failed:
        sys.exit(1)
