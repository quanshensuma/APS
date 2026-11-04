# 附录 C · 校验器规格（`core/checker.py`）

> 对应节点 N4（25 分）。**这是整个项目的地基，也是任务书的红线**：
>
> > 红线：**校验器让 AI 生成或判断 → N4 记 0 分——这是整个项目的地基**
>
> PPT 第 12 页：**「校验器的价值不在聪明，在于它每次都用同一把尺子。」**
> 手册 §3.4 ③：**「先写好四条硬约束，再写求解器。」**

---

## C0. 设计原则

### C0.1 三条不可违反的约束

| # | 原则 | 为什么 |
|---|---|---|
| 1 | **只 import `config`**，不 import `solver` / `instance` | 防止求解器的 bug 传染给校验逻辑 |
| 2 | **输入是 JSON**，不是内存对象 | 能独立重跑；能人工核对 |
| 3 | **纯函数，无副作用**，不写文件、不读 Excel | 同一输入必得同一输出 |

### C0.2 CI 强制断言（防红线）

```python
# tests/test_checker.py::test_import_isolation
import ast, io

def test_import_isolation():
    # 解析 AST 而非 import，避免循环依赖
    tree = ast.parse(io.open("core/checker.py", encoding="utf-8").read())
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {n.name.split(".")[0] for n in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])

    allowed = {"config", "datetime", "typing", "collections", "math", "json"}
    assert imported <= allowed, \
        f"checker.py 只允许 import {sorted(allowed)}，实际 {sorted(imported)}"
```

**这条断言必须过。** 任何人给 `checker.py` 加一句 `from core import solver`，测试立刻红。

### C0.3 函数长度

任务书要求「每个函数 ≤30 行」。校验器拆法：

| 函数 | 行数估计 | 职责 |
|---|---:|---|
| `verify_all` | ~25 | 串起来跑五条，组装报告 |
| `check_h1` | ~20 | 每道工序恰好一次 |
| `check_h2` | ~22 | 机台与工时与工艺一致 |
| `check_h3` | ~18 | 同订单工序不倒序 |
| `check_h4` | ~15 | 同机台不重叠 |
| `check_h5` | ~25 | C3 流水约束 |
| `_group_by` | ~6 | 分组工具 |
| `_fmt_violation` | ~8 | 报错措辞统一 |

---

## C1. 报告结构

```python
@dataclass
class Violation:
    rule: str           # "H1".."H5"
    order_id: str       # 或 "" （机台级违规）
    lot_id: str | None
    seq: int | None
    machine: str | None
    message: str        # 面向计划员的完整中文，见 §C3 措辞规范
    locator: str        # "HD-2026-101/seq3" 或 "GRD-01@axis[960,1260)"

@dataclass
class RuleResult:
    rule: str
    passed: bool
    checked_count: int          # 检查了多少个对象
    violations: list[Violation]
    skipped: list[str]          # 无法校验的对象（不参与 PASS 判定，但必须报告）

@dataclass
class VerifyReport:
    h1: RuleResult
    h2: RuleResult
    h3: RuleResult
    h4: RuleResult
    h5: RuleResult
    result: str                 # "PASS" | "PASS_WITH_SKIP" | "FAIL"
    def ok(self) -> bool: return self.result != "FAIL"
```

### C1.1 `result` 三态判定

```python
def decide_result(report) -> str:
    any_violation = any(r.violations for r in [h1,h2,h3,h4,h5])
    any_skip = any(r.skipped for r in [h1,h2,h3,h4,h5])

    if any_violation:
        return "FAIL"
    if any_skip:
        return "PASS_WITH_SKIP"     # 无违规但有无法校验的项
    return "PASS"
```

**为什么有 `PASS_WITH_SKIP`**：

未排入 ≠ 违规。若把「未排入」当 FAIL，会出现「永远交付不了」；若忽略它，风险清单会漏项。
所以单列一态：**允许交付，但报告必须显示「已校验 X / 未排入 Y」，且风险清单必须有对应条目**。

---

## C2. 五条约束的判定

### C2.1 H1 · 每道工序恰好一次

**约束**：每个（可排订单 × 路线的每个 seq）必须有且只有一条 Operation。

```python
def check_h1(sched: list, clean: dict) -> RuleResult:
    """期望集合 vs 实际集合，差集 = 漏排，重数 >1 = 重排。

    【关键】期望集合要按「可排订单」算，不含 blocked 的订单。
    若把 blocked 订单也算进去，会误报一堆「漏排」。
    """
    expected = set()
    for order in clean["orders"]:                 # 只含可排的
        route = clean["routes"][order["product"]]
        lots = order["lots"]                      # 非 C3 = [order_id]
        for lot in lots:
            for op in route:
                expected.add((order["id"], lot, op["seq"]))

    actual = Counter((o["order_id"], o["lot_id"], o["seq"]) for o in sched)

    violations, skipped = [], []
    for key in expected:
        n = actual.get(key, 0)
        if n == 0:
            violations.append(Violation(
                rule="H1", order_id=key[0], lot_id=key[1], seq=key[2],
                message=f"[H1] {key[0]} 工序{key[2]} 出现 0 次 —— 漏排",
                locator=f"{key[0]}/{key[2]}"))
        elif n > 1:
            violations.append(Violation(
                rule="H1", order_id=key[0], lot_id=key[1], seq=key[2],
                message=f"[H1] {key[0]} 工序{key[2]} 出现 {n} 次 —— 重排",
                locator=f"{key[0]}/{key[2]}"))

    # 反向：多出来的（不在期望集合里）
    for key, n in actual.items():
        if key not in expected:
            violations.append(Violation(
                rule="H1", order_id=key[0], lot_id=key[1], seq=key[2],
                message=f"[H1] {key[0]} 工序{key[2]} 不在工艺路线中 —— 多排",
                locator=f"{key[0]}/{key[2]}"))

    return RuleResult("H1", not violations, len(expected), violations, skipped)
```

**注意**：漏排的 Operation 可能被标成 `unplannable`（排不进）。这时**仍是 H1 违规吗？**

| 情况 | 判定 |
|---|---|
| Operation 完全不存在于 `sched` | **H1 违规**（漏排） |
| Operation 存在但 `status=unplannable` | **不算 H1 违规**，但要进 `unplannable` 清单 |
| Operation 存在但 `status=unplannable` 且无原因记录 | **算 H1 违规**（程序 bug） |

**规格**：`sched` 里必须有 `unplannable` 数组，承载排不进的操作。`check_h1` 把 `unplannable` 里的也计入"存在"，但单独报告。

### C2.2 H2 · 机台与工时与工艺一致

**约束**：三件事同时成立：

1. 该机台**能做这道工序**（组内 or 点名匹配）
2. 该机台**当前可用**（`status == available`）
3. `duration == round(min_per_unit × qty)`

```python
def check_h2(sched: list, clean: dict) -> RuleResult:
    """逐条检查三件事。"""
    violations = []
    for o in sched:
        route_op = _find_route_op(clean, o["order_id"], o["seq"])
        m = clean["machines"][o["machine"]]

        # ① 机台能做这道工序
        if not _machine_can_do(m, route_op, o):
            violations.append(...f"[H2] {o['order_id']} 工序{o['seq']}({o['op']}) "
                                  f"排在 {o['machine']}，该机做不了{o['op']}")
            continue

        # ② 机台可用
        if m["status"] != "available":
            violations.append(...f"[H2] {o['order_id']} 工序{o['seq']} "
                                  f"排在 {o['machine']}，该机状态为 {m['status']}")
            continue

        # ③ 工时正确
        expect = round(route_op["min_per_unit"] * o["qty"])
        if abs(o["duration"] - expect) > EPS:
            violations.append(...f"[H2] {o['order_id']} 工序{o['seq']} 工时 {o['duration']} "
                                  f"≠ {route_op['min_per_unit']}×{o['qty']}={expect}")
    return RuleResult("H2", not violations, len(sched), violations, [])

def _machine_can_do(m: dict, route_op: dict, o: dict) -> bool:
    """机台能否做这道工序。
    点名（pinned 非空）→ 机台编号必须等于 pinned
    组（pinned 为空）→ 机台的可做工序必须包含 route_op["op"]
    """
    if route_op["pinned"]:
        return m["id"] == route_op["pinned"]
    return route_op["op"] in m["ops"]
```

**H2 是抓「排到停机的机器上」的唯一手段**（PPT 第 24 页「忘了停机设备」）。

### C2.3 H3 · 同订单工序不倒序

**约束**：同一 `(order_id, lot_id)` 内，后道开工 ≥ 前道完工。

```python
def check_h3(sched: list) -> RuleResult:
    """按 (order, lot) 分组，按 seq 排序，相邻比较。"""
    violations = []
    grouped = _group_by(sched, key=lambda o: (o["order_id"], o["lot_id"]))

    for key, ops in grouped.items():
        ops_sorted = sorted(ops, key=lambda x: x["seq"])
        for prev, cur in zip(ops_sorted, ops_sorted[1:]):
            if cur["start_axis"] < prev["end_axis"]:
                violations.append(Violation(
                    rule="H3", order_id=key[0], lot_id=key[1], seq=cur["seq"],
                    message=f"[H3] {key[0]} 工序{cur['seq']}({cur['op']}) 开工 "
                            f"{_fmt(cur['start_axis'])} 早于工序{prev['seq']} 完工 "
                            f"{_fmt(prev['end_axis'])} —— 前道没完就开后道",
                    locator=f"{key[0]}/{cur['seq']}"))

    return RuleResult("H3", not violations, len(grouped), violations, [])
```

**注意跨子批不检查**：不同 `lot_id` 之间无先后约束（子批可乱序排），这是 C3 设计的必然结果（见附录 D）。

### C2.4 H4 · 同一台机时间不重叠

**约束**：机台级，任意两个 Operation 的 `[start, end)` 不相交。

```python
def check_h4(sched: list) -> RuleResult:
    """按机台分组，按 start 排序，相邻比较。
    【数学依据】若存在区间重叠，排序后必有一对相邻区间重叠
    （区间图的性质），所以相邻比较足以发现所有违规。
    """
    violations = []
    grouped = _group_by(sched, key=lambda o: o["machine"])
    checked = 0

    for machine, ops in grouped.items():
        ops_sorted = sorted(ops, key=lambda x: x["start_axis"])
        checked += len(ops_sorted)
        for a, b in zip(ops_sorted, ops_sorted[1:]):
            if b["start_axis"] < a["end_axis"]:
                overlap_start = b["start_axis"]
                overlap_end = min(a["end_axis"], b["end_axis"])
                violations.append(Violation(
                    rule="H4", order_id=b["order_id"], lot_id=b.get("lot_id"),
                    seq=b["seq"], machine=machine,
                    message=f"[H4] {machine} 在 {_fmt(overlap_start)}–{_fmt(overlap_end)} "
                            f"有两个任务：{a['order_id']}/{a['lot_id']} 与 "
                            f"{b['order_id']}/{b['lot_id']} —— 同一台机两个活同时干",
                    locator=f"{machine}@[{a['start_axis']},{b['end_axis']})"))

    return RuleResult("H4", not violations, checked, violations, [])
```

**这是 PPT 第 12 页的第 ④ 条，也是客户电话里骂人的那件事**（「同一台机两个活同时干」）。

### C2.5 H5 · C3 流水约束（阀芯C 车→磨 ≤30 min）

**约束**：对每个 `flow_constraint`（产品/from_seq/to_seq/max_gap），同一子批内：

```
解读 a：0 ≤ start(to_seq) − end(from_seq) ≤ max_gap
解读 c：0 ≤ end(to_seq)   − end(from_seq) ≤ max_gap
```

```python
def check_h5(sched: list, clean: dict, opts) -> RuleResult:
    """逐 flow_constraint × 逐订单 × 逐子批校验。

    【关键】未排入的子批不能跳过不管，要进 skipped 列表。
    未排入 ≠ 通过。
    """
    violations, skipped = [], []
    checked = 0

    for fc in clean.get("flow_constraints", []):
        for order in clean["orders"]:
            if order["product"] != fc["product"]:
                continue

            for lot_id in order["lots"]:
                a = _find_op(sched, order["id"], lot_id, fc["from_seq"])
                b = _find_op(sched, order["id"], lot_id, fc["to_seq"])

                # 未排入 → skipped，不计通过
                if a is None or b is None:
                    skipped.append(
                        f"{lot_id} 未排入，无法校验流水约束（需 {fc['max_gap_min']}min 内接上）")
                    continue

                checked += 1
                if opts.flow_interp == "a":
                    gap = b["start_axis"] - a["end_axis"]
                    label = "车间隔"
                else:                                   # "c"
                    gap = b["end_axis"] - a["end_axis"]
                    label = "完工之差"

                if gap < 0:
                    violations.append(Violation(
                        rule="H5", order_id=order["id"], lot_id=lot_id, seq=fc["to_seq"],
                        message=f"[H5] {lot_id} {label} {gap} min < 0 "
                                f"（后道早于前道，逻辑错误）",
                        locator=f"{lot_id}/{fc['to_seq']}"))
                elif gap > fc["max_gap_min"]:
                    violations.append(Violation(
                        rule="H5", order_id=order["id"], lot_id=lot_id, seq=fc["to_seq"],
                        message=f"[H5] {lot_id} {label} {gap} min > {fc['max_gap_min']} "
                                f"—— 流水断档（客户要求阀芯C 两道工序间隔不超过 30 分钟）",
                        locator=f"{lot_id}/{fc['to_seq']}"))

    return RuleResult("H5", not violations, checked, violations, skipped)
```

#### C2.5.1 解读 (c) 的陷阱

若 `flow_interp == "c"`：

```
因磨 35 < 车 40，若磨紧接车开工（gap_a = 0），则 end(磨) = end(车) − 5
→ gap_c = −5 → 违反 H5
```

**所以解读 (c) 下，磨必须延后 5 分钟开工**才能满足。solver 的 `gap` 候选集要相应改为 `[30,25,20,15,10,5]`（去掉 0）。

**规格**：`solver.place_flow_order` 的 gap 候选集由 `opts.flow_interp` 决定。

#### C2.5.2 `SKIP` 的三种成因（报告要区分）

| 成因 | 报告措辞 | 风险清单类型 |
|---|---|---|
| 磨床无 ≤30min 窗口 | 「磨床无 L×35 空闲窗口」 | 排不进 |
| 车床无空闲 | 「车床无 L×40 空闲窗口」 | 排不进 |
| 订单在闸门（数量空等） | 「订单未进入排程」 | 待复核 |

---

## C3. 报错措辞规范

**要求**：面向计划员，说人话，能定位。**不要出现 `None`、`KeyError`、变量名。**

| 规则 | 模板 | 例子 |
|---|---|---|
| H1 漏排 | `[H1] {单号} 工序{seq}({工序}) 出现 0 次 —— 漏排` | `[H1] HD-2026-101 工序3(铣) 出现 0 次 —— 漏排` |
| H2 排错机器 | `[H2] {单号} 工序{seq}({工序}) 排在 {机台}，该机做不了{工序}` | `[H2] HD-2026-104 工序2(磨) 排在 CNC-01，该机做不了磨` |
| H2 停机 | `[H2] {单号} 工序{seq} 排在 {机台}，该机状态为停机维修` | |
| H3 倒序 | `[H3] {单号} 工序{seq}({工序}) 开工 {时刻} 早于工序{prev} 完工 {时刻} —— 前道没完就开后道` | |
| H4 撞机 | `[H4] {机台} 在 {起}–{止} 有两个任务：{A} 与 {B} —— 同一台机两个活同时干` | `[H4] GRD-01 在 11-09 14:00–16:00 有两个任务：HD-2026-103/L1 与 HD-2026-101 —— 同一台机两个活同时干` |
| H5 超限 | `[H5] {子批} 车间隔 {gap} min > 30 —— 流水断档（客户要求阀芯C 两道工序间隔不超过 30 分钟）` | |
| H5 负间隔 | `[H5] {子批} 车间隔 {gap} min < 0（后道早于前道，逻辑错误）` | |
| H5 跳过 | `[H5-SKIP] {子批} 未排入，无法校验流水约束` | |

**时间格式**：`MM-DD HH:MM`（如 `11-09 14:00`），不用轴分钟（计划员看不懂）。

---

## C4. 报告文本格式（`verify.txt`）

纯文本，**首行必须有口径标签，末行必须有结果标记**（供机器解析）。

```
══════════════════════════════════════════════════════
排程校验报告
生成时间：2026-11-04 15:32:10
数据源：宏达精密_订单台账.xlsx
本次参数：原点 2026-11-09 | 两班8h | 周日不排 | 交期17:00 | 窗口6天
         GRD02=off | CNC03=off | LAT03=2班 | lot=20 | C3=解读a
══════════════════════════════════════════════════════

【总览】
  Operation 已排 41 / 应排 49       子批已校验 7 / 应校验 10
  未排入 8 项（详见下方）

【逐条】
  H1 每道工序恰好一次         ✓  49/49
  H2 机台与工时一致           ✓  41 项
  H3 工序不倒序               ✓  9 组
  H4 同机台不重叠             ✓  9 台机
  H5 阀芯C 流水 ≤30min        ✗  2 项违规
      [H5] HD-2026-103-L2 车间隔 55 min > 30 —— 流水断档
      [H5] HD-2026-104-L1 车间隔 -5 min（后道早于前道，逻辑错误）
      [H5-SKIP] HD-2026-104-L4 未排入，无法校验流水约束

【未排入清单】
  HD-2026-104-L4   磨  原因：磨床无 700min 空闲窗口（GRD-01 已满）
  HD-2026-102      铣  原因：CNC-03 停机，工艺路线点名该机

══════════════════════════════════════════════════════
结果：FAIL
工程师签字：__________   日期：__________
══════════════════════════════════════════════════════
```

### C4.1 机器可解析标记

| 标记 | `run.py` 行为 |
|---|---|
| `结果：PASS` | 继续渲染 4 件产物，退出码 0 |
| `结果：PASS_WITH_SKIP` | **仍继续渲染**，但风险清单必须有「排不进」条目，退出码 0 |
| `结果：FAIL` | **拒绝渲染**，退出码 1 |

**规格**：`run.py` 里这一判断写在渲染之前，不允许"先渲染再校验"。

---

## C5. 必须先写的三个自测（手册 §3.4 ③）

**校验器写完后，在写 solver 之前，必须能通过这三个测试。**

### C5.1 测试 1：手工构造的正确排程必须 PASS（防误报）

```python
def test_checker_no_false_positive():
    """用 3 个 Operation 的手工正确排程，验证五条全过。

    产品X 10 件：工序1(车,20min/件) → 工序2(磨,10min/件)
    车 200min、磨 100min
    正确排程：车 [0,200) = 11-09 08:00–11:20
              磨 [200,300) = 11-09 11:20–13:20
    """
    sched = [
        {"order_id":"MO-001","lot_id":"MO-001","seq":1,"op":"车","group":"车",
         "machine":"LAT-01","qty":10,"duration":200,
         "start_axis":0,"end_axis":200,"status":"scheduled"},
        {"order_id":"MO-001","lot_id":"MO-001","seq":2,"op":"磨","group":"磨",
         "machine":"GRD-01","qty":10,"duration":100,
         "start_axis":200,"end_axis":300,"status":"scheduled"},
    ]
    report = verify_all(sched, clean_mini, opts)
    assert report.ok(), f"校验器误报：{report}"
```

**为什么这个最重要**：校验器误报的后果是**正确排程也交付不了**，比漏报更难发现。

### C5.2 测试 2：故意造撞机必须抓到

```python
def test_checker_catches_collision():
    """把磨改成 [100,200)，与车 [0,200) 重叠 100min。"""
    sched[1]["start_axis"] = 100
    sched[1]["end_axis"] = 200
    report = verify_all(sched, clean_mini, opts)
    assert not report.ok()
    assert any(v.rule == "H4" for v in report.h4.violations)
    assert "GRD-01" in report.h4.violations[0].machine
```

### C5.3 测试 3：C3 超限必须抓到

```python
def test_checker_catches_h5_violation():
    """阀芯C：车 end=800，磨 start=900 → gap=100 > 30。"""
    sched = [
        {"order_id":"VC-001","lot_id":"VC-001-L1","seq":1,"op":"车",
         "machine":"LAT-01","qty":20,"duration":800,
         "start_axis":0,"end_axis":800,"status":"scheduled"},
        {"order_id":"VC-001","lot_id":"VC-001-L1","seq":2,"op":"磨",
         "machine":"GRD-01","qty":20,"duration":700,
         "start_axis":900,"end_axis":1600,"status":"scheduled"},
    ]
    report = verify_all(sched, clean_vc, opts)
    assert any(v.rule == "H5" for v in report.h5.violations)
    assert "100 min" in report.h5.violations[0].message
```

---

## C6. 完整测试矩阵（V 系列，16 条）

| ID | 造出的问题 | 期望被抓 | 判据 |
|---|---|---|---|
| V01 | 删一个 Operation | H1 漏排 | `rule=="H1"`，消息含「漏排」 |
| V02 | 复制一个 Operation | H1 重排 | 消息含「重排」 |
| V03 | 加一个不存在的 seq | H1 多排 | 消息含「多排」 |
| V04 | 磨排到 CNC-01 | H2 排错机器 | `rule=="H2"` |
| V05 | 排到 CNC-03（停机） | H2 停机 | 消息含「停机」 |
| V06 | duration 改小 10% | H2 工时错 | 消息含「≠」 |
| V07 | seq2 早于 seq1 | H3 倒序 | `rule=="H3"` |
| V08 | 同机台重叠 1 min | H4 撞机 | `rule=="H4"` |
| V09 | 完全重叠 | H4 撞机 | 同上 |
| V10 | C3 gap=35 | H5 超限 | 消息含「> 30」 |
| V11 | C3 gap=-5 | H5 负间隔 | 消息含「< 0」 |
| V12 | C3 子批未排入 | H5-SKIP | `h5.skipped` 非空 |
| V13 | 全部合规 | 五项全 PASS | `result=="PASS"` |
| V14 | 有 skip 无违规 | `result=="PASS_WITH_SKIP"` | 相等 |
| V15 | **校验器自检**（手工正确排程） | 五项全 PASS | **防误报** |
| V16 | `checker.py` import 隔离 | 只 import 白名单 | AST 断言 |

> **V15 是最重要的一条**。V01~V14 测「抓得住错」，V15 测「不误报对」。

---

## C7. 与任务书验收的对照

| 任务书 N4 验收标准 | 本设计对应 |
|---|---|
| ☐ 校验器 0 违反 | C1.1 `result == "PASS"` |
| ☐ 故意造一个撞机，能抓出来 | C5.2 测试 2 + V08/V09 |
| 红线：校验器让 AI 生成或判断 → 0 分 | C0.1 三条原则 + C0.2 CI 断言 |
| PPT 第 25 页「校验器 0 违反（不撞机、不重不漏、不倒序）」 | H1/H3/H4 |
| PPT 第 12 页四件事 | H1(恰好一次) / H2(机台工时) / H3(不倒序) / H4(不重叠) |
| 客户 C3（阀芯C ≤30min） | **H5**（本设计要求增补，PPT 四条之外） |

> **H5 是 PPT 四条硬约束之外新增的第五条**，因为客户 2026-10-28 的澄清把工艺表备注「磨是瓶颈，别排太散」量化成了明确要求。
> 这条必须写进设计说明书，说明为什么不只是"四条"。
