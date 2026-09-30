# 文档生成

`build_design_doc.py` 从 `docs/design-source.json` 同时生成设计 DOCX 和 `docs/ARCHITECTURE.md`。
使用 Python 3 和 `python-docx`；运行目录不限：

```bash
python -m pip install python-docx
python scripts/build_design_doc.py
```

字体配置使用 Noto Sans CJK SC，字体文件不随仓库分发。不同机器缺少该字体时可能发生替换与分页变化。
正文或版式修改后应在 Word/兼容环境重新查看所有页面；生成脚本成功不等同于排版已检查。
ADR、状态表和实施计划是另外维护的文档，需要与同源正文同步更新。

## 仓库安装

根目录运行 npm run setup，由 setup.mjs 按四个 lockfile 安装开发依赖；无需单独进入适配器目录。原始设计文件保留为历史快照，最新实现与实测见 docs/IMPLEMENTATION_STATUS.md 和 docs/VALIDATION.md。
