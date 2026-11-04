# 附录 B · 模块设计与接口

> 对应节点 N4（25 分）+ N5（20 分）。
> 任务书表 8 要求六个模块，每个函数 **≤30 行**，**有中文注释**。
> 本附录给出每个模块的职责、函数签名、返回结构、异常、边界。

---

## B0. 全局约定

### B0.1 类型约定

```python
from datetime import date, datetime
from typing import Optional

# 时间：内存用「轴分钟」(int)，落盘用「挂钟时刻」(datetime)
AxisMin = int          # 0 = 2026-11-09 08:00；5759 = 2026-11-14 23:59
```

### B0.2 异常体系

```python
class APSError(Exception):
    """所有自定义异常的基类，带 error_code 供 API 层映射。"""
    code = "INTERNAL"

class NotXlsxError(APSError):      code = "NOT_XLSX"
class MissingSheetError(APSError): code = "MISSING_SHEET"
class HeaderMismatchError(APSError): code = "HEADER_MISMATCH"
class EmptyDataError(APSError):    code = "EMPTY_DATA"
class VerifyFailedError(APSError): code = "VERIFY_FAILED"

class DataGate(Exception):
    """数据不足，进闸门。这是【正常业务分支】，必须被捕获，不是崩溃。"""
    def __init__(self, row, locator, category, phenomenon, handling):
        ...

class Unplannable(Exception):
    """排不进（产能/H5 限制）。同样是正常分支，记录后继续。"""
```

**规则**：`DataGate` 和 `Unplannable` 必须被捕获并写入 JSON/报告；`APSException` 允许抛到 API 层转成中文提示。

### B0.3 函数长度约束

任务书要求「每个函数 ≤30 行，有中文注释」。**这是硬约束**，超了就拆。

```python
# 反面例子（35 行，超了）
# 正面：拆成 _parse_one / _parse_rest
```

---

## B1. `config.py` — 常驻配置

任务书 N4 与手册 §3.4 都要求参数分三类：

| 类型 | 例子 | 放哪 |
|---|---|---|
| 常驻配置 | 班次 8h、周六排周日不排、交期 17:00 | **`config.py`** |
| 可推导 | 本周起始日（取"最近的周一"） | 代码里算，**不要让客户填** |
| 真·每周变 | 哪台机停机、哪天到料 | **就写在设备表状态列 / 备注里** |

### B1.1 常量

```python
# config.py —— 常驻配置。改这里会影响所有运行，改动需记入交接说明。

# ---------- 日历 ----------
SHIFT_HOURS      = 8          # 单班小时数
SHIFTS_PER_DAY   = 2          # 每日班次数（全厂口径）
DAY_START_HOUR   = 8          # 每日开工时刻 08:00
DAY_END_HOUR     = 24         # 每日收工时刻 24:00（= 次日 00:00）
SKIP_WEEKDAYS    = (6,)       # 不排的星期（6 = 周日）
WINDOW_DAYS      = 6          # 一周窗口的工作日数（周一~周六）

SHIFT_MINUTES    = SHIFT_HOURS * 60            # 480
DAY_MINUTES      = SHIFTS_PER_DAY * SHIFT_MINUTES   # 960
WINDOW_MINUTES   = DAY_MINUTES * WINDOW_DAYS   # 5760（单台窗口容量）

# ---------- 交期口径 ----------
DUE_HOUR         = 17         # 交期默认时刻 17:00（手册 §3.4）
DUE_INFER_MONTH_END = True    # 「月底前」是否推断为当月末

# ---------- 数值 ----------
EPS              = 1e-6       # 浮点比较容差
AT_RISK_MINUTES  = SHIFT_MINUTES   # 余量不足一个班次 → 预警

# ---------- 排程 ----------
DEFAULT_LOT_SIZE = 20         # C3 子批大小（见附录 D）
DEFAULT_FLOW_INTERP = "a"     # C3 解读 a / c（见主文档 §5.1）
ALGO_CANDIDATES  = ("FIFO", "SPT", "MWKR")   # 三种规则都跑，取最好
```

### B1.2 可推导项（函数，不是常量）

```python
def horizon_start(ref_date: date) -> date:
    """取 ref_date 之后【最近的下一个周一】。
    注意：台账整理日 2026-11-08 是周日，下一个周一是 11-09。
    若用 date - timedelta(weekday()) 会得到 11-02，【整周错位】，这是坑。
    """
    days_ahead = (0 - ref_date.weekday()) % 7 or 7
    return ref_date + timedelta(days=days_ahead)
```

**必须有的单测**：`horizon_start(date(2026,11,8)) == date(2026,11,9)`；`horizon_start(date(2026,11,9)) == date(2026,11,16)`。

### B1.3 可运行时覆盖（CLI / API 参数）

```python
@dataclass
class RunOptions:
    """每次运行的参数。由 CLI 或 API 传入，不写死在 config。"""
    enable_grd02: bool = False      # Q1/Q6：是否允许用 GRD-02
    enable_cnc03: bool = False      # Q2：是否假设 CNC-03 已恢复
    three_shift: bool = False       # A1：是否允许 LAT-03 三班
    lot_size: int = DEFAULT_LOT_SIZE
    flow_interp: str = DEFAULT_FLOW_INTERP
    out_dir: str = "out"
```

---

## B2. `core/reader.py` — 读三个 sheet

**职责**：把 xlsx 读成原样的 dict，**不做任何清洗判断**。
**验收要点**（任务书 N4）：「能打印每列前 3 个值」。

### B2.1 函数

```python
def read_workbook(path: str) -> dict:
    """读台账，返回 {orders_raw, machines_raw, routes_raw, meta}。
    只做「取值」，不做「解释」。
    raise NotXlsxError / MissingSheetError
    """

def _check_ext_and_magic(path: str) -> None:
    """校验后缀 + ZIP 魔数（xlsx 是 zip，前 4 字节 PK\x03\x04）。
    防止把 .txt/.xls 改名成 .xlsx 混进来。
    """

def _find_header_row(ws, expected: tuple, max_scan: int = 5) -> int:
    """在前 5 行里找表头行（含 expected 全部字段名）。
    台账表头在第 2 行，但【不能写死 2】，因为换一份台账可能在第 1 或 3 行。
    raise HeaderMismatchError
    """

def _col_map(header: list, expected: tuple) -> dict:
    """按【表头名】建列索引映射，不按列序号。
    这是防「读错列」的关键：D 列是接单日期、E 列是交期，
    按索引读会把接单日期当交期，101 单会变成 11/03 到期。
    """

def _read_orders(ws, header_row: int) -> list[dict]:
    """读订单 sheet。每行保留行号（供 locator 用），跳过注释行。"""

def _skip_comment_row(row: list, id_val) -> bool:
    """判断是否是注释行。
    台账 r18 = 「注：交期一栏有的填了日期…」，它不是订单。
    判据：单号不是 HD 开头也不是纯数字 → 跳过并记 issue。
    """

def _read_machines(ws, header_row: int) -> list[dict]:
    """读设备 sheet。注意【按「编号」列判行数】，不按「设备号」
    —— 因为 HT-01 那行「设备号」是空的。
    """

def _read_routes(ws, header_row: int) -> list[dict]:
    """读工艺路线 sheet。工序列原文保留（"铣（CNC-03）60"），
    拆解交给 cleaner —— reader 不做解释。
    """
```

### B2.2 返回结构

```python
{
  "meta": {
    "path": "data/宏达精密_订单台账.xlsx",
    "sha256": "…",
    "sheet_names": ["订单","设备","工艺路线"],
    "header_rows": {"订单": 2, "设备": 2, "工艺路线": 2}
  },
  "orders_raw": [
    {"row": 3, "单号": "HD-2026-101", "客户": "客户甲",
     "接单日期": "2026/11/3", "交期": "2026-11-10",
     "产品": "阀体A", "数量": 40, "备注": ""}
  ],
  "machines_raw": [
    {"row": 3, "设备号": "M-01", "编号": "CNC-01",
     "型号": "立式加工中心 VMC850", "可做工序": "铣",
     "每日班次": "2 班", "状态": "在用"}
  ],
  "routes_raw": [
    {"row": 3, "产品": "阀体A",
     "工序1": "下料（SAW-01）20", "工序2": "车（LAT）45",
     "工序3": "铣（CNC-03）60", "工序4": "钻（DRL）30",
     "工序5": "磨（GRD-01）25", "单件工时合计": 180, "备注": "铣削目前指定 CNC-03"}
  ]
}
```

---

## B3. `core/cleaner.py` — 洗脏数据 + 体检记录

**职责**：把 `raw` 变成 `clean`，**每一个改动都记 issue**（任务书 N4：「逐条记 issues，每条都有"处理方式"」）。

### B3.1 主流程

```python
def clean(raw: dict, opts: RunOptions) -> dict:
    """返回 {orders, machines, routes, issues, blocked, capacity, load, gap}。
    顺序：先 machine（决定产能）→ 再 route（决定可行性）→ 最后 order（用前面两者判定）。
    """
```

**为什么这个顺序**：因为「阀体A 的铣点名 CNC-03，而 CNC-03 停机」这个判定，需要先知道机台状态、再知道路线、才能判订单。反过来会漏判。

### B3.2 函数清单

```python
# ---------- 单号 ----------
def norm_order_id(raw_id: str) -> tuple[str, list[str]]:
    """单号归一，返回 (归一后, 提示列表)。
    "HD-2026-101" → ("HD-2026-101", [])
    "HD2026102"   → ("HD-2026-102", ["单号缺连字符"])
    "104"         → ("HD-2026-104", ["单号仅数字，已补 HD-2026- 前缀"])
    无法识别 → raise DataGate
    """

# ---------- 日期 ----------
def parse_date(v) -> tuple[Optional[date], str, str]:
    """日期解析，返回 (date|None, level, note)。
    level ∈ {"exact","inferred","none"}
    处理四种格式：2026/11/3、2026-11-03、2026.11.4、11月12日
    【注意】openpyxl 读出的可能是 str 不是 datetime，不能只 isinstance 判断。
    """

def parse_due(v, ref_year: int) -> tuple[Optional[date], str, str, Optional[int]]:
    """交期解析，比 parse_date 多处理人话。
    "尽快"   → (None, "none", "无硬交期，按最高优先级", 5)
    "月底前" → (2026-11-30, "inferred", "按当月末推断", None)
    ""       → (None, "none", "交期空白", None)
    交期时刻按 config.DUE_HOUR = 17:00
    """

# ---------- 数量 ----------
def parse_qty(v, remark: str) -> float:
    """数量解析 + 备注规则应用。
    空白 → raise DataGate("数量空白")
    "先做一半" → v * 0.5
    """

# ---------- 备注规则 ----------
def apply_remark(remark: str, order: dict) -> list[str]:
    """备注 → 约束。返回提示列表。
    "急单，张工说的"      → priority = 5
    "客户催，越早越好"    → priority = 5
    "材料 11 月 8 日才到" → release = date(2026,11,8)
    "先做一半，剩下的下周" → qty *= 0.5
    "和李工确认过，和上批一起做" → batch_merge_hint
    """

# ---------- 设备 ----------
def classify_status(raw_status: str) -> str:
    """设备状态四态。
    【坑】HT-01 原文 = "在用（外协，不计本厂）"，同时含「在用」和「外协」。
    必须先判"外协"，再判"停机"，再判"闲置"，最后才是"在用"。
    顺序错了会把外协炉当成可用产能。
    """

def parse_shifts(raw: str) -> int:
    """提取班次数。 "2 班" → 2；"3 班" → 3。"""

def build_machines(raw_list: list, opts: RunOptions) -> tuple[dict, list[str]]:
    """建设备池。应用三处覆盖：
    - effective_shifts = min(shifts, 3 if opts.three_shift else 2)   ← A1
    - GRD-02: idle → available 若 opts.enable_grd02                   ← Q1
    - CNC-03: down → available 若 opts.enable_cnc03                   ← Q2
    """

# ---------- 工艺路线 ----------
def parse_op_cell(text: str, machines: dict) -> dict:
    """解析 "铣（CNC-03）60" → {op, ident, kind, group, min_per_unit}
    kind: "pinned"（ident 是机台编号） 或 "group"（ident 是组名）
    【关键】这是区分「点名」和「机台组」的唯一地方。
    """

def build_groups(machines: dict) -> dict[str, list[str]]:
    """从设备表「可做工序」反推机台组。
    铣 → [CNC-01, CNC-02, CNC-03]
    磨 → [GRD-01, GRD-02]     ← 注意：组里有两台，但工艺路线只点名 GRD-01
    """

def build_routes(raw_list: list, machines: dict, groups: dict) -> dict:
    """建工艺路线，并校验「单件工时合计」是否等于逐工序求和。
    【校验锚点】台账五个产品全部相等（180/90/75/95/65），
    若不等 → 记 issue 并警告（说明工艺表本身有问题）。
    """

# ---------- 订单 ----------
def build_orders(raw_list: list, routes: dict, machines: dict,
                 groups: dict, ref_year: int) -> tuple[list, list]:
    """建订单。返回 (ok_orders, blocked)。
    逐单判定：
    1. 数量空 → blocked（Q3）
    2. 单号无法解析 → blocked
    3. 产品不在工艺表 → blocked
    4. 路线里有 pinned 机台不可用 → blocked（A2/A3）
    """

def check_route_feasible(route: list, machines: dict) -> Optional[str]:
    """检查一条路线是否可排。返回不可排原因（None = 可排）。
    【关键】这是「磨全部点名 GRD-01」生效的地方：
    若 GRD-01 不可用，所有有磨工序的产品全拦。
    """

# ---------- 汇总 ----------
def calc_capacity(machines: dict, groups: dict, opts) -> dict:
    """算各组窗口容量。按 groups（组内所有机台）而不是按路线里点名的那台。
    这样能算出「名义容量」和「实际被点名限制后的可用容量」两个数，供体检报告对比。
    """

def calc_load(orders: list, routes: dict) -> dict:
    """算各组负荷。"""

def calc_gap(capacity: dict, load: dict) -> dict:
    """算缺口。gap = max(0, load - capacity)。"""
```

### B3.3 `issues` 结构（任务书要求「每条都有处理方式」）

```python
{
  "row": 12,                      # 台账行号
  "locator": "订单!F12",          # 单元格坐标
  "category": "数量空白",          # 类别（≥8 类）
  "severity": "block",            # block / warn / info
  "phenomenon": "数量为空，备注写「等客户确认」",
  "handling": "进闸门，不参与排程；需客户确认数量",
  "need_ask": True,               # 是否需要问客户（≥3 类）
  "changed": False                # 是否改动了数据
}
```

**任务书验收：「体检报告 ≥8 类，其中"要问客户"的 ≥3 类」。**
本设计实测 13 类（见主文档 §3），其中 `need_ask=True` 的 5 类。

---

## B4. `core/instance.py` — 订单 → 工序任务

**职责**：把订单展开成 Operation 列表。**任务书 N4 的验收要点是「抽一单手算，分钟数对得上」**。

### B4.1 函数

```python
def build_ops(orders: list, routes: dict, opts: RunOptions) -> list[dict]:
    """订单 × 路线 → Operation 列表。
    非 C3 产品：一单一个 lot（lot_id == order_id）
    C3 产品（有 flow_constraint 的）：按 opts.lot_size 拆子批
    """

def split_lots(qty: float, lot_size: int) -> list[float]:
    """拆子批。返回每批件数列表。
    qty=120, L=20 → [20]*6
    qty=80,  L=20 → [20]*4
    qty=35,  L=20 → [20, 15]
    qty=21,  L=20 → [21]        ← 余 1 件 < 20×0.3=6，并入前一批，避免碎批
    qty=17.5,L=20 → [17.5]      ← 不足一批
    """

def op_duration(min_per_unit: float, qty: float) -> int:
    """时长 = 单件工时 × 数量，四舍五入到整数分钟。
    【最大的坑】单位是「分钟/件」不是「分钟/批」。
    阀体A 40 件：180 × 40 = 7200 min（不是 180）。
    若当每批，总量差 30 倍，风险清单一条不报。
    """

def order_sort_key(order: dict) -> tuple:
    """排序键：(优先级降序, 交期升序, 数量降序, 单号)。
    交期为 None 的排在有交期之后（但要靠优先级拉前）。
    """
```

### B4.2 Operation 结构

```python
{
  "order_id": "HD-2026-103",
  "lot_id":   "HD-2026-103-L1",   # 非 C3 产品 == order_id
  "seq":      1,
  "op":       "车",
  "group":    "车",
  "pinned":   None,                # 点名时机台编号
  "qty":      20.0,
  "duration": 800,                 # = 40 × 20
  "product":  "阀芯C",
  # 排程后填充：
  "machine":  None,
  "start_axis": None,
  "end_axis":   None,
  "status":   "pending"            # pending / scheduled / unplannable
}
```

### B4.3 必须有的手算校验（任务书 N4 验收点）

```
HD-2026-101 阀体A 40 件
  下料 20 × 40 =   800 min
  车   45 × 40 = 1,800
  铣   60 × 40 = 2,400
  钻   30 × 40 = 1,200
  磨   25 × 40 = 1,000
  ─────────────────────
  合计          = 7,200 min = 120 机时
```

**单测断言**：`sum(op["duration"] for op in ops_of("HD-2026-101")) == 7200`。

---

## B5. `core/solver.py` — 规则排程

**职责**：`ops[]` + 机台池 → `sched[]`（每个 op 有 machine/start/end）。
**任务书 N4 要求**：「规则排程（FIFO/SPT/MWKR 取最好），每次都能出可行解」。

### B5.1 日历换算（手册 §3.4 ②「单独写」）

```python
def offset_to_dt(axis: int, origin: date) -> datetime:
    """轴分钟 → 挂钟时刻。
    axis 0     → 11-09 08:00
    axis 480   → 11-09 16:00
    axis 959   → 11-09 23:59
    axis 960   → 11-10 08:00      ← 跳过夜间 8 小时
    axis 5759  → 11-14 23:59
    【关键】不能 dt + timedelta(minutes=n)，会算进夜间和周日。
    """

def dt_to_offset(dt: datetime, origin: date) -> int:
    """挂钟时刻 → 轴分钟。反向。落在夜间/周日则 raise。"""

def advance(start_axis: int, duration: int) -> Optional[tuple[int,int]]:
    """从 start_axis 占用 duration 分钟，返回 (start, end) 或 None（容量不足）。
    【v1 简化】由于轴只含可用时间，end = start + duration 恒成立。
    保留循环版本作为未来扩展（若引入"每天24:00强制停机"）。
    """
```

### B5.2 三种规则

```python
def solve(ops: list, machines: dict, routes: dict, opts) -> dict:
    """跑三种规则，返回 {best: name, sched: [...], all_results: {...}}。
    任务书要求「取最好」，所以要跑三种比较。
    """

def solve_fifo(ops, machines) -> list:
    """FIFO：按交期先后排（Earliest Due Date）。"""

def solve_spt(ops, machines) -> list:
    """SPT：按加工时长升序排（Shortest Processing Time）。
    能压短平均流程时间，但可能拖长某些大单。"""

def solve_mwkr(ops, machines) -> list:
    """MWKR：按剩余工作量降序排（Most Work Remaining）。
    先干大活，避免大单最后卡死。"""

def pick_best(results: list) -> dict:
    """按 (延期单数, 总延期天数, makespan) 字典序取最优。"""
```

### B5.3 单次贪心（三种规则共用）

```python
def place_order(order_ops: list, timelines: dict, opts) -> bool:
    """逐工序选机台 + 定时间。返回是否排进。
    【延迟提交】先 staged 不 occupy，全部成功才提交 —— 避免回滚逻辑。
    """

def resolve_candidates(op: dict, machines: dict, groups: dict) -> list[str]:
    """候选机台。
    pinned 非空 → 只返回该机台（且必须 available）
    pinned 为空 → 返回该 group 下所有 available 机台
    """

def earliest_slot(timeline: list, after: int, duration: int) -> Optional[int]:
    """在已占用区间列表里找 >= after 的最早空位。"""
```

### B5.4 C3 流水子批（详见附录 D）

```python
def place_flow_order(order_ops: list, timelines: dict, fc: dict, opts) -> None:
    """阀芯C 专用：按 lot 逐个排，保证车完工→磨开工 ≤ max_gap。
    【磨床优先】先枚举磨床空闲窗口，再倒推车要在何时完工。
    理由：磨是瓶颈（GRD-01 单台承担 12,350 min），先占瓶颈资源。
    """
```

---

## B6. `web/app.py` — 本地服务（N5）

**任务书 N5 要求**：「用标准库 `http.server`，**不要 Flask**」。

### B6.1 函数

```python
def main(argv=None) -> int:
    """python web/app.py --port 8765"""

class Handler(BaseHTTPRequestHandler):
    """路由三个 API + 静态文件（index.html）。"""

    def do_GET(self):
        """/api/health、/api/download/<name>、/、/index.html"""

    def do_POST(self):
        """/api/generate（multipart/form-data）"""

def parse_multipart(rfile, boundary) -> dict:
    """手工解析 multipart。
    不用 cgi 模块（Python 3.13 已移除）。
    """

def json_response(handler, obj, status=200) -> None:
    """统一 JSON 响应，UTF-8，不转义中文。"""

def error_response(handler, err: APSError) -> None:
    """异常 → 中文提示 JSON。这是「传 txt 不白屏」的实现。"""

def content_disposition(filename: str) -> str:
    """中文文件名下载，用 RFC 5987 的 filename*。
    【坑】直接写 filename="排单表.xlsx" 会乱码，任务书 N5 明确点名。
    """
```

### B6.2 三个 API 契约

见附录 A §⑤（路径、入参、返回 JSON 示例已完整给出）。

### B6.3 异常处理映射

| 异常 | HTTP | error_code | 前端显示 |
|---|---|---|---|
| `NotXlsxError` | 400 | `NOT_XLSX` | 请上传 .xlsx 文件（当前不是 Excel 工作簿） |
| `MissingSheetError` | 400 | `MISSING_SHEET` | 缺少工作表「X」，请检查台账 |
| `HeaderMismatchError` | 400 | `HEADER_MISMATCH` | 第 N 行表头不对，应为「…」 |
| `EmptyDataError` | 400 | `EMPTY_DATA` | 台账里没有可识别的订单行 |
| `VerifyFailedError` | 400 | `VERIFY_FAILED` | 校验未通过（H4 撞机 2 处） |
| 其他 | 500 | `INTERNAL` | 内部错误，请把日志发给我们 |

**「传一个 txt 文件，页面给中文提示而不是白屏」**（任务书 N5 验收）→ 靠 `NotXlsxError` + `error_response`。

---

## B7. `core/report.py` — 四件产物

**任务书 N4 交付**：「排单表、甘特图、风险清单、体检报告」。

| 函数 | 产物 | 关键实现 |
|---|---|---|
| `write_schedule_xlsx(sched, path)` | `排单表.xlsx` | 列：日期/班次/机台/单号/工序/数量/开工/完工/工时；设 `print_area`，每机台一页 |
| `write_gantt_html(sched, path)` | `甘特图.html` | **单文件**，内联 CSS + 内联 JSON，**零外部引用**（断网可开） |
| `write_risk_xlsx(sched, clean, path)` | `风险清单.xlsx` | 列：单号/**类型**/交期/预计完工/差额/卡在哪台机/卡在哪工序/建议动作 |
| `write_health_md(clean, verify, path)` | `体检报告.md` | 13 类 issue + 闸门清单 + 复核跟踪表 + 负荷核算 |

### B7.1 风险清单的「类型」列（必须有）

| 类型 | 判据 | 是否算延期 |
|---|---|---|
| 延期 | 已排入且 `planned_end > due@17:00` | ✅ 是 |
| 预警 | 已排入且余量 < 1 个班次 | 否（提醒） |
| 未排入本周 | 未排入且交期在窗口后 | ❌ **否** |
| 排不进 | 受产能/H5 限制无法安排 | — （需决策） |

> **不做这个区分，会把 6 张交期在窗口外的单误报为延期**（106/106-R2/108/109/112/113）。

### B7.2 甘特图零外部引用（断网可开）

```python
def write_gantt_html(sched, path):
    """生成单文件 HTML。
    【硬要求】不能有 <link href="http...>、<script src="http...">、CDN 字体。
    用系统字体栈："Microsoft YaHei", sans-serif。
    """
```

单测：`assert "http" not in html_content`。

---

## B8. `run.py` — 一条命令（任务书 N4）

```python
def main(argv=None) -> int:
    """python run.py data\台账.xlsx --out out

    流程：reader → cleaner → instance → solver → checker → report
    退出码：0 成功；1 校验未过；2 参数错；3 数据错
    """

def parse_args(argv) -> RunOptions:
    """--xlsm/--xlsx 路径、--out、--enable-grd02、--enable-cnc03、
    --three-shift、--lot-size、--flow-interp、--scenario S1~S4
    """
```

**必须打印「本次参数」一行**（手册 §3.4：「每次输出必须打印一行"本次参数"，事后不扯皮」）：

```
本日 2026-11-04 | 原点 2026-11-09 | 两班8h | 周日不排 | 交期17:00 | 窗口6天
GRD02=off | CNC03=off | LAT03=2班 | lot=20 | C3=解读a
```

---

## B9. 模块依赖方向（禁止反向）

```
config ← calendar(在 solver 内)
   ↓
reader → cleaner → instance → solver → checker → report
                                      ↑
                                   （只读 JSON，
                                    不 import solver）
web/app.py → run.py 的 main()（复用，不重写逻辑）
```

**硬规则**：`checker.py` **只能** import `config`，不能 import `solver`。
否则求解器的 bug 会传染给校验逻辑，那时「0 违反」就不再可信 —— 这是任务书红线。

**CI 断言**：

```python
# tests/test_checker.py::test_import_isolation
import ast, io
tree = ast.parse(io.open("core/checker.py", encoding="utf-8").read())
imported = {n.name for node in ast.walk(tree)
            if isinstance(node, ast.Import) for n in node.names}
imported |= {node.module for node in ast.walk(tree)
             if isinstance(node, ast.ImportFrom)}
allowed = {"config", "datetime", "typing", "collections", "math"}
assert imported <= allowed, f"checker.py 只允许 import {allowed}，实际 {imported}"
```
