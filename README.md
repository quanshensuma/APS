# 宏达精密 · 本地排产助手（简化版 APS）

给常州宏达精密做的本地排产工具。**纯本地运行，不联网，数据不上传。**

## 做什么

计划员每周一拿到台账（Excel 三个 sheet：订单 / 设备 / 工艺路线），
一条命令或一次点击，输出以下产物：

1. **排单表**（xlsx）—— 这周每天每台机干什么，能直接打印贴墙
2. **甘特图**（html）—— 单文件，双击打开，断网可用
3. **风险清单**（xlsx）—— 哪几单要赶不上、卡在哪台机
4. **体检报告**（md）—— 台账里哪些数不能用、为什么要问客户
5. **校验报告**（txt）—— 四条硬约束（H1~H4）逐条结果，外加客户流水条件（H5）的达成情况
6. **交接说明**（md）—— 假设、局限、下周怎么重跑，计划员自己能看
7. **需求确认单**（md）—— 我理解的三件事 + 待客户确认的口径（含未签字的流水间隔）

## 怎么跑

### 装依赖（只需一次）

```bash
python -m pip install openpyxl
```

Python 3.10+。唯一的外部依赖是 openpyxl。

### 前置：放台账

客户台账 **不在仓库里**（N1 红线：客户数据不进版本控制）。
需要手动从客户包复制到 `data/` 目录：

```bash
copy 宏达精密_订单台账.xlsx data\
```

### 一条命令

```bash
python run.py data\宏达精密_订单台账.xlsx --out out
```

输出在 `out/`：`排单表.xlsx`、`甘特图.html`、`风险清单.xlsx`、`体检报告.md`、`校验报告.txt`

### 常用参数

| 参数 | 说明 |
|---|---|
| `--enable-grd02` | 允许使用闲置磨床 GRD-02 |
| `--morning-as-group` | 把磨工序视为机台组（不点名 GRD-01） |
| `--enable-cnc03` | 假设 CNC-03 已修好 |
| `--allow-mill-substitute` | 允许阀体A 的铣削走其他立加 |
| `--three-shift` | 允许 LAT-03 三班（默认按两班） |
| `--lot-size N` | 阀芯C 子批大小（默认 20） |
| `--flow-interp a\|c` | 阀芯C 间隔口径（默认 a: 车完工→磨开工） |
| `--dry-run` | 只算不写文件 |
| `--dump-json` | 额外输出 clean.json / schedule.json |
| `--verbose` | 打印中间过程 |

### 看结果

```
1. 先看 out/校验报告.txt 的「结果：」那一行

   PASS            → 全部通过，直接用
   PASS_WITH_SKIP  → 有工序没排进去（多为停机/换机台限制），
                     排进去的都对，先看风险清单再下结论
   PASS_WITH_WARN  → 硬约束 0 违反，排程能用；但客户流水条件
                     （阀芯C 车→磨 ≤30min）没达成，须向客户说明代价
   FAIL            → 排程有硬伤（撞机/漏排/倒序），不要交付，看下面逐条

   一句话：只有 FAIL 不能用，其余三种都能用。

2. 再看 out/风险清单.xlsx（看「类型」列：延期/预警/未排入本周/排不进）
3. 最后打印 out/排单表.xlsx
```

> **「硬约束 0 违反」指哪四条？** 就是 PPT 第 12 页校验器要查的那四件事：
> ① 每道工序恰好一次 ② 机台与工时跟工艺一致 ③ 同订单工序不倒序 ④ 同一台机时间不重叠。
> H5（阀芯C 车→磨间隔 ≤30min）是客户口头澄清的附加条件，**不在 PPT 四条之内**，
> 单独报告、不影响交付判定。详见 [口径说明](docs/口径说明-H5.md)。

### 跑测试

```bash
python tests/test_core.py
```

46 条单测，覆盖日历换算、脏数据清洗、单位换算、四条硬约束、C3 流水条件。

## 目录说明

```
aps-scheduler/
├── config.py          常驻配置（班次、日历、交期口径、机台、工艺路线）
├── run.py             命令行入口（后端，出七件产物）
│
├── core/              排程核心（纯 Python，不依赖 web）
│   ├── workcal.py     轴分钟 ↔ 挂钟时刻（跳过夜间和周日）
│   ├── reader.py      读三个 sheet（按表头名定位列）
│   ├── cleaner.py     洗脏数据 + 体检记录 + 数据闸门
│   ├── instance.py    订单 → 工序任务（分钟/件 × 数量）
│   ├── checker.py     校验器（H1~H5，独立，不 import solver）
│   ├── solver.py      规则排程（FIFO/SPT/MWKR 取最好）+ C3 子批流水
│   ├── report.py      排单表/甘特图/风险清单/体检/校验
│   ├── confirm.py     需求确认单（PPT 第 9 页第 1 件交付物）
│   └── handover.py    交接说明（参数/假设/局限，随运行自动更新）
│
├── server/            本地服务（标准库 http.server，托管前端 + 3 个 API）
│   └── app.py         python server/app.py --port 8801
│
├── frontend/          纯浏览器前端（零依赖，可双击 index.html）
│   ├── index.html     页面骨架
│   ├── app.js         界面逻辑（不计算，数字都来自 engine.js）
│   ├── engine.js      纯 JS 排程引擎（与 core/ 口径对齐）
│   ├── style.css      样式
│   ├── xlsx-lite.js   纯前端 xlsx 解析
│   ├── datasource.js  数据源适配层（file:// 走本地引擎 / http 走后端 API）
│   └── test/          parity_check 一致性 + smoke 三件套冒烟
│
├── tests/             后端单测（test_core.py，46 条）
├── docs/              设计文档（N2）
├── data/              客户台账（.gitignore 排除）
└── out/               产物输出（.gitignore 排除）
```

## 开发约定

- 分支：`main` 为稳定线，日常在 `dev` 上开发
- 提交信息：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` + 一句话

## 数据红线

客户台账（`*.xlsx`、`data/` 下除 `.gitkeep` 外的内容）**不得提交**。
提交前用 `git status` 确认干净：

```bash
git ls-files | grep -Ei '\.(xlsx|xlsm|xls|csv)$'   # 期望无输出
```

## 已知限制

- 不建模换型/调机时间 → 实际完工会比排程晚 10~30%
- 不建模人员资质 → 假定人人能干所有机台
- 工时按工艺表标准值 → 不考虑效率波动
- **磨工序在台账里点名 GRD-01**（外圆磨），GRD-02（平面磨）默认用不上
- 只排本周（6 个工作日，周日不排）
- 插单只做预演，不自动重排

## 数据安全

客户台账是商业数据，**不提交进 Git**（见 `.gitignore`），**不上传任何服务器**。
整个过程纯本地，无任何网络请求。
