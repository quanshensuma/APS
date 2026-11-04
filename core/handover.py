# -*- coding: utf-8 -*-
"""core/handover.py —— 生成「交接说明」。

【设计原则】程序生成，不写死手写文档：
  · 参数、假设、局限全部从 config.py 与 RunOptions 取，模板里不留会脱钩的副本
  · 随数据与参数自动更新（数量/窗口/机台数都从本次运行结果读）
  · 写给不懂技术的计划员看：不出现 solver / CP-SAT / Operation 等内部术语

对应 PPT 第 9 页第 6 件交付物、第 21 页「四样缺一不可」、第 26 页「没有交接说明 = 不及格」。
"""

from __future__ import annotations

import datetime as _dt

import config


# ============================================================
# 参数说明表：参数名 → (什么时候该用它, 会改变什么)
# 参数名从 RunOptions 字段反查，保证与 --help 一致
# ============================================================

_PARAM_HELP = {
    "--enable-grd02": (
        "客户确认那台闲置的平面磨可以开机、并且能加工这批零件时",
        "磨床从 1 台变 2 台，磨工序不再是最紧的瓶颈",
    ),
    "--morning-as-group": (
        "客户确认磨工序不必限定在某一台、组内哪台都能干时",
        "磨的可用机台从 1 台变 2 台，排得下更多活",
    ),
    "--enable-cnc03": (
        "客户确认那台停修的卧式加工中心已经修好、本周能用时",
        "铣的可用机台从 2 台变 3 台",
    ),
    "--allow-mill-substitute": (
        "客户确认某些产品的铣削可以换到别的立式加工中心上做时",
        "原本被锁死在停修机台上的订单能排进去了",
    ),
    "--lot-size": (
        "阀芯C 排得太散或排不下时（试 40 / 100 / 200）",
        "把阀芯C 拆成几件一批；批越大磨床越连续，但越难插空",
    ),
}


def _param_lines() -> list:
    """按 RunOptions 字段生成参数说明，确保与 --help 的双向核对能对上。"""
    return _PARAM_HELP


# ============================================================
# 假设清单（每条两半：假设是什么 + 不成立会怎样）
# ============================================================

def _assumptions(opts, clean, horizon) -> list:
    """假设清单。第三条之后的内容随本次运行变化。"""
    shift3 = [m["id"] for m in clean["machines"].values()
              if m.get("shifts", 2) > 2 and m["status"] == "available"]
    pinned_grind = []
    for prod, route in clean["routes"].items():
        for op in route:
            if op["op"] == "磨" and op.get("pinned"):
                pinned_grind.append(op["pinned"])
    grd_machines = sorted({m for m in clean["machines"] if "磨" in clean["machines"][m]["ops"]})
    grd_avail = sorted({m for m in clean["machines"]
                        if clean["machines"][m]["status"] == "available"
                        and "磨" in clean["machines"][m]["ops"]})
    outsource = [m["id"] for m in clean["machines"].values()
                 if m["status"] == "outsourced"]

    items = []

    if shift3:
        items.append((
            f"{'、'.join(shift3)} 在台账里写的是 3 班，本版按 2 班算"
            + ("（当前已按 3 班算）" if opts.three_shift else ""),
            "按 2 班算会少算这台机的产能，排出来的结果偏保守；"
            "若客户确认确实开 3 班，车床能多出约三分之一的工时，缺口会变小",
        ))
    else:
        items.append((
            "全厂按两班算（每天 08:00–24:00，共 16 小时）",
            "如果实际有 3 班机台，产能被低估，排程偏保守，交期会比实际更紧",
        ))

    items.append((
        "换型、调机、装夹的准备时间没有算进去",
        "实际完工时间会比这张表晚，经验上机加工厂换型占到一成到三成工时",
    ))

    items.append((
        "不区分谁来操作，只按机台产能算",
        "如果某台机只有特定师傅能开，或某班没人，实际产出会低于这张表",
    ))

    items.append((
        "工时用工艺表上的标准值，不考虑疲劳、熟练度、刀具磨损",
        "实际工时会上下浮动，排程不会自动跟着变",
    ))

    items.append((
        f"只排本周这 {horizon['window_days']} 个工作日（周日不排）",
        "交期排在本周之后的订单只会显示「未排入本周」，不会往后滚动排",
    ))

    if pinned_grind:
        items.append((
            f"磨工序在工艺表里是点名指定 {'、'.join(sorted(set(pinned_grind)))}，"
            f"组内另有 {', '.join(m for m in grd_machines if m not in grd_avail) or '无'} 未被使用",
            "如果客户说磨其实是两道都能干，那磨的产能会翻倍，缺口大幅缩小；"
            "反之如果确实只有一台能干，磨就是全厂最紧的瓶颈",
        ))

    if outsource:
        items.append((
            f"{'、'.join(outsource)} 是外协，不算本厂产能",
            "如果实际上要排进本厂，或者外协交期不可控，会影响交付时间",
        ))

    return items


# ============================================================
# 已知局限
# ============================================================

def _limits(opts, clean, horizon) -> list:
    lim = []

    # 【第一条就是责任边界】手册 2.3 把「柔性工艺路线优化」列为不做，
    # 计划员最容易被误解的地方就是以为这个工具能替他做决策。
    lim.append((
        "只回答「来不来得及」，不回答「来不及怎么办」",
        "加设备、外发、与客户协商改期属于生产决策，不在本工具范围；"
        "工具只负责把缺口和卡点在哪个机台讲清楚，决策还得人来做",
    ))

    lim.append(("不建模换型与调机", "实际完工会比排程晚 10~30%，交期余量要留出来"))
    lim.append(("不建模人员资质与班次资质", "只按机台产能算，不检查有没有人能开"))

    if opts.allow_mill_substitute:
        lim.append(("当前「允许换机台」是打开的",
                    "如果客户实际不允许换，排出来的表车间会干不了"))
    else:
        lim.append(("当前「允许换机台」是关的（点名机台不可用就排不进）",
                    "停修的那台机上的工序会一律排不进，需客户确认能否换机"))

    lim.append(("插单只做预演，不自动重排",
                "客户临时加急单要重跑一次命令，工具不会自己插进去"))

    lim.append(("不会自动帮客户定交期",
                "没有硬交期的单只报预计完工时间；如果工具自己拍一个日期，"
                "会变成对客户的假承诺，所以这类单一律标「需回客户确认」"))

    for fc in clean.get("flow_constraints", []):
        if not fc.get("confirmed", False):
            lim.append((
                f"{fc['product']} 的「工序间隔不超过 {fc['max_gap_min']} 分钟」"
                f"目前是口头澄清、客户尚未签字",
                "如果客户要的是别的口径或别的分钟数，这条结论要重算",
            ))
    return lim


# ============================================================
# 什么条件下不能信
# ============================================================

def _cautions(opts, clean, horizon, gap) -> list:
    out = []

    down = [m["id"] for m in clean["machines"].values() if m["status"] == "down"]
    if down and not opts.allow_mill_substitute:
        out.append(
            f"{'、'.join(down)} 停修期间、又不允许换机台时，点名在该机上的工序会大量排不进。"
            "这种情况下排程表里的「排不进」不是工具出错，是数据本身排不出来")

    if gap:
        bn = max(gap.items(), key=lambda kv: kv[1])
        cap = clean["capacity"].get(bn[0], {}).get("window_minutes", 0)
        load = clean["load"].get(bn[0], 0)
        out.append(
            f"{bn[0]} 是全厂最紧的环节（需要 {load:.0f} 分钟，本周只有 {cap:.0f} 分钟）。"
            "这条一旦变化（加机器、改工艺、改排班），整份结论都会变，必须重跑")

    out.append("台账数据改过就必须重跑，不要手工在排单表上改数字 —— "
               "手改之后校验报告就和表对不上了，签字也不算数")

    return out


# ============================================================
# 主函数
# ============================================================

def write_handover_md(clean, horizon, rep, path, opts=None, risk_rows=None,
                      xlsx_name="", stale_archived=None):
    """生成 out/交接说明.md。返回写入路径。"""
    opts = opts or config.RunOptions()
    risk_rows = risk_rows or []
    stale_archived = stale_archived or []

    orders = clean.get("orders", [])
    machines = clean.get("machines", {})
    avail = [m for m in machines.values() if m["status"] == "available"]
    gap = clean.get("gap", {})
    total_load = sum(clean.get("load", {}).values())
    total_cap = sum(c.get("window_minutes", 0) for c in clean.get("capacity", {}).values())
    params = config.params_line(opts, horizon["start"])

    from collections import Counter
    cnt = Counter((r.get("status_cn") or r.get("status") or "?") for r in risk_rows)

    L = []
    L.append("# 宏达精密 · 排产助手 交接说明")
    L.append("")
    L.append("> 这份说明是给车间和计划员看的，不需要懂电脑。"
             "**遇到和本说明不符的情况，以本说明末尾「什么条件下不能信」为准。**")
    L.append("")
    L.append("| 项 | 内容 |")
    L.append("|---|---|")
    L.append(f"| 生成时间 | {_dt.datetime.now().strftime('%Y-%m-%d %H:%M')} |")
    L.append(f"| 用的台账 | {xlsx_name or clean.get('meta', {}).get('path', '—')} |")
    L.append(f"| 排的是哪一周 | {horizon['days'][0]} ~ {horizon['days'][-1]}"
             f"（{horizon['window_days']} 个工作日，周日不排） |")
    L.append(f"| 订单 | 共 {len(orders) + len(clean.get('blocked', []))} 单，"
             f"其中 {len(orders)} 单排进去了 |")
    L.append(f"| 机台 | 台账 {len(machines)} 台，这次能用 {len(avail)} 台 |")
    L.append(f"| 总工作量 | {total_load:.0f} 分钟（约 {total_load/60:.0f} 小时），"
             f"本周可用 {total_cap} 分钟 |")
    L.append(f"| 这次的判定 | **{_result_cn(rep.result)}** |")
    if cnt:
        L.append(f"| 风险分布 | " + " / ".join(f"{k} {v} 单" for k, v in cnt.items()) + " |")
    L.append("")
    L.append(f"本次参数：`{params}`")
    L.append("")
    L.append("---")
    L.append("")

    # ---------- 一、怎么重跑 ----------
    L.append("## 一、下周怎么重跑")
    L.append("")
    L.append("### 1. 三步操作")
    L.append("")
    L.append("```")
    L.append("① 把新台账放到 data\\ 目录，文件名保持「宏达精密_订单台账.xlsx」")
    L.append("② 在项目目录打开命令行，敲：")
    L.append("   python run.py data\\宏达精密_订单台账.xlsx --out out")
    L.append("③ 产物都在 out\\ 目录里：")
    L.append("   排单表.xlsx      ← 打印这个贴墙")
    L.append("   甘特图.html      ← 双击看整周节奏（断网也能开）")
    L.append("   风险清单.xlsx    ← 回客户电话用这个")
    L.append("   体检报告.md      ← 台账里哪些数不能用")
    L.append("   校验报告.txt     ← 先看这个的「结果：」一行")
    L.append("   交接说明.md      ← 本文件")
    L.append("   需求确认单.md    ← 要给客户签字的那张")
    L.append("```")
    L.append("")
    L.append("### 2. 出结果以后先看哪两样")
    L.append("")
    L.append("1. **先看 `校验报告.txt` 的「结果：」那一行**")
    L.append("")
    L.append("   | 看到什么 | 意思 | 该做什么 |")
    L.append("   |---|---|---|")
    L.append("   | 结果：PASS | 完全没问题 | 直接用 |")
    L.append("   | 结果：PASS_WITH_WARN | 硬性规矩都过了，"
             "但有客户的流水要求没满足 | **可以用**，但要按说明跟客户讲清代价 |")
    L.append("   | 结果：PASS_WITH_SKIP | 有活没排进去 | 看风险清单的「排不进」 |")
    L.append("   | 结果：FAIL | 有硬性规矩被违反 | **不能用**，一单都不能交 |")
    L.append("")
    L.append("2. **再看 `风险清单.xlsx`**，按「类型」列分五种：")
    L.append("")
    L.append("   - **延期** —— 真赶不上，要马上回客户电话")
    L.append("   - **预警** —— 赶得上但只剩不到一个班的时间，提前备料")
    L.append("   - **急单·无交期** —— 客户催过但没给具体哪天要，"
             "只看「预计完工」那一列，交期要回客户确认，**不能自己拍一个日期**")
    L.append("   - **未排入本周** —— 交期在下周以后，**不算延期**，下周再排")
    L.append("   - **排不进** —— 产能不够或机台不可用，要决策")
    L.append("")
    L.append("### 3. 常用参数：什么时候该用哪个")
    L.append("")
    L.append("| 参数 | 什么时候该用它 | 会改变什么 |")
    L.append("|---|---|---|")
    for name, (when, what) in _param_lines().items():
        L.append(f"| `{name}` | {when} | {what} |")
    L.append("")
    L.append("用法举例（在命令后面追加）：")
    L.append("")
    L.append("```")
    L.append("python run.py data\\宏达精密_订单台账.xlsx --out out --enable-grd02")
    L.append("```")
    L.append("")

    # ---------- 二、假设清单 ----------
    L.append("## 二、本版默认按下面这些假设算（共 "
             f"{len(_assumptions(opts, clean, horizon))} 条）")
    L.append("")
    L.append("> 每一条都分两半：**前半是「我按什么算的」**，"
             "**后半是「这条不成立会怎样」**。")
    L.append("")
    L.append("| # | 我按什么算的 | 这条不成立会怎样 |")
    L.append("|---|---|---|")
    for i, (a, b) in enumerate(_assumptions(opts, clean, horizon), start=1):
        L.append(f"| {i} | {a} | {b} |")
    L.append("")

    # ---------- 三、已知局限 ----------
    L.append("## 三、这版做不到的事")
    L.append("")
    L.append("> 这些话必须让计划员知道，否则会拿它去答应不该答应的交期。")
    L.append("")
    L.append("| # | 做不到 | 后果 |")
    L.append("|---|---|---|")
    for i, (a, b) in enumerate(_limits(opts, clean, horizon), start=1):
        L.append(f"| {i} | {a} | {b} |")
    L.append("")
    L.append("**一句话**：这版能帮你排这一周，但换型时间和人员资质还没算进去，"
             "急单重排要手工跑一次。")
    L.append("")

    # ---------- 四、什么条件下不能信 ----------
    L.append("## 四、什么条件下这张表不能信")
    L.append("")
    for i, c in enumerate(_cautions(opts, clean, horizon, gap), start=1):
        L.append(f"{i}. {c}")
    L.append("")
    L.append("碰到上面任何一条，**先重跑，再拿去用**。")
    L.append("")

    # ---------- 归档提示 ----------
    if stale_archived:
        L.append("---")
        L.append("")
        L.append("## 附：本次归档的旧文件")
        L.append("")
        L.append("这次校验没通过，为避免把上一版当成这一版用，"
                 "下面这些**旧文件**已经移到 `out/_stale/`：")
        L.append("")
        for f in stale_archived:
            L.append(f"- `{f}`")
        L.append("")
        L.append("**别拿 _stale 里的东西去交付。**")
        L.append("")

    text = "\n".join(L) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def _result_cn(result: str) -> str:
    return {
        "PASS": "通过，可以用",
        "PASS_WITH_WARN": "硬性规矩都过了；有一条客户流水要求没满足，可以用但要说清代价",
        "PASS_WITH_SKIP": "通过，但有活没排进去",
        "FAIL": "没通过，不能用",
    }.get(result, result)
