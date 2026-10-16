# dsh-wiztree

DeepSeek Harness 插件：把「WizTree 快照分析」变成模型可直接调用的工具，并让对话里的**文件路径可以点一下就打开资源管理器**。

配套技能：`~/.dsh/skills/wiztree-snapshot-diff`（本插件里的分析脚本由该技能同步而来）。

---

## 它解决的两个问题

### 1. 脚本 → 工具

技能里原本要模型自己敲的 PowerShell 命令：

```powershell
python scripts\wiztree_snapshot_diff.py 旧.csv 新.csv -o out\report.md --min-mb 1
```

现在变成四个模型可见的工具，不需要工作区里存在脚本、也不需要模型记得参数：

| 工具 | 干什么 | 对应脚本 |
| --- | --- | --- |
| `wiztree_diff` | 对比两份快照：体检、自顶向下定位增长、最小相关父文件夹、精确新增文件/目录数，并写出 Markdown 报告 | `wiztree_snapshot_diff.py` |
| `wiztree_query` | 只读快照查某个文件夹：直属子项 / 递归后代 / 旧版本残留 / 长期未修改；顺带核对路径现在还在不在 | `wiztree_query.py` |
| `wiztree_verify_delete` | 只读查看候选目录真实内容，给 ✅/⚠️/❌ 结论（第 5 步子智能体用） | `wiztree_verify_delete.py` |
| `open_path` | 在资源管理器里定位某个文件/目录（`reveal`），或用默认程序打开（`open`） | — |

模型侧只看到「工具」，Python 与 pandas 由插件自己解决：默认使用 **DSH Desktop 自带运行时**里的 CPython
（`<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/dependencies/python`，内含 pandas/numpy），
找不到时才回退到 `PATH` 上的 `python3`/`python`，并且**先探测能否 import pandas + numpy**，
不能就在工具结果里给一条可执行的修复建议，而不是把一坨 traceback 丢给模型。

### 2. 对话里的路径真的能点开

技能第 8 步要求把路径写成 `[标签](file:///C:/...)`。实测（DSH Desktop 0.2.0-rc.2）：

* 渲染器的 URL 白名单只有 `http/https/mailto`，**`file:` 协议直接被丢掉**，那个链接点下去什么都不发生；
* 渲染器自己支持的本地路径形式（绝对路径 / 相对工作区路径，可带 `#L24` 行号）点下去打开的是**右侧只读预览**，不是资源管理器。

本插件的浏览器半部分在 document 上装了一个捕获阶段的点击监听：

| 点击目标 | 行为 |
| --- | --- |
| `file:///C:/...` 链接 | 宿主路由核实路径 → 目录在资源管理器中打开、文件用默认程序打开 |
| `C:\...` / `C:/...` 绝对路径链接与文件链接按钮 | 同上（覆盖掉「只读预览」） |
| 相对路径链接 | 以会话工作目录为基准解析后同上 |
| `http(s)` 链接、图片、参考文献 chip | **不拦截**，保持原有行为 |
| Ctrl/Cmd/Shift/Alt + 点击、非左键 | 不拦截 |

配套地，技能里的链接写法从 `file:///` 改成**裸路径**（`[标签](C:\Users\...)`），
因为裸路径恰好落在渲染器认可的本地路径语法里；两种写法现在都能点开，但裸路径不会在别的
Markdown 阅读器里变成死链。

---

## 安装

插件是一个普通的 DSH bundle（`dsh.bundle.patch` + `dsh.client`）。**新装一个 bundle 依赖必须重启
DSH Desktop**：运行中的宿主在启动时就固定了 profile 的 bundle 清单，之后只热重载
`cordis.patch.yml`，不会为了新依赖重新组合。（Web 界面的「插件」页装完也会提示重启。）

### 方式一：插件页面（推荐给日常使用）

1. 侧边栏 **插件（Plugins）** → 安装，路径填本目录：

   ```
   E:\test_video\dsh-wiztree
   ```

2. 重启 DSH Desktop。

### 方式二：手工（等价于插件页面做的三件事）

```powershell
# 1) 依赖 + bundle 选择
#    ~/.dsh/profiles/desktop/package.json
#      "dependencies": { "dsh-wiztree": "link:E:/test_video/dsh-wiztree" }
#      "dsh": { "profile": { "bundles": [ ..., "dsh-wiztree" ] } }
# 2) 安装（用 DSH 自带运行时里的 pnpm，避免版本差异）
cd $env:DSH_PROFILE_DIR
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs" install
# 3) 重启 DSH Desktop —— 之后 cordis.yml 会自动带上本包 cordis.patch.yml 插入的：
#      - id: wiztree
#        name: dsh-wiztree
```

**回退**：在插件页面禁用/卸载，或把 `package.json` 里那两处改动删掉再 `pnpm install`。
本仓库安装时留下的备份在 `~/.dsh/profiles/desktop/*.bak-wiztree-*`。

### 可选配置

只需要在 profile 的 `cordis.patch.yml` 里覆盖那一行：

```yaml
- id: wiztree
  name: dsh-wiztree
  config:
    pythonPath: C:\Python312\python.exe   # 仅当你要换掉自动发现的那个解释器
```

---

## 开发

```bash
npm run check        # 生成物是最新的 + 语法检查 + 24 个单测（含一次真实的 Python 端到端跑通）
npm run test         # 只跑单测
npm run build:client # 由 lib/install.js 生成 lib/client.js（改完浏览器半部分必须跑）
npm run sync-skill   # 从技能目录同步三个分析脚本到 lib/scripts/
npm run verify-skill-sync   # CI 用：脚本与技能不一致就以非 0 退出
```

`lib/scripts/wiztree_snapshot_diff.py`、`wiztree_query.py`、`wiztree_verify_delete.py`
是**技能目录的逐字节拷贝**，不要在这里手改 —— 改技能，然后 `npm run sync-skill`。
测试会检查两者是否一致。

`lib/scripts/wiztree_tool.py` 是本仓库自己的 JSON 包装器（技能里没有）：它调用被包装脚本的
`main(argv)`、捕获 stdout、最后打印一行 JSON，这样工具结果既能保留原来给人类看的表格，
又能给模型结构化数据。

`lib/client.js` 是**生成文件**：源在 `lib/install.js`（纯 ESM，方便单测），
`tools/build-client.mjs` 把它包成 `__ModuleLoader__.load({ id, factory })`
的 CommonJS 工厂——这是 harness 唯一会发给浏览器的形态，且插件不能 import 同级模块。

### 目录结构

```
dsh-wiztree/
├── package.json           # dsh.bundle / dsh.client 声明
├── cordis.patch.yml       # 插入 `- id: wiztree` 那一行
├── lib/
│   ├── index.js           # 宿主半部分：四个工具 + /wiztree/stat、/wiztree/open 两条路由
│   ├── run-python.js      # ctx.subprocess 封装：找解释器、跑脚本、解析 JSON
│   ├── python-runtime.js  # 解释器发现与 pandas/numpy 探测（带缓存）
│   ├── paths.js           # 路径语法（宿主侧参考实现）
│   ├── install.js         # 浏览器半部分源码（纯 ESM，可单测）
│   ├── client.js          # 生成物：harness 实际发给浏览器的客户端 bundle
│   └── scripts/           # 三个分析脚本（同步自技能）+ wiztree_tool.py + _env_probe.py
├── tests/                 # node:test：路径语法、宿主↔浏览器一致性、工具端到端、bundle 形态
└── tools/
    ├── build-client.mjs   # 生成 lib/client.js
    └── sync-scripts.mjs   # 与技能目录同步
```

### 已知边界

* 只处理**点击**，不重写渲染出的 DOM：如果哪天渲染器改了本地路径控件的 class 名，
  需要同步 `lib/install.js` 里的 `isFileLinkButton`。
* 浏览器半部分只从**用户点击**触发 `/wiztree/open`，不做任何自动打开。
* `open_path` / `/wiztree/open` 只打开**已存在**的绝对路径，不执行搜索或命令。
* 宿主路由未做来源校验（与 `dsh-host-open-in-app` 不同）：它们只读取路径是否存在并按用户
  手势打开资源管理器，不读文件内容、不返回文件内容。若以后要暴露到局域网，需要补上
  `ctx.connection` 的信任检查。

---

## 许可

MIT。`lib/scripts/` 下的分析脚本与技能同源，随本插件一并分发。
