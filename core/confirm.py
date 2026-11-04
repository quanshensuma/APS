# -*- coding: utf-8 -*-
"""core/confirm.py —— 生成「需求确认单」。

对应 PPT 第 9 页第 1 件交付物、第 16 页「从 10 个必问问题里挑 5 个」。

【单一数据源】阀芯C 的间隔分钟数一律从 config.FLOW_CONSTRAINTS 读，
本文件不出现任何「30」这类字面副本，改 config 后重新生成即跟着变。

【给客户看】不出现代码文件名、函数名、内部术语。
"""

from __future__ import annotations

import datetime as _dt

import config


# ============================================================
# ① 我理解的三件事（取自 PPT 第 7 页客户原话）
# ============================================================

def _three_things(clean, horizon, risk_rows) -> list:
    blocked = len(clean.get("blocked", []))
    n_orders = len(clean.get("orders", [])) + blocked
    return [
        f"您要的是「这周每天每台机干什么」——不是一句大概什么时候能做完，"
        f"而是落到机台、班次、几点开始几点结束，车间照着就能干。"
        f"所以我们会给出排单表（可打印）和一张整周的节奏图。",
        f"您还要「哪几单要赶不上」——所以除了排程，我们还给一张风险清单，"
        f"每一条都写明卡在哪台机、卡在哪道工序，方便您回客户电话。",
        f"台账里有些数字现在还不能用（比如数量空着的、交期写着「尽快」的）。"
        f"这类我们不会替您猜，会单独列出来等您确认；"
        f"这次台账共 {n_orders} 单，能直接排的是 {len(clean.get('orders', []))} 单。",
    ]


def _not_wanted() -> list:
    return [
        "装一堆东西（只用一个现成的表格读写组件，其余全部自带）",
        "必须联网（全程在您办公室电脑本地跑，数据不出这台机器）",
        "按年付费（没有账号、没有订阅、没有到期时间）",
    ]


# ============================================================
# ③ 恰 5 个问答
# ============================================================

def _five_qa(clean, horizon, opts, gap) -> list:
    """返回 [(问题, 客户答复, 这个答复改变了什么判断)]。

    客户答复暂缺时写「待客户确认」，严禁编造。
    """
    machines = clean.get("machines", {})
    load = clean.get("load", {})
    cap = clean.get("capacity", {})

    # 挑出最紧的机台组，用来支撑问题与「改变什么」
    worst = None
    if gap:
        g, v = max(gap.items(), key=lambda kv: kv[1])
        if v > 0:
            worst = (g, clean["load"].get(g, 0), cap.get(g, {}).get("window_minutes", 0))

    down = [m["id"] for m in machines.values() if m["status"] == "down"]
    idle = [m["id"] for m in machines.values() if m["status"] == "idle"]
    shift3 = [m["id"] for m in machines.values() if m.get("shifts", 2) > 2]

    qa = []

    # Q1 时间原点
    qa.append((
        f"排产从哪天开始算？（我们按台账整理日的下一个周一 "
        f"{horizon['start']} 算）",
        "待客户确认",
        f"如果实际不是从 {horizon['start']} 开始，整周的日期要整体挪；"
        f"交期落在哪一天的判断也会跟着变。",
    ))

    # Q2 停机机台能否换机
    if down:
        qa.append((
            f"{'、'.join(down)} 这次停修，期间这些工序能不能换到同类的其他机台上做？",
            "待客户确认",
            "能换的话这些单就能排进去；不能换的话，点名在这些机台上的工序会一律"
            "进「排不进」，风险清单会明显变长——这是目前对结果影响最大的一条。",
        ))

    # Q3 磨床是否只有一台
    grind_all = [m for m in machines if "磨" in machines[m]["ops"]]
    grind_avail = [m for m in grind_all
                   if machines[m]["status"] == "available"]
    if len(grind_all) > len(grind_avail):
        unused = [m for m in grind_all if m not in grind_avail]
        qa.append((
            f"磨工序是不是只能用 {'、'.join(grind_avail)} 那一台？"
            f"（台账里另有 {'、'.join(unused)} 写着闲置/不参与）",
            "待客户确认",
            f"如果另一台也能分担，磨的可用时间直接翻倍；"
            f"如果确实只有一台，磨就是全厂最紧的地方。"
            + (f"（现在磨需要 {worst[1]:.0f} 分钟，本周只有 {worst[2]:.0f} 分钟）"
               if worst and worst[0] == "磨" else ""),
        ))

    # Q4 交期口径
    qa.append((
        f"交期按「当天 {config.DUE_HOUR}:00 之前做完」算，对吗？"
        f"还是按收工前（当天 {config.DAY_END_HOUR if config.DAY_END_HOUR < 24 else 24}:00）算？",
        "待客户确认",
        "按 17 点算比按收工前算严格，会把几单从「准时」变成「延期」；"
        "这个口径直接决定风险清单里有几单是红色。",
    ))

    # Q5 三班 / 口头写法的取整（挑一个最贴近本次数据的）
    if shift3:
        qa.append((
            f"{'、'.join(shift3)} 台账里写的是 3 班，这周是不是真的开 3 班？"
            f"（我们这版按 2 班算）",
            "待客户确认",
            "确认开 3 班，这台机的可用工时能多出约三分之一；"
            "按 2 班算是保守估计，排出来的结果会比实际更紧。",
        ))
    else:
        half = [o for o in clean.get("orders", [])
                if abs(float(o.get("qty", 0)) % 1) > config.EPS]
        if half:
            o = half[0]
            qa.append((
                f"{o['id']} 备注写「先做一半」，我们按 {o['qty']:g} 件算，对吗？",
                "待客户确认",
                "按一半算，这单本周的量就少一半；如果客户其实要整批，"
                "工时和交期都要重算。",
            ))
        else:
            qa.append((
                "交期写成「尽快」「月底前」的，能不能给出一个具体日期？",
                "待客户确认",
                "「尽快」我们按最高优先级排但算不出哪天必须完；"
                "「月底前」按当月末兜底。给出具体日期后，风险清单的「差几天」才有意义。",
            ))

    return qa[:5]


# ============================================================
# ④ 未确认事项
# ============================================================

def _unconfirmed(clean) -> list:
    """把 config 里 confirmed=False 的定量约束全列出来。"""
    out = []
    for fc in clean.get("flow_constraints", []):
        if fc.get("confirmed", False):
            continue
        prod = fc["product"]
        gap = fc["max_gap_min"]
        # 找出这条约束影响了多少订单/子批
        n_orders = len([o for o in clean.get("orders", []) if o["product"] == prod])
        out.append({
            "what": f"{prod} 的两道工序之间，间隔不能超过 {gap} 分钟",
            "value": gap,
            "product": prod,
            "source": fc.get("source", ""),
            "implemented": f"已按「前一道工序做完，到后一道工序开始，中间不超过 {gap} 分钟」实现，"
                           f"并在每次出结果时单独核对",
            "orders_affected": n_orders,
            "howto": f"确认后只要把分钟数改掉重新生成即可，"
                     f"不用改任何排程逻辑；确认要更严或更松都行",
        })
    return out


# ============================================================
# 主函数
# ============================================================

def write_confirm_md(clean, horizon, rep, path, opts=None, risk_rows=None,
                     xlsx_name=""):
    """生成 out/需求确认单.md（单页 A4）。返回路径。"""
    opts = opts or config.RunOptions()
    risk_rows = risk_rows or []
    gap = clean.get("gap", {})

    L = []
    L.append("# 宏达精密 · 需求确认单")
    L.append("")
    L.append(f"| 客户 | 常州宏达精密 | 日期 | {_dt.date.today()} |")
    L.append("|---|---|---|---|")
    L.append("")
    L.append("> 这张单子请您逐条过一遍。**哪一条理解错了，后面排出来的东西就全错了。**")
    L.append("")

    # ---------- ① 三件事 ----------
    L.append("## 一、我理解您要的三件事")
    L.append("")
    for i, t in enumerate(_three_things(clean, horizon, risk_rows), start=1):
        L.append(f"{i}. {t}")
    L.append("")

    # ---------- ② 不要的 ----------
    L.append("## 二、您明确说过不要的")
    L.append("")
    for t in _not_wanted():
        L.append(f"- {t}")
    L.append("")

    # ---------- ③ 五个问答 ----------
    qa = _five_qa(clean, horizon, opts, gap)
    L.append("## 三、我最想跟您确认的五件事")
    L.append("")
    L.append("> 「客户答复」一栏空着的，麻烦您补上；"
             "**我们不会自己填一个数糊过去。**")
    L.append("")
    L.append("| # | 问题 | 客户答复 | 这个答复会改变什么判断 |")
    L.append("|---|---|---|---|")
    for i, (q, a, c) in enumerate(qa, start=1):
        L.append(f"| {i} | {q} | {a} | {c} |")
    L.append("")

    # ---------- ④ 未确认事项 ----------
    unc = _unconfirmed(clean)
    L.append("## 四、有一条规定，我们按口头意思做了，但您还没签字")
    L.append("")
    if not unc:
        L.append("（无）")
        L.append("")
    else:
        for u in unc:
            L.append(f"**{u['what']}**")
            L.append("")
            L.append(f"- **当前按多少算：**{u['value']} 分钟")
            L.append(f"- **这条从哪来的：**{u['source']}（口头澄清，暂无书面确认）")
            L.append(f"- **已经怎么处理的：**{u['implemented']}，"
                     f"影响 {u['orders_affected']} 张订单")
            L.append(f"- **您确认之后改哪里：**{u['howto']}")
            L.append("")
            L.append("> 这条很要紧：它直接决定磨床那边的结论是"
                     "「一周做不完」还是「勉强做不完」。"
                     "如果您的意思不是这个分钟数，请直接划掉改写。")
            L.append("")

    # ---------- ⑤ 签字 ----------
    L.append("## 五、确认签字")
    L.append("")
    L.append("| 确认项 | 打勾 |")
    L.append("|---|---|")
    L.append("| 上面「三件事」理解正确 | ☐ |")
    L.append("| 五个问题的答复都填了 | ☐ |")
    L.append("| 第四节的分钟数（或改后的数）确认无误 | ☐ |")
    L.append("| 台账里数量空着的那几单，我们会另行补充 | ☐ |")
    L.append("")
    L.append("| 客户签字 | 日期 |")
    L.append("|---|---|")
    L.append("|  |  |")
    L.append("")
    L.append("---")
    L.append("")
    L.append(f"*本单由排产工具自动生成，日期 {horizon['start']} ~ {horizon['days'][-1]}，"
             f"共 {horizon['window_days']} 个工作日。*")

    text = "\n".join(L) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path
