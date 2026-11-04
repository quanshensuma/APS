# aps-scheduler

宏达精密 · 本地排产助手（简化版 APS）。读取客户订单台账，输出可排产计划与校验报告。

## 怎么跑

```bash
python -m pip install openpyxl
cd aps-scheduler
python run.py            # 待补：入口文件
```

**前置条件**：客户台账 `data/宏达精密_订单台账.xlsx` **不在仓库里**（N1 红线：客户数据不进版本控制），
需要手动从客户包复制到 `data/` 目录后再运行。

## 目录说明

```
aps-scheduler/
├── config.py        常驻配置（班次、日历、交期口径）
├── core/            后端模块：reader 解析 / cleaner 清洗 / calendar 日历
│                    instance 工单展开 / solver 排程 / checker 校验器
├── web/             前端与服务
├── tests/           单测
├── docs/            设计文档
│   └── ui/          UI 稿（N3）
├── data/            客户台账（.gitignore 排除，仅保留 .gitkeep）
└── out/             产物输出（.gitignore 排除）
```

## 开发约定

- 分支：`main` 为稳定线，日常在 `dev` 上开发
- 提交信息：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` + 一句话

## 数据红线

客户台账（`*.xlsx`、`data/` 下除 `.gitkeep` 外的内容）**不得提交**。
提交前用 `git status` 确认干净。
