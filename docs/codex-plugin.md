# Codex plugin

`nshcr/jevs` 的 `release` 分支提供可安装的 Codex marketplace。marketplace 名称为 `jevs`，插件安装标识为 `jevs@jevs`。

## 安装

准备 Bun 1.4.2 或更新版本，确保 Codex 进程的 PATH 可以找到它。项目完成首次发布后执行：

```sh
codex plugin marketplace add https://github.com/nshcr/jevs.git --ref release
codex plugin add jevs@jevs
```

安装来源需已有 release 分支。也可在支持 Git marketplace 的 Codex 界面中指定上述地址和 ref。

## 配置与启动

从 Codex 进程环境提供 `TYPESAFE_API_KEY`，可选 `TYPESAFE_DEFAULT_MODEL`、`TYPESAFE_BASE_URL`，以及 `JEVS_MAX_CONCURRENCY`、`JEVS_MAX_QUEUE`、`JEVS_QUEUE_TIMEOUT_MS`。桌面应用未必继承终端环境，需在实际宿主验证。凭据不写入插件、Git 或工具参数。

其他供应商专用环境变量及地址、模型配置见 [供应商接入](providers.md)，并发参数见 [性能与负载控制](performance.md#调度参数)。

新建任务后调用 `jev_guide`；无密钥也可读取指导。真实推理需要配置的服务商密钥、账户权限及网络。bundle 使用相对插件目录的 `bun dist/index.js`，无需 npm 安装。

## 更新

```sh
codex plugin marketplace upgrade jevs
codex plugin add jevs@jevs
```

刷新 marketplace 后重新安装并新建任务，核对 MCP 握手版本。已运行任务不会因远端分支更新自动重载。发布版本来自源码 package.json。

## 固定版本与回滚

需要固定或回滚版本时，将 `--ref release` 替换为 release 历史中的具体提交。固定 ref 不跟随新版本。来源提交与版本可通过该分支的 `build-info.json` 核对。发布操作见 [构建与发布](releases.md)。
