# Python grammar 来源

使用官方 npm 包 `tree-sitter-python@0.25.0` 自带的 `tree-sitter-python.wasm`。包作为开发依赖安装，安装脚本禁用；不加载其 Node 原生绑定。

- 上游： https://github.com/tree-sitter/tree-sitter-python
- npm 发布 commit：`293fdc02038ee2bf0e2e206711b69c90ac0d413f`
- ABI：`15`
- SHA-256：`16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`
- 包许可证：MIT（随 npm 包提供 LICENSE）
- 机器可读记录：[python.lock.json](python.lock.json)

`PythonTreeSitterExtractor.create()` 默认读取该文件的已安装副本，先验证 bytes 的 hash，再把相同 bytes 交给 Parser 并检查 ABI。未重新编译此 WASM；这是官方发布物的安装和运行验证。

更新时先核对官方包来源、gitHead 和许可证，再刷新 npm lockfile、grammar lock 及真实解析测试。不要手写伪造 npm lockfile，也不要在 grammar 不可用时返回成功。
