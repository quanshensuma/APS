# -*- coding: utf-8 -*-
"""run.py —— 一条命令：python run.py data\\台账.xlsx --out out

流程：reader → cleaner → instance → checker(先就位) → solver → checker → report
退出码：0 成功；1 校验未过；2 参数错；3 数据错
"""

from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import sys

import config
from core import workcal as cal
from core import cleaner, checker, confirm, handover, instance, reader, report, solver


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="宏达精密 · 本地排产助手（简化版 APS）")
    ap.add_argument("xlsx", help="台账路径，例如 data\\宏达精密_订单台账.xlsx")
    ap.add_argument("--out", default="out", help="输出目录（默认 out）")
    # 设备与班次
    ap.add_argument("--enable-grd02", action="store_true",
                    help="允许使用闲置磨床 GRD-02")
    ap.add_argument("--morning-as-group", action="store_true",
                    help="把磨工序视为机台组（不点名 GRD-01）")
    ap.add_argument("--enable-cnc03", action="store_true",
                    help="假设 CNC-03 已修复")
    ap.add_argument("--allow-mill-substitute", action=argparse.BooleanOptionalAction,
                    default=config.RunOptions.allow_mill_substitute,
                    help="允许阀体A 的铣削走其他立加（CNC-01/02）。默认开（与前端一致），"
                         "用 --no-allow-mill-substitute 关闭")
    ap.add_argument("--three-shift", action="store_true",
                    help="允许 LAT-03 三班（默认按两班）")
    # C3
    ap.add_argument("--lot-size", type=int, default=config.DEFAULT_LOT_SIZE,
                    help=f"阀芯C 子批大小（默认 {config.DEFAULT_LOT_SIZE}）")
    ap.add_argument("--flow-interp", choices=["a", "c"],
                    default=config.DEFAULT_FLOW_INTERP,
                    help="C3 间隔口径：a=车完工→磨开工等待（默认）；c=完工之差")
    # 其他
    ap.add_argument("--origin", default=None,
                    help="排程原点日期 YYYY-MM-DD（默认取台账整理日之后最近的周一）")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--dry-run", action="store_true", help="只算不写文件")
    ap.add_argument("--dump-json", action="store_true", help="额外输出 clean.json / sched.json")

    a = ap.parse_args(argv)
    opts = config.RunOptions(
        enable_grd02=a.enable_grd02,
        morning_as_group=a.morning_as_group,
        enable_cnc03=a.enable_cnc03,
        allow_mill_substitute=a.allow_mill_substitute,
        three_shift=a.three_shift,
        lot_size=a.lot_size,
        flow_interp=a.flow_interp,
        out_dir=a.out,
        verbose=a.verbose,
    )
    return a.xlsx, opts, a


# ------------------------------------------------------------
# 排程原点
# ------------------------------------------------------------

def resolve_origin(raw, xlsx_path, argv_origin=None):
    """确定排程原点 = 台账整理日之后最近的周一。

    台账整理日在 A1：'宏达精密 · 待排产订单（计划员小李整理，2026-11-08）'
    """
    if argv_origin:
        return _dt.date.fromisoformat(argv_origin), "命令行 --origin"

    text = _read_a1_note(xlsx_path)
    import re
    m = re.search(r"(\d{4})[-/\.](\d{1,2})[-/\.](\d{1,2})", text or "")
    if m:
        ref = _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        return config.horizon_start(ref), f"台账整理日 {ref}（A1）→ 下一个周一"

    today = _dt.date.today()
    return config.horizon_start(today), f"未找到整理日，按今天 {today} 推"


def _read_a1_note(path):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(path, data_only=True)
        ws = wb["订单"] if "订单" in wb.sheetnames else wb.worksheets[0]
        v = ws["A1"].value
        return str(v) if v else ""
    except Exception:
        return ""


# ------------------------------------------------------------
# 主流程
# ------------------------------------------------------------

def main(argv=None) -> int:
    try:
        xlsx, opts, args = parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0

    t0 = _dt.datetime.now()

    # 1. 读
    STALE_TARGETS = ["排单表.xlsx", "甘特图.html", "风险清单.xlsx"]
    try:
        raw = reader.read_workbook(xlsx)
    except reader.APSError as e:
        msg = getattr(e, "message", str(e))
        print(f"[数据错误] {msg}", file=sys.stderr)
        if not args.dry_run:
            # 数据读不进来 = 本次一定出不了新表，旧表必须归档，否则会被当成新版贴墙
            moved = _early_abort_archive(opts.out_dir, STALE_TARGETS, msg)
            if moved:
                print(f"  旧产物已归档到 _stale/：" + "、".join(moved), file=sys.stderr)
        return 3

    if opts.verbose:
        print(reader.preview(raw, 3))

    # 2. 原点与窗口
    start, origin_reason = resolve_origin(raw, xlsx, args.origin)
    horizon = cal.make_horizon(start, opts.window_days)
    pline = config.params_line(opts, start)
    print(pline)
    if opts.verbose:
        print(f"  （原点依据：{origin_reason}）")

    # 3. 清洗
    clean = cleaner.clean(raw, opts, horizon)

    print(f"台账 {clean['meta'].get('rows_read','?')} 行 → "
          f"可排 {len(clean['orders'])} 单 / 闸门 {len(clean['blocked'])} 单 / "
          f"问题 {clean['meta']['issue_count']} 条（{len(clean['meta']['issue_categories'])} 类，"
          f"其中需问客户 {len(clean['meta']['need_ask_categories'])} 类）")

    if not clean["orders"]:
        print("[致命] 没有可排订单 —— 全部被闸门拦住，请看体检报告", file=sys.stderr)
        if not args.dry_run:
            _ensure_dir(opts.out_dir)
            report.write_health_md(clean, horizon,
                                   None, os.path.join(opts.out_dir, "体检报告.md"), opts)
            moved = _early_abort_archive(
                opts.out_dir, STALE_TARGETS, "全部订单被数据闸门拦住，本次未生成排程")
            if moved:
                print(f"  旧产物已归档到 _stale/：" + "、".join(moved), file=sys.stderr)
        return 3

    # 4. 实例
    ops = instance.build_ops(clean, opts)
    print(f"生成 Operation {len(ops)} 个"
          f"（阀芯C 按 {opts.lot_size} 件/批拆子批）")

    # 5. 排程（三种规则取最好）
    res = solver.solve_all(ops, clean, horizon, opts)
    sched = res["scheduled"]
    unplan = res["unplannable"]
    ev = res["eval"]

    print(f"排程完成 {len(sched)}/{len(ops)} 道工序，未排入 {len(unplan)} 项"
          f"（规则 {res['best_rule']}）")
    for r in res["all"]:
        print(f"    {r['rule']:<5} 未排入 {r['unplannable']:>2} | "
              f"延期 {r['eval']['delayed']:>2} | makespan {r['eval']['makespan_days']:>5} 天")

    # 6. 校验（全量 ops 传入，含 unplannable）
    rep = checker.verify_all(ops, clean, horizon, opts, unplan)

    print("\n校验结果：")
    for r in [rep.h1, rep.h2, rep.h3, rep.h4]:
        mark = "OK  " if r.passed else "FAIL"
        print(f"    {r.rule} {mark} 检查 {r.checked:>3} | 违规 {len(r.violations):>2} | "
              f"跳过 {len(r.skipped):>2}")
    r5 = rep.h5
    print(f"    H5 {'OK  ' if r5.passed else 'WARN'} 检查 {r5.checked:>3} | "
          f"违规 {len(r5.violations):>2} | 跳过 {len(r5.skipped):>2}   "
          f"[流水条件，非硬约束]")
    print(f"    → {rep.result}"
          + ("（硬约束 0 违反，排程可交付；H5 未达成须写进交接说明）"
             if rep.result == "PASS_WITH_WARN" else ""))

    # 7. 写文件
    _ensure_dir(opts.out_dir)
    txt = checker.format_report(
        rep, horizon, pline,
        {"generated_at": _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
         "source": os.path.basename(xlsx),
         "ops_total": len(ops), "ops_planned": len(sched)})

    if args.dry_run:
        print("\n--- 校验报告（dry-run，不写文件）---")
        print(txt)
        return 0 if rep.ok else 1

    paths = {}
    written, skipped, archived = [], [], []

    # 7.1 体检报告：无论过不过都出
    paths["体检报告.md"] = report.write_health_md(
        clean, horizon, rep, os.path.join(opts.out_dir, "体检报告.md"), opts, sched)
    written.append("体检报告.md")

    # 7.2 校验未过：把三件旧产物归档，绝不留在原地冒充新版
    if not rep.ok:
        archived = _archive_stale(opts.out_dir, STALE_TARGETS)
        skipped = list(STALE_TARGETS)
        txt += ("\n\n【产物状态】\n"
                "  本次校验未通过，排单表 / 甘特图 / 风险清单【未生成】。\n")
        if archived:
            txt += "  上一版旧文件已归档到 _stale/：" + "、".join(archived) + "\n"
            txt += "  请勿使用 _stale/ 里的文件交付。\n"
        else:
            txt += "  out/ 下没有残留的旧产物。\n"

    paths["校验报告.txt"] = _write_text(
        os.path.join(opts.out_dir, "校验报告.txt"), txt)
    written.append("校验报告.txt")

    # 7.3 三件排程产物：仅校验通过时写
    risk_rows = report.build_risk_rows(sched, clean, horizon, unplan)
    if rep.ok:
        paths["排单表.xlsx"] = report.write_schedule_xlsx(
            sched, clean, horizon, os.path.join(opts.out_dir, "排单表.xlsx"), opts)
        paths["甘特图.html"] = report.write_gantt_html(
            sched, clean, horizon, os.path.join(opts.out_dir, "甘特图.html"), risk_rows, opts)
        paths["风险清单.xlsx"] = report.write_risk_xlsx(
            risk_rows, horizon, os.path.join(opts.out_dir, "风险清单.xlsx"))
        written += STALE_TARGETS

    # 7.4 交接说明 + 需求确认单
    paths["交接说明.md"] = handover.write_handover_md(
        clean, horizon, rep, os.path.join(opts.out_dir, "交接说明.md"),
        opts, risk_rows, os.path.basename(xlsx), archived)
    written.append("交接说明.md")

    paths["需求确认单.md"] = confirm.write_confirm_md(
        clean, horizon, rep, os.path.join(opts.out_dir, "需求确认单.md"),
        opts, risk_rows, os.path.basename(xlsx))
    written.append("需求确认单.md")

    if args.dump_json:
        paths["clean.json"] = _dump_json(
            _jsonable(clean), os.path.join(opts.out_dir, "clean.json"))
        paths["schedule.json"] = _dump_json(
            _jsonable({"operations": sched, "unplannable": unplan,
                       "eval": ev, "best_rule": res["best_rule"]}),
            os.path.join(opts.out_dir, "schedule.json"))
        written += ["clean.json", "schedule.json"]

    elapsed = (_dt.datetime.now() - t0).total_seconds()

    # 7.5 打印清单：生成了哪几件、跳过哪几件、归档哪几件
    print(f"\n输出到 {opts.out_dir}/（{elapsed:.2f} 秒）：")
    print(f"  生成了 {len(written)} 件：")
    for k in written:
        print(f"    + {paths.get(k, k)}")
    if skipped:
        print(f"  跳过了 {len(skipped)} 件（校验未过）：")
        for k in skipped:
            print(f"    - {k}")
    if archived:
        print(f"  归档了 {len(archived)} 件旧文件 -> _stale/：")
        for k in archived:
            print(f"    ~ {os.path.join(opts.out_dir, '_stale', k)}")

    if risk_rows:
        from collections import Counter
        cnt = Counter(r["status_cn"] for r in risk_rows)
        print("\n风险摘要：" + " / ".join(f"{k} {v}" for k, v in cnt.items()))

    if not rep.ok:
        print("\n[校验未过] 排程三件未生成；结果见校验报告.txt", file=sys.stderr)
        return 1
    return 0


# ------------------------------------------------------------
# 工具
# ------------------------------------------------------------


def _early_abort_archive(out_dir, names, reason):
    """早期退出（数据读不进来 / 无可排订单）时归档旧产物，
    并写一份说明性的校验报告，保证 out/ 的结论与产物集合一致。"""
    if not os.path.isdir(out_dir):
        return []
    moved = _archive_stale(out_dir, names)
    lines = [
        "=" * 62,
        "排程校验报告",
        "生成时间：" + _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "=" * 62,
        "",
        "【产物状态】",
        "  本次运行在数据阶段就中止了，排单表 / 甘特图 / 风险清单【未生成】。",
        "  中止原因：" + reason,
        "",
    ]
    if moved:
        lines.append("  上一版旧文件已归档到 _stale/：" + "、".join(moved))
        lines.append("  请勿使用 _stale/ 里的文件交付。")
    else:
        lines.append("  out/ 下没有残留的旧产物。")
    lines += ["", "=" * 62, "结果：ABORTED（数据阶段中止）", "=" * 62]
    try:
        with open(os.path.join(out_dir, "校验报告.txt"), "w",
                  encoding="utf-8", newline="\n") as f:
            f.write("\n".join(lines) + "\n")
    except OSError:
        pass
    return moved


def _archive_stale(out_dir, names):
    """把指定的旧产物移到 out/_stale/，返回实际归档的文件名列表。

    【安全】绝不用通配符删除：
      · 只处理传入的精确文件名
      · 先打印绝对路径再动作
      · 目标已存在时加时间戳，不覆盖
      · 移动失败则退化为改名加 .stale 后缀，再失败就跳过并在报告里说明
    """
    stale_dir = os.path.join(out_dir, "_stale")
    moved = []
    for name in names:
        src = os.path.join(out_dir, name)
        if not os.path.isfile(src):
            continue
        abs_src = os.path.abspath(src)
        try:
            os.makedirs(stale_dir, exist_ok=True)
            dst = os.path.join(stale_dir, name)
            if os.path.exists(dst):
                stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
                stem, ext = os.path.splitext(name)
                dst = os.path.join(stale_dir, f"{stem}.{stamp}{ext}")
            print(f"  归档：{abs_src}  ->  {os.path.abspath(dst)}")
            os.replace(src, dst)
            moved.append(name)
        except OSError:
            try:
                alt = os.path.abspath(src + ".stale")
                print(f"  归档失败，改为加后缀：{abs_src}  ->  {alt}")
                os.replace(src, alt)
                moved.append(name + ".stale")
            except OSError as e:
                print(f"  跳过（无法归档）：{abs_src} -- {e}", file=sys.stderr)
    return moved


def _ensure_dir(d):
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)


def _write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return path


def _jsonable(obj):
    """递归转 JSON 可序列化（date/datetime/set）。"""
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, (_dt.datetime,)):
        return obj.strftime("%Y-%m-%dT%H:%M")
    if isinstance(obj, _dt.date):
        return obj.isoformat()
    if isinstance(obj, set):
        return sorted(obj)
    if isinstance(obj, float):
        return round(obj, 4)
    return obj


def _dump_json(obj, path):
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    return path


if __name__ == "__main__":
    if hasattr(sys.stdout, "buffer"):
        try:
            sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8",
                                          errors="replace")
        except Exception:
            pass
    sys.exit(main())
