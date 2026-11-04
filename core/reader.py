# -*- coding: utf-8 -*-
"""core/reader.py —— 读三个 sheet。

职责：把 xlsx 读成原样的 dict，【不做任何清洗判断】。
验收要点（任务书 N4）：「能打印每列前 3 个值」。

【关键设计】按【表头名】定位列，不按列序号。
台账 D 列是「接单日期」、E 列是「交期」。
若按索引读，会把接单日期当交期 → 101 单会变成 11/03 到期 → 排程直接崩。
"""

from __future__ import annotations

import zipfile
from typing import Optional

import openpyxl


REQUIRED_SHEETS = ("订单", "设备", "工艺路线")
EXPECTED_HEADERS = {
    "订单": ("单号", "客户", "接单日期", "交期", "产品", "数量", "备注"),
    "设备": ("设备号", "编号", "型号", "可做工序", "每日班次", "状态"),
    "工艺路线": ("产品", "工序1", "工序2", "工序3", "工序4", "工序5",
                "单件工时合计", "备注"),
}


class APSError(Exception):
    """所有自定义异常的基类，带 error_code 供 API 层映射。"""
    code = "INTERNAL"


class NotXlsxError(APSError):
    code = "NOT_XLSX"


class MissingSheetError(APSError):
    code = "MISSING_SHEET"


class HeaderMismatchError(APSError):
    code = "HEADER_MISMATCH"


class EmptyDataError(APSError):
    code = "EMPTY_DATA"


def _check_ext_and_magic(path: str) -> None:
    """校验后缀 + ZIP 魔数。xlsx 本质是 zip，前 4 字节必须是 PK\\x03\\x04。

    防止把 .txt / .xls 改名成 .xlsx 混进来。
    """
    if not path.lower().endswith(".xlsx"):
        raise NotXlsxError(
            "请上传 .xlsx 文件（当前文件扩展名不是 .xlsx）。"
            "如果文件是 .xls 或 .csv，请先用 Excel 另存为 .xlsx")
    try:
        with open(path, "rb") as f:
            magic = f.read(4)
    except OSError as e:
        raise NotXlsxError(f"无法打开文件：{e}")
    if magic != b"PK\x03\x04":
        raise NotXlsxError(
            "请上传 .xlsx 文件（当前文件内容不是 Excel 工作簿）。"
            "如果文件是 .xls 或 .csv，请先用 Excel 另存为 .xlsx")


def _find_header_row(ws, expected: tuple, max_scan: int = 5) -> int:
    """在前 max_scan 行里找表头行（该行含 expected 的全部字段名）。

    台账表头在第 2 行，但【不能写死 2】，因为换一份台账可能在第 1 或 3 行。
    """
    for r in range(1, min(max_scan, ws.max_row) + 1):
        vals = [str(c.value).strip() if c.value is not None else ""
                for c in ws[r]]
        if all(name in vals for name in expected):
            return r
    raise HeaderMismatchError(
        f"表头不对：在前 {max_scan} 行里没找到「{'/'.join(expected)}」。"
        f"请检查工作表「{ws.title}」的表头是否被改过。")


def _col_map(header_row_vals: list, expected: tuple) -> dict:
    """按表头名建列索引映射。返回 {字段名: 列索引}。"""
    idx = {}
    for i, v in enumerate(header_row_vals):
        if v is None:
            continue
        name = str(v).strip()
        if name in expected:
            idx[name] = i
    return idx


def _row_vals(ws, r: int, ncol: int) -> list:
    return [c.value for c in ws[r]][:ncol]


def _read_orders(ws, header_row: int, colmap: dict) -> tuple[list, list]:
    """读订单 sheet。每行保留行号（供 locator 用），跳过注释行。"""
    orders, skipped = [], []
    ncol = ws.max_column
    for r in range(header_row + 1, ws.max_row + 1):
        row = _row_vals(ws, r, ncol)
        if all(v is None or str(v).strip() == "" for v in row):
            continue                        # 全空行
        rec = {"row": r}
        for name, ci in colmap.items():
            rec[name] = row[ci] if ci < len(row) else None

        # 跳过注释行：单号既不是 HD 开头也不是纯数字
        id_raw = str(rec.get("单号") or "").strip()
        if not _looks_like_order_id(id_raw):
            skipped.append({
                "row": r,
                "raw": id_raw,
                "reason": "不是订单行（单号既非 HD 开头也非纯数字），按注释行跳过",
            })
            continue
        orders.append(rec)
    return orders, skipped


def _looks_like_order_id(s: str) -> bool:
    """单号是否像订单。

    能识别：HD-2026-101 / HD2026102 / 104 / hd-2026-111
    不能识别：空 / 「注：交期一栏有的填了日期…」
    """
    if not s:
        return False
    t = s.strip().upper()
    if t.isdigit():
        return True
    import re
    return bool(re.match(r"^HD[-_]?\d", t))


def _read_machines(ws, header_row: int, colmap: dict) -> list:
    """读设备 sheet。

    【关键】按「编号」列判行数，不按「设备号」
    —— 因为 HT-01 那行的「设备号」是空单元格，按设备号判会漏掉第 12 台。
    """
    machines = []
    ncol = ws.max_column
    for r in range(header_row + 1, ws.max_row + 1):
        row = _row_vals(ws, r, ncol)
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        rec = {"row": r}
        for name, ci in colmap.items():
            rec[name] = row[ci] if ci < len(row) else None
        if not str(rec.get("编号") or "").strip():
            continue
        machines.append(rec)
    return machines


def _read_routes(ws, header_row: int, colmap: dict) -> list:
    """读工艺路线 sheet。工序列原文保留（如 '铣（CNC-03）60'），
    拆解交给 cleaner —— reader 不做解释。
    """
    routes = []
    ncol = ws.max_column
    for r in range(header_row + 1, ws.max_row + 1):
        row = _row_vals(ws, r, ncol)
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        rec = {"row": r}
        for name, ci in colmap.items():
            rec[name] = row[ci] if ci < len(row) else None
        prod = str(rec.get("产品") or "").strip()
        # 只保留真正有工序的产品行（跳过 r9/r10/r11 的全局备注行）
        if not prod or not _looks_like_route_row(rec):
            continue
        routes.append(rec)
    return routes


def _looks_like_route_row(rec: dict) -> bool:
    """是否是产品工序行。

    r9/r10/r11 是全局备注（文本很长、产品列是长句子），
    判据：工序1 里能拆出「工序（机台）时长」格式。
    """
    raw = str(rec.get("工序1") or "").strip()
    import re
    return bool(re.match(r"^.+?（.+?）\s*\d+(?:\.\d+)?$", raw))


def read_workbook(path: str) -> dict:
    """读台账，返回 {orders_raw, machines_raw, routes_raw, routes_notes, skipped_rows, meta}。

    raise NotXlsxError / MissingSheetError / HeaderMismatchError / EmptyDataError
    """
    _check_ext_and_magic(path)

    try:
        wb = openpyxl.load_workbook(path, data_only=True)
    except Exception as e:
        raise NotXlsxError(f"无法读取 Excel：{e}")

    missing = [s for s in REQUIRED_SHEETS if s not in wb.sheetnames]
    if missing:
        raise MissingSheetError(
            f"缺少工作表「{'、'.join(missing)}」。"
            f"当前工作簿有：{'、'.join(wb.sheetnames)}。"
            "请检查台账是否完整（需要订单 / 设备 / 工艺路线 三个表）")

    header_rows, colmaps = {}, {}
    for name in REQUIRED_SHEETS:
        ws = wb[name]
        exp = EXPECTED_HEADERS[name]
        hr = _find_header_row(ws, exp)
        header_rows[name] = hr
        colmaps[name] = _col_map(
            [c.value for c in ws[hr]], exp)

    orders, skipped = _read_orders(wb["订单"], header_rows["订单"], colmaps["订单"])
    machines = _read_machines(wb["设备"], header_rows["设备"], colmaps["设备"])
    routes, route_notes = _read_routes_with_notes(
        wb["工艺路线"], header_rows["工艺路线"], colmaps["工艺路线"])

    if not orders:
        raise EmptyDataError("台账里没有可识别的订单行（单号列全空或全是注释）")

    return {
        "orders_raw": orders,
        "machines_raw": machines,
        "routes_raw": routes,
        "route_notes": route_notes,
        "skipped_rows": skipped,
        "meta": {
            "path": path,
            "sheet_names": list(wb.sheetnames),
            "header_rows": header_rows,
            "rows_read": len(orders) + len(skipped),
            "orders_raw_count": len(orders),
        },
    }


def _read_routes_with_notes(ws, header_row: int, colmap: dict) -> tuple[list, list]:
    """读工艺路线，同时把 r9/r10/r11 这类全局备注行收集起来。

    这些备注里有客户的口头规则，是 C3 约束的来源，不能丢。
    """
    routes, notes = [], []
    ncol = ws.max_column
    for r in range(header_row + 1, ws.max_row + 1):
        row = _row_vals(ws, r, ncol)
        if all(v is None or str(v).strip() == "" for v in row):
            continue
        rec = {"row": r}
        for name, ci in colmap.items():
            rec[name] = row[ci] if ci < len(row) else None
        prod = str(rec.get("产品") or "").strip()
        if _looks_like_route_row(rec):
            routes.append(rec)
        elif prod:
            notes.append({"row": r, "text": prod})
    return routes, notes


def preview(raw: dict, n: int = 3) -> str:
    """打印每列前 n 个值（任务书 N4 验收点「能打印每列前 3 个值」）。"""
    lines = []
    for key, label in [("orders_raw", "订单"),
                       ("machines_raw", "设备"),
                       ("routes_raw", "工艺路线")]:
        rows = raw[key]
        lines.append(f"\n=== {label}（{len(rows)} 行）===")
        if not rows:
            lines.append("  （空）")
            continue
        cols = [k for k in rows[0].keys() if k != "row"]
        for c in cols:
            vals = [str(r.get(c)) for r in rows[:n]]
            lines.append(f"  {c:<8}: " + " | ".join(vals))
    if raw["skipped_rows"]:
        lines.append(f"\n=== 跳过的行（{len(raw['skipped_rows'])}）===")
        for s in raw["skipped_rows"]:
            lines.append(f"  r{s['row']}: {s['raw'][:40]}… → {s['reason']}")
    return "\n".join(lines)
