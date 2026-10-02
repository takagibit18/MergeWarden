# Tree-sitter Python 适配

真正的 `web-tree-sitter@0.27.0` 读取官方 `tree-sitter-python@0.25.0` 包中的 WASM，再由 CST 提取带作用域名称的定义与调用位置。安装和解析均不执行 Python import，也不加载 npm grammar 的原生绑定。

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
```

默认从锁定的开发依赖读取 grammar，运行前验证 `grammars/python.lock.json` 的 SHA-256 和 ABI。无需另行下载或编译。WASM 不重复提交到仓库，来源由 npm lockfile 和 grammar lock 共同追溯。

可通过 `MERGEWARDEN_PYTHON_GRAMMAR_WASM` 为 fixture 测试提供路径，但文件必须与固定校验值一致。缺失、被修改或 ABI 不符均报错，不静默跳过，不回退到正则。升级 grammar 需更新固定版本、来源和校验值并重跑测试。

提取器输出普通可序列化数据：file/class/function、import、call/inheritance site、作用域与绑定；method 归入 function，并以 `functionKind=method` 保留诊断信息。普通名称 reference 不再提取为图事实。CST 对象在返回前释放。id 对相同 snapshot/path/种类/源码范围/限定名确定性生成，不承诺跨 snapshot 不变。限定名带模块前缀，行号从 1 开始、列号从 0 开始。

`src/graph/python-resolver.ts` 两遍流式处理文件：先保留声明、作用域、绑定与 import 索引，再逐文件解析关系并提交 checkpoint。它支持文件、函数、嵌套函数、类体及词法遮蔽；方法体查找跳过类命名空间。参数、赋值、循环/with/except 绑定会阻止同名回退。默认参数在外围作用域解析。仓库根目录模块支持 `import pkg.mod`、`as`、`from ... import ...`、基础相对 import 与结构性的 wildcard import；普通 import 的根包绑定与 IMPORTS 实际目标分别处理。

本阶段不推断接收者类型：`obj.method()`、`self.method()`、类属性/descriptor、getattr、动态 import、外部依赖、DI、monkey patch、metaclass 不推测目标。lambda/comprehension 内调用保留 unresolved；global/nonlocal 只使其所在作用域不透明，不污染同文件无关作用域；wildcard import、exec/eval 或复杂 pattern/type alias 会保守禁用相关名称解析。装饰器/条件/重复定义保留 candidate，不产出可靠 CALLS。全仓同名不会补成边；范围外模块也会显式制造不确定性，避免因裁掉候选而产生伪确定关系。无 `__init__.py` 的 namespace package 根、src-layout 搜索根配置、高级 import loader 目前不补猜。

解析有错误的文件仍可列出声明及未解析位置，但不产生可靠语义关系。四种 resolution 是规则类别，没有小数 confidence。CALLS 与 INHERITS 只连接可明确绑定的静态目标；类调用连接 class，`__init__` 保持一个普通 function 实体。运行时可达性/动态行为仍需源码验证。最终可遍历关系只有 CONTAINS/IMPORTS/CALLS/INHERITS；candidate/unresolved site 仅供诊断。测试包含同名隔离、嵌套作用域、六类 import、循环/wildcard import、继承、动态调用、损坏缓存、分页与取消。
