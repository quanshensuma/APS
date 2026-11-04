# 附录 F · Git 与工程规范（N1）

> 对应节点 N1（10 分）。任务书要求：
> **目标：把项目放进版本控制，任何时候都能回到"上一次能跑"的状态。**
>
> 红线：**客户数据提交进 Git 仓库 → N1 记 0 分，并要求清理历史。**

---

## F0. N1 验收标准（任务书表 5）

| ☐ | 项 | 本文档对应 |
|---|---|---|
| ☐ | 提交 ≥3 次，信息能看懂 | §F4 提交规范 |
| ☐ | 客户 xlsx 不在仓库里（`git status` 干净） | §F2 `.gitignore` |
| ☐ | 现场演示：改坏一个文件 → `git restore` 撤销回来 | §F6 演示脚本 |
| ☐ | README 里能看懂怎么跑 | §F5 README 模板 |

---

## F1. 建仓步骤（任务书 N1 原文）

```bash
# 1. 建目录
mkdir aps-scheduler && cd aps-scheduler
git init

# 2. 写 .gitignore（必须先写，再 add）

# 3. 建 README.md 骨架

# 4. main 分支首次提交
git add .gitignore README.md
git commit -m "chore: 初始化仓库，加入 .gitignore 与 README 骨架"

# 5. 建 dev 分支，日常在 dev 上开发
git checkout -b dev
```

**顺序很重要**：`.gitignore` 必须**在第一次 `git add` 之前**就位。
否则客户 xlsx 进了一次历史，即使后来删掉，`git log` 里仍能翻出来 → 撞红线。

---

## F2. `.gitignore`（任务书记载的必须项 + 补充）

任务书 N1 原文要求必须排除：

```
__pycache__/
*.pyc
out/
.venv/
*.xlsx          ← 客户数据不进仓库
data/
```

**本项目的完整版**：

```gitignore
# ---------- Python ----------
__pycache__/
*.py[cod]
*$py.class
*.so
.venv/
venv/
env/
.pytest_cache/
.mypy_cache/
.coverage
htmlcov/

# ---------- 输出产物 ----------
out/
*.log
*.tmp
*.bak

# ---------- 客户数据（红线！） ----------
# 台账是客户商业数据，绝对不能进仓库
*.xlsx
*.xlsm
*.xls
*.csv
data/
!docs/samples/*.md      # 允许提交脱敏样例的说明，不允许提交原始数据

# ---------- 中间产物 ----------
*.json                  # clean.json / sched.json 是运行产物
!package.json
!package-lock.json

# ---------- IDE / OS ----------
.idea/
.vscode/
*.swp
.DS_Store
Thumbs.db

# ---------- 临时 ----------
~$*
```

### F2.1 为什么 `*.xlsx` 全排除而不是只排 `data/`

因为学生容易犯的错是「把台账随手放在项目根目录」。
**用扩展名全排除 + `data/` 双保险**，即使放错位置也进不去。

代价：如果确实需要提交一个模板 xlsx，必须显式 `git add -f`。**这是有意的摩擦**。

### F2.2 验证（每次提交前跑）

```bash
# 检查有没有 xlsx 被跟踪
git ls-files | grep -Ei '\.(xlsx|xlsm|xls|csv)$'
# 期望：无输出

# 检查 data/ 是否被忽略
git check-ignore -v data/宏达精密_订单台账.xlsx
# 期望：显示匹配的 .gitignore 规则

# 检查工作区是否干净
git status --short
# 期望：无 xlsx 相关条目
```

**CI 化**：把上面三条写进 `tests/test_git_hygiene.py`，每次跑测试都会检查。

---

## F3. 分支策略

任务书要求：**main 分支首次提交；再建 dev 分支，日常在 dev 上开发。**

```
main ──●─────────────────────●──────────────►  只放能跑的版本
        \                   /
dev      ●───●───●───●───●──●                  日常开发
             ↑   ↑   ↑   ↑
            N2  N3  N4  N5
```

| 分支 | 用途 | 规则 |
|---|---|---|
| `main` | 能跑的稳定版 | 只在节点验收通过时从 `dev` 合并 |
| `dev` | 日常开发 | 所有开发都在这里 |

**合并时机**：每个节点提交前，`git checkout main && git merge dev`。

**为什么不更复杂**（feature 分支 / Git Flow）：3 周单人项目，两分支足够。**过度设计是手册表 9 点名的翻车项。**

---

## F4. 提交规范

任务书原文：**`feat:` / `fix:` / `docs:` / `refactor:` / `test:` + 一句话**

### F4.1 类型前缀

| 前缀 | 用于 | 例子 |
|---|---|---|
| `feat:` | 新功能 | `feat: 增加体检报告输出` |
| `fix:` | 修 bug | `fix: 修正分钟/件被当成分钟/批的问题` |
| `docs:` | 文档 | `docs: 补充设计说明书的数据字典` |
| `refactor:` | 重构（不改行为） | `refactor: 拆分 cleaner 的单号归一函数` |
| `test:` | 测试 | `test: 增加校验器撞机用例` |
| `chore:` | 杂项（初始化/依赖） | `chore: 初始化仓库` |

### F4.2 本项目的建议提交序列（对应 6 个节点）

```
1  chore: 初始化仓库，加入 .gitignore 与 README 骨架          ← N1
2  docs: 完成产品设计开发说明书（七章节）                      ← N2
3  docs: 加入三张 UI 稿与交互说明                              ← N3
4  feat: 实现 reader 读取三个 sheet                            ← N4
5  feat: 实现 cleaner 清洗 13 类脏数据并记录体检                ← N4
6  feat: 实现 instance 订单转工序（分钟/件 × 数量）             ← N4
7  feat: 实现 checker 四条硬约束 + C3 流水约束                  ← N4（关键）
8  test: 增加校验器撞机与 H5 超限用例                           ← N4
9  feat: 实现 solver 三种规则排程（FIFO/SPT/MWKR）              ← N4
10 feat: 实现 report 输出四件产物                               ← N4
11 feat: run.py 一条命令跑通全流程                              ← N4
12 feat: web/app.py 本地服务 + 三个 API                         ← N5
13 feat: 前端单页，上传/生成/下载全流程打通                     ← N5
14 test: 客户台账实测，0 违反                                   ← N6
15 docs: 完成测试报告（缺陷清单 ≥5 条，修 ≥3 条）                ← N6
16 docs: 完成交接说明（假设与限制）                             ← N6
```

**共 16 次提交，远超"≥3 次"的要求。**
每次提交都小而完整，能单独回滚。

### F4.3 提交信息示例（任务书原文给的四个）

```
feat: 增加体检报告输出
fix: 修正分钟/件被当成分钟/批的问题
docs: 补充设计说明书的数据字典
test: 增加校验器撞机用例
```

### F4.4 常见坑（任务书原文）

> 常见坑：把几十 MB 的数据提交进去；提交信息全是 "update"；只有一个巨大提交。

| 坑 | 后果 | 防法 |
|---|---|---|
| 数据进库 | **撞红线，N1 记 0 分** | `.gitignore` + 提交前 `git ls-files` 检查 |
| `update` 满天飞 | 看不出改了什么，"能看懂"不达标 | 用 F4.1 的六种前缀 |
| 一个巨大提交 | 出问题无法回滚 | 按 F4.2 的 16 次拆 |

---

## F5. README 模板

任务书要求：**三段：做什么、怎么跑、目录说明**。

```markdown
# 宏达精密 · 本地排产助手（简化版 APS）

给常州宏达精密做的本地排产工具。纯本地运行，不联网，数据不上传。

## 做什么

计划员每周一拿到的台账（Excel 三个 sheet：订单/设备/工艺路线），
一条命令或一次点击，输出四件产物：

1. **排单表**（xlsx）—— 这周每天每台机干什么，能直接打印贴墙
2. **甘特图**（html）—— 单文件，双击打开，断网可用
3. **风险清单**（xlsx）—— 哪几单要赶不上、卡在哪台机
4. **数据体检报告**（md）—— 台账里哪些数不能用、为什么要问客户

## 怎么跑

### 装依赖（只需一次）

```bash
pip install openpyxl
```

Python 3.10+。唯一的外部依赖是 openpyxl。

### 命令行

```bash
python run.py data\宏达精密_订单台账.xlsx --out out
```

### 网页版

```bash
python web\app.py --port 8765
```

然后浏览器打开 http://127.0.0.1:8765

### 常用参数

| 参数 | 说明 |
|---|---|
| `--enable-grd02` | 允许使用闲置磨床 GRD-02 |
| `--enable-cnc03` | 假设 CNC-03 已修好 |
| `--three-shift` | 允许 LAT-03 三班 |
| `--lot-size N` | 阀芯C 子批大小（默认 20） |
| `--flow-interp a\|c` | 阀芯C 间隔口径（默认 a） |

### 看结果

```
1. 先看 out/校验报告.txt 第一行的「结果：」
   PASS / PASS_WITH_SKIP → 可以用
   FAIL                  → 有问题，看下面逐条
2. 再看 out/风险清单.xlsx
3. 最后打印 out/排单表.xlsx
```

## 目录说明

```
aps-scheduler/
├── config.py         常驻配置（班次、日历、交期口径）
├── run.py            命令行入口
├── core/             后端模块
│   ├── reader.py     读三个 sheet
│   ├── cleaner.py    洗脏数据 + 体检记录
│   ├── instance.py   订单 → 工序任务
│   ├── solver.py     规则排程
│   ├── checker.py    校验器（H1~H5）
│   └── report.py     四件产物
├── web/              网页版
├── tests/            单测
├── docs/             设计说明书 / UI 稿 / 测试报告
└── data/             放客户台账（不进 Git）
```

## 已知限制

- 不建模换型/调机时间 → 实际完工会比排程晚 10~30%
- 不建模人员资质 → 假定人人能干所有机台
- 工时按工艺表标准值 → 不考虑效率波动
- **磨工序在台账里点名 GRD-01**，所以 GRD-02（闲置）默认用不上
- 只排本周（6 个工作日，周日不排）
- 插单只做预演，不自动重排

## 数据安全

客户台账是商业数据，**不提交进 Git**（见 `.gitignore`），**不上传任何服务器**。
整个过程纯本地，无任何网络请求。
```

---

## F6. `git restore` 现场演示脚本（N1 验收点）

任务书要求：**☐ 现场演示：改坏一个文件 → `git restore` 撤销回来**

### F6.1 演示步骤（30 秒）

```bash
# 1. 确认工作区干净
git status
# 输出：nothing to commit, working tree clean

# 2. 故意改坏 config.py（比如把 SHIFT_HOURS 改成 999）
echo 'SHIFT_HOURS = 999' >> config.py

# 3. 展示"坏了"
git status
# 输出：modified: config.py
python run.py data\宏达精密_订单台账.xlsx --out /tmp/x
# 输出：报错或结果明显不对

# 4. 撤销
git restore config.py

# 5. 展示"回来了"
git status
# 输出：nothing to commit, working tree clean
python run.py data\宏达精密_订单台账.xlsx --out /tmp/y
# 输出：正常
```

### F6.2 关键点

- `git restore` 是 Git 2.23+ 的命令（旧版用 `git checkout -- <file>`）
- **只对已提交过的文件有效**。若文件从未提交，`restore` 无效 → 这也是"提交 ≥3 次"的意义
- 演示前必须确认 `git log` 有至少一次提交

---

## F7. Git Hooks（可选但推荐）

### F7.1 pre-commit：防止数据进库

```bash
# .git/hooks/pre-commit
#!/bin/sh
# 阻止提交 Excel/CSV 客户数据
if git diff --cached --name-only | grep -Ei '\.(xlsx|xlsm|xls|csv)$'; then
    echo "❌ 拒绝提交：检测到 Excel/CSV 文件"
    echo "   客户数据不允许进 Git 仓库（任务书红线）"
    echo "   如果确实需要提交模板，用 git add -f 显式强制"
    exit 1
fi
exit 0
```

```bash
chmod +x .git/hooks/pre-commit
```

**这一条能把「不小心提交数据」从"事后追责"变成"事前拦截"。**

### F7.2 pre-commit：语法检查

```bash
# 阻止提交有语法错误的 .py
python -m py_compile $(git diff --cached --name-only --diff-filter=ACM | grep '\.py$') || exit 1
```

---

## F8. 红线行为清单（任务书「五、红线与延期」原文）

| 红线 | 处理 | 本项目的防法 |
|---|---|---|
| 客户数据提交进 Git 仓库 | **N1 记 0 分，并要求清理历史** | §F2 `.gitignore` + §F7.1 pre-commit hook + 每次提交前检查 |
| 校验器让 AI 生成或判断 | **N4 记 0 分——这是整个项目的地基** | 附录 C §C0 三条原则 + AST import 隔离断言 |
| 直接用参考实现的代码当自己的 | 按抄袭处理，本次 0 分 | 本设计未使用任何参考实现代码，全部自行设计 |
| 演示时用假数据、假截图 | **N6 记 0 分** | 附录 G：所有截图必须来自真实台账跑出的结果 |
| 缺交付物 | 该节点不给分，后续节点最高按 80% 计 | 附录 I 交付物清单逐项打勾 |

### F8.1 如果已经不小心提交了数据怎么办

**必须清理历史，不是删文件了事**：

```bash
# 方案 A：用 git filter-repo（推荐，需要额外安装）
git filter-repo --path data/ --invert-paths

# 方案 B：用 filter-branch（Git 自带，较慢）
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch "*.xlsx" "data/*"' \
  --prune-empty --tag-name-filter cat -- --all

# 清理后强制推送并让协作者重新克隆
```

**然后**：`git reflog expire --expire=now --all && git gc --prune=now --aggressive`

**这是补救，不是免罪。** 任务书说"并要求清理历史"，说明原判 0 分不因补救而取消。

---

## F9. 延期规则（任务书原文）

> 延期：每延一天扣该节点 10%，最多扣到 50%；跨节点连带影响不豁免。

| 延后天数 | 该节点得分 |
|---|---|
| 0 | 100% |
| 1 | 90% |
| 2 | 80% |
| 3 | 70% |
| 4 | 60% |
| 5+ | 50%（封顶） |

**跨节点连带**：N4 延期会让 N5/N6 也缺输入。**所以 N4 的 `checker.py` 要最先做**（手册 §3.4 ③）。

---

## F10. N1 自查表

| ☐ | 项 | 怎么查 |
|---|---|---|
| ☐ | `git init` 完成，有 `main` 和 `dev` 分支 | `git branch -a` |
| ☐ | `.gitignore` 含任务书要求的 5 项 | 打开文件对照 |
| ☐ | **客户 xlsx 不在仓库里** | `git ls-files \| grep -Ei '\.xlsx$'` 无输出 |
| ☐ | `git status` 干净 | `git status --short` 无输出 |
| ☐ | 提交 ≥3 次（本项目建议 16 次） | `git log --oneline \| wc -l` |
| ☐ | 提交信息用了前缀规范，没有纯 `update` | `git log --oneline` 逐条看 |
| ☐ | README 三段齐全（做什么/怎么跑/目录） | 打开看 |
| ☐ | **现场能演示 `git restore` 撤销** | 按 §F6 走一遍 |
| ☐ | 没有单个巨大提交（每次提交改动 < 500 行） | `git log --stat` |
