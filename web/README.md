# web/ —— 前端页面 + 本地服务（N5）

## 两种运行方式（都要能跑）

### A. 纯浏览器（零依赖，双击即用）

双击 `index.html`。不需要 Python、不需要起服务、不联网。
排程在浏览器里用 `engine.js` 完成。

> 需要 Chrome / Edge 104+（用到内置 `DecompressionStream` 解 xlsx）。

### B. 本地服务（任务书 N5 要求）

```bash
python web/app.py --port 8765
```

浏览器打开 http://127.0.0.1:8765

这时页面由服务托管，**排程由 Python 后端（core/）完成**，产物写到 `out/` 并可下载。

## 三个 API（任务书 N5）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 探活，返回版本/依赖 |
| POST | `/api/generate` | 上传 xlsx（multipart）+ options JSON → 返回排程结果 JSON |
| GET | `/api/download/<文件名>` | 下载产物（RFC 5987 中文名，不乱码） |

### POST /api/generate 示例

```bash
curl -X POST http://127.0.0.1:8765/api/generate \
     -F "file=@data/宏达精密_订单台账.xlsx" \
     -F 'options={"allowSwap":true,"enableGrd02":false,"lotSize":20}'
```

返回：`meta` / `metrics` / `schedule` / `risks` / `issues` / `capacity` / `verify` / `files`

### 错误码（全部中文提示，不白屏）

| error_code | 场景 |
|---|---|
| `NOT_XLSX` | 传了 .txt / .xls / 改了扩展名 |
| `MISSING_SHEET` | 缺「订单 / 设备 / 工艺路线」 |
| `HEADER_MISMATCH` | 表头被改名 |
| `EMPTY_DATA` | 只有表头没数据 |
| `NO_FILE` | 没选文件 |
| `NO_PLANNABLE` | 全部订单被闸门拦住 |
| `FILE_NOT_ALLOWED` | 下载白名单外（防目录穿越） |

## 文件清单

```
web/
├── index.html        页面骨架（无框架）
├── style.css         样式（#2c7be5 / #d9534f / #f0ad4e，A4 横向打印）
├── xlsx-lite.js      纯前端 xlsx 读取（ZIP + inflate-raw + XML，零依赖）
├── engine.js         排程引擎（纯 JS，Node 也能 require）
├── app.js            界面逻辑（只负责画）
├── app.py            本地服务（标准库 http.server，不用 Flask）
└── test/
    ├── engine_check.js   引擎自检 60+ 项
    ├── parity_check.js   ★ 前后端一致性对比（关键）
    ├── browser_check.js  Playwright 全流程
    └── print_check.js    导出 PDF 目检版式
```

## 前后端一致性（parity_check.js）

```bash
python web/app.py --port 8765 &
APS_PORT=8765 node web/test/parity_check.js
```

逐项比对两边的数字：订单数、窗口、五组负荷与缺口、总负荷、H1~H5、风险分类、体检类别。

**当前状态：全部一致。**

| 项 | 前端 | 后端 |
|---|---|---|
| 可排订单 | 13 | 13 |
| 总负荷 | 66,600 | 66,600 |
| 下料/车/铣/钻/磨 缺口 | 0/5220/4280/0/6590 | 0/5220/4280/0/6590 |
| H1~H4 | PASS | PASS |
| H5（C3 流水） | FAIL（10 子批） | FAIL（9 子批） |
| 延期单 | 4 | 4 |
| 未排入本周 | 6 | 6 |
| 排不进 | 1 | 1 |

> **H5 为什么两边都 FAIL**：磨工序全厂只有 GRD-01 一台（台账写「磨（GRD-01）」是点名），
> 磨负荷 12,350 min / 窗口 5,760 min，10 个阀芯C 子批抢 1 台磨，物理上排不进 30 分钟间隔。
> 这不是算法问题，是产能不足——**如实报出来才是对的**。
>
> 打开「允许用闲置磨床 GRD-02」后，磨缺口从 6,590 降到 830，页面上可直接对比。

## 口径（两边必须一致）

| 项 | 口径 |
|---|---|
| 原点 | 台账整理日 2026-11-08（周日）→ 最近周一 **2026-11-09** |
| 班次 | 两班 × 8h = 960 min/天（08:00–24:00），周日不排 |
| 窗口 | 本周 6 个工作日；容量 5,760 min/台 |
| 交期 | 当日 17:00；落在周日顺延到下一个工作日 |
| 工时 | **分钟/件 × 数量** |
| 排程范围 | 可向后扩展（本周排不完就排下周），不把整单判成"排不进" |
| 磨工序 | 台账点名 GRD-01 → 默认单台；GRD-02 默认不用 |
| 三班机台 | LAT-03 / HT-01 写 3 班 → 本周按两班算 |
| 外协 | HT-01 不计本厂产能 |
