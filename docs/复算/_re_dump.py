# -*- coding: utf-8 -*-
"""重新通读 文件/ 目录全部输入：两个 docx + pptx + xlsx。
全部原样导出为 UTF-8 文本，不做任何加工或判断。"""
import io, os, sys
import docx
import openpyxl
from pptx import Presentation

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "_全量导出.txt")
buf = io.StringIO()

def dump_docx(path, label):
    buf.write("\n" + "#"*90 + "\n")
    buf.write(f"######## DOCX: {label}\n")
    buf.write("#"*90 + "\n")
    d = docx.Document(path)
    buf.write(f"[段落数 {len(d.paragraphs)}, 表格数 {len(d.tables)}, "
              f"节数 {len(d.sections)}]\n\n")
    # 按 body 顺序遍历，保留段落/表格相对位置
    from docx.oxml.ns import qn
    body = d.element.body
    p_idx, t_idx = 0, 0
    paras = d.paragraphs
    tables = d.tables
    for child in body.iterchildren():
        if child.tag == qn('w:p'):
            if p_idx < len(paras):
                p = paras[p_idx]
                txt = p.text
                style = p.style.name if p.style else ""
                if txt.strip():
                    buf.write(f"P[{style}] {txt}\n")
                p_idx += 1
        elif child.tag == qn('w:tbl'):
            if t_idx < len(tables):
                tbl = tables[t_idx]
                buf.write(f"\n--- 表格 {t_idx+1} ({len(tbl.rows)}行 x {len(tbl.columns)}列) ---\n")
                for r in tbl.rows:
                    cells = []
                    for c in r.cells:
                        cells.append(c.text.replace("\n", "\\n").strip())
                    buf.write("  | " + " | ".join(cells) + "\n")
                buf.write("\n")
                t_idx += 1

def dump_pptx(path, label):
    buf.write("\n" + "#"*90 + "\n")
    buf.write(f"######## PPTX: {label}\n")
    buf.write("#"*90 + "\n")
    prs = Presentation(path)
    buf.write(f"[幻灯片 {len(prs.slides)} 页]\n")
    for i, slide in enumerate(prs.slides, 1):
        buf.write(f"\n===== SLIDE {i} =====\n")
        for sh in slide.shapes:
            if sh.has_text_frame:
                for p in sh.text_frame.paragraphs:
                    t = "".join(r.text for r in p.runs)
                    if t.strip():
                        buf.write(f"  {t}\n")
            if sh.has_table:
                for r in sh.table.rows:
                    buf.write("  TBL| " + " | ".join(c.text.replace("\n"," ") for c in r.cells) + "\n")
        if slide.has_notes_slide:
            nt = slide.notes_slide.notes_text_frame.text
            if nt.strip():
                buf.write(f"  [备注] {nt}\n")

def dump_xlsx(path, label):
    buf.write("\n" + "#"*90 + "\n")
    buf.write(f"######## XLSX: {label}\n")
    buf.write("#"*90 + "\n")
    wb = openpyxl.load_workbook(path, data_only=True)
    for ws in wb.worksheets:
        buf.write(f"\n===== SHEET: {ws.title}  dims={ws.dimensions} "
                  f"rows={ws.max_row} cols={ws.max_column} =====\n")
        for ridx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            vals = ["" if v is None else str(v) for v in row]
            if any(v.strip() for v in vals):
                buf.write(f"r{ridx:>3} | " + " | ".join(vals) + "\n")
        if ws.merged_cells.ranges:
            buf.write(f"--- merged: {[str(m) for m in ws.merged_cells.ranges]}\n")

for fn, fn_dump in [
    ("APS工具开发任务书.docx", dump_docx),
    ("APS工具开发项目手册.docx", dump_docx),
    ("FDE项目_宏达精密排产助手_27页.pptx", dump_pptx),
    ("宏达精密_订单台账.xlsx", dump_xlsx),
]:
    p = os.path.join(HERE, fn)
    if os.path.exists(p):
        buf.write(f"\n\n% 文件: {fn}  大小={os.path.getsize(p)} 字节\n")
        fn_dump(p, fn)
    else:
        buf.write(f"\n\n!! 缺失: {fn}\n")

io.open(OUT, "w", encoding="utf-8", newline="\n").write(buf.getvalue())
print("WROTE", OUT, len(buf.getvalue()), "chars")
