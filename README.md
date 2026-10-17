# dsh-wiztree

DeepSeek Harness 插件：把「WizTree 快照分析」变成模型可直接调用的工具，并让对话里的
**文件 / 文件夹路径可以点一下就直接进回收站**（可还原，插件没有永久删除通道）。

配套技能：`~/.dsh/skills/wiztree-snapshot-diff`（本插件里的分析脚本由该技能同步而来）。

---

## 它解决的两个问题

### 1. 脚本 → 工具

技能里原本要模型自己敲的 PowerShell 命令：

```powershell
python scripts\wiztree_snapshot_diff.py 旧.csv 新.csv -o out\report.md --min-mb 1
```

现在变成三个模型可见的工具，不需要工作区里存在脚本、也不需要模型记得参数：

| 工具 | 干什么 | 对应脚本 |
| --- | --- | --- |
| `wiztree_diff` | 对比两份快照：体检、自顶向下定位增长、最小相关父文件夹、精确新增文件/目录数，并写出 Markdown 报告 | `wiztree_snapshot_diff.py` |
| `wiztree_query` | 只读快照查某个文件夹：直属子项 / 递归后代 / 旧版本残留 / 长期未修改；顺带核对路径现在还在不在 | `wiztree_query.py` |
| `wiztree_verify_delete` | 只读查看候选目录真实内容，给 ✅/⚠️/❌ 结论（第 5 步子智能体用） | `wiztree_verify_delete.py` |

模型侧只看到「工具」，Python 与 pandas 由插件自己解决：默认使用 **DSH Desktop 自带运行时**里的
CPython（`<home>/dsh-runtimes/dsh-primary-runtime/dependencies/python`，内含 pandas/numpy），
找不到时才回退到 `PATH` 上的 `python3`/`python`，并且**先探测能否 import pandas + numpy**，
不能就在工具结果里给一条可执行的修复建议，而不是把一坨 traceback 丢给模型。

`<home>` 按这个顺序解析，取第一个存在的解释器：

1. `DSH_HOME`（显式配置）；
2. `DSH_PROFILE_DIR` 的上两级（profile 目录是 `<home>/profiles/<name>`）；
3. `~/.dsh`。

> ⚠️ **第 3 条不是可有可无的兜底。** 桌面版把家目录放在 `~/.dsh`，但它**不给自己**的进程
> 导出 `DSH_HOME` —— 那个变量只给工具子进程。早先的发现逻辑只信 `DSH_HOME`，于是在一台
> 明明带着 pandas 的机器上，插件看不到自带运行时、静默回落到 PATH 上的裸 `python.exe`
> 并报「没有 pandas」。测试里当时写了 `process.env.DSH_HOME ??= ~/.dsh` 去补这个变量，
> 于是**测试永远通过、生产永远失败** —— 现在那行已经删掉，并有一条用例专门在不设
> `DSH_HOME` 的条件下跑。

顺带修掉同一函数里的第二个 bug：`runtime.json` 的 `python` 字段存的是**版本号**
（`"3.12.14"`），不是路径，原代码把它当成解释器命令去 spawn。现在只在它确实是绝对路径时才采用，
并有一条「所有绝对候选必须真实存在」的不变式兜住这类错误。

### 2. 对话里的路径：点一下 = 进回收站

技能第 8 步要求把路径写成链接，方便用户逐条处理。实测（DSH Desktop 0.2.0-rc.2）：

* 渲染器的 URL 白名单只有 `http/https/mailto`，**`file:` 协议直接被丢掉**，那种链接点下去什么都不发生；
* 渲染器自己支持的本地路径形式会渲染成一个 `<button class="_fileMention_… _fileLink_…" title="C:\path">`，
  它原本的 `onClick` 打开的是**右侧只读预览**，不是资源管理器。

本插件的浏览器半部分在 `document` 上装了一个**捕获阶段**的点击监听（先于 React 挂在根容器上的监听执行），
把那个手势接管过来：

| 点击 | 行为 |
| --- | --- |
| **左键单击「文件夹」** | `POST /wiztree/trash` → **移入回收站**，弹一条提示，被点过的链接置灰加删除线 |
| **左键单击「文件」** | **不拦截** —— 交给渲染器打开右侧只读预览。读文件是对话里最常用的动作，插件绝不抢它 |
| **左键单击「相对路径」** | **不拦截** —— `lib/index.js` 这类工作区相对引用是「给我看看」，不是清理目标 |
| **Ctrl / ⌘ + 单击（任意本地路径）** | `POST /wiztree/open` → 在资源管理器中**定位**（只看，不动） |
| Shift / Alt + 单击、非左键 | 不拦截 |
| `http(s)` 链接、图片、参考文献 chip | 不拦截 |
| 正在划选文本时的点击 | 不拦截 |

**「是文件夹还是文件」在点击之前就查好了。** 点击事件是同步的，没法在里面 `await` 宿主，
所以插件启动时扫描一遍对话里已经渲染的本地路径、并用 `MutationObserver` 跟住后续新渲染的，
把 `路径 → directory | file | missing` 记在内存里；点击时只查表。查不到的（刚渲染出来的）
一律**按文件对待**，也就是不拦截 —— 宁可少删一次，也不会误删或吞掉预览。

宿主侧还有第二道锁：`/wiztree/trash` 只接受**目录**，文件一律 `409` 拒绝。所以即使页面开了很久、
类型缓存过期了，也不可能把文件送进回收站。

### 一条硬规则：做不了就什么都别做

插件**只有在确认宿主半部分能应答之后才安装点击接管**（启动时拿一个故意非法的请求体去
`POST /wiztree/stat`，我们自己的路由会用 JSON 回 400，路由不存在则是 harness 的 HTML 404、
解析不出来）。探不通就**完全不接管**，并在控制台留一条警告。

这条规则是被一次真实的 bug 逼出来的：页面刷新（F5）会载入新的浏览器半部分，而**运行中的 app
仍然是启动时 import 的那份宿主模块**。那种「半新半旧」的状态下，如果照样把点击吞掉，
手势既执行不了、侧边栏预览也没了 —— 看起来就像「插件把浏览功能弄坏了」。宁可什么都不做。

出问题时在控制台执行 `window.__DSH_WIZTREE__` 可以看到 `hostAvailable` 与 `mode`。

**为什么是回收站而不是删除**：快照复核的最后一步就是「这条不要了」，而这个决定应该是可反悔的。
插件里因此**没有任何永久删除通道**——不是靠一个 flag 关掉的，而是根本没有实现。

#### 安全闸门（`lib/index.js` 的 `recycleRefusal`）

单击即生效，所以宿主侧先拦掉一次误点绝不该动的路径，**在碰文件系统之前**就拒绝：

* 盘符根（`C:\`）、网络共享根（`\\server\share`）；
* `%SystemRoot%`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramData%`、
  `%USERPROFILE%`、`%LOCALAPPDATA%`、`%APPDATA%` 这些已知根**本身**；
* 插件自己的包目录（整个 `dsh-wiztree/`）—— 会话里到处是它自己源码的链接；
* 插件自己工作目录及其任何**父目录**（子目录放行：「我项目里这个文件夹是垃圾」是正当目标）。

其余一律放行 —— 包括普通文件夹（用户明确要的就是「点文件夹进回收站」）。

---

## 安装

插件是一个普通的 DSH bundle（`dsh.bundle.patch` + `dsh.client`）。

> ⚠️ **改完源码必须重启 DSH Desktop。** 运行中的宿主在启动时就固定了 Loader 的 bundle 清单与已加载的模块；
> 实测**禁用 / 重新启用 bundle 也不会重新 import 模块代码**（Node 的 ESM 缓存会命中旧模块），
> 界面刷新同样只影响浏览器半部分。改宿主半部分（路由、工具）之后不重启，看到的仍然是旧行为。

### 方式一：插件页面（推荐给日常使用）

1. 侧边栏 **插件（Plugins）** → 安装，路径填本目录：

   ```
   E:\test_video\dsh-wiztree
   ```

2. 重启 DSH Desktop。

如果依赖已经在 `package.json` 里（本仓库的情况），插件页面里的「安装」会因为
`ambiguous-install` 失败 —— 已经装好的包不会产生依赖差异。这时直接**启用**那个 bundle
即可（插件页面开关，或让模型调 `plugin_manager` 的 `set_bundle`），再重启一次。

### 方式二：手工（等价于插件页面做的事）

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

**只手工改 `package.json` 是不可靠的**：实测宿主会在下一次 profile 写入时按自己的
状态覆盖回去（`dsh.profile.bundles` 会被改回来），所以请走插件页面 / `set_bundle`。

**回退**：在插件页面禁用或卸载。本仓库安装时留下的备份在 `~/.dsh/profiles/desktop/*.bak-wiztree*`。

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
npm run check        # 生成物是最新的 + 语法检查 + 34 个单测（含真实的 Python 端到端与真实的回收站往返）
npm run test         # 只跑单测
npm run build:client # 由 src/client.js 生成 lib/client.js（改完浏览器半部分必须跑）
npm run sync-skill   # 从技能目录同步三个分析脚本到 lib/scripts/
npm run verify-skill-sync   # CI 用：脚本与技能不一致就以非 0 退出
```

`lib/scripts/wiztree_snapshot_diff.py`、`wiztree_query.py`、`wiztree_verify_delete.py`
是**技能目录的逐字节拷贝**，不要在这里手改 —— 改技能，然后 `npm run sync-skill`。
测试会检查两者是否一致。

`lib/scripts/wiztree_tool.py` 是本仓库自己的 JSON 包装器（技能里没有）：它调用被包装脚本的
`main(argv)`、捕获 stdout、最后打印一行 JSON，这样工具结果既能保留原来给人类看的表格，
又能给模型结构化数据。

### 工具 schema 有一条必须遵守的规矩

`ctx.tools.register()` **什么都不编译**：它只用 harness 的 JSON Schema 子集校验 `output.schema`，
而 `parameters` 会**原样**存下来、原样发给模型供应商。所以：

* 两个 schema 都写成**真正的 JSON Schema**；
* `parameters` 必须是对象根（`type: 'object'` + `properties` + `required: [...]`）。

`{ 字段: { type, required: true } }` 那种简写是 `defineTool()` 的写法，本插件不用它；
把它交给 `register()` 会得到一个**没有对象根**的 schema，供应商会对**每一个**请求回
`400 invalid function call parameters`（工具定义不合规）。这个失败在本地是完全静默的，
所以 `lib/index.js` 的 `assertParameterSchema()` 会在加载时直接把它拦下来，
测试里也有一条用 harness 自己的闸门跑的用例钉住它。

### 目录结构

```
dsh-wiztree/
├── package.json           # dsh.manifestVersion / dsh.bundle / dsh.client 声明
├── cordis.patch.yml       # 插入 `- id: wiztree` 那一行
├── src/
│   └── client.js          # 浏览器半部分源码（纯 ESM，可单测）
├── lib/
│   ├── index.js           # 宿主半部分：三个工具 + /wiztree/{stat,open,trash} 三条路由
│   ├── run-python.js      # ctx.subprocess 封装：找解释器、跑脚本、解析 JSON
│   ├── python-runtime.js  # 解释器发现与 pandas/numpy 探测（带缓存）
│   ├── paths.js           # 路径语法（宿主侧参考实现）
│   ├── client.js          # 生成物：harness 实际发给浏览器的客户端 bundle
│   └── scripts/           # 三个分析脚本（同步自技能）+ wiztree_tool.py + _env_probe.py
├── tests/                 # node:test：路径语法、宿主↔浏览器一致性、工具端到端、回收站往返、bundle 形态
└── tools/
    ├── build-client.mjs   # 生成 lib/client.js
    └── sync-scripts.mjs   # 与技能目录同步
```

`lib/client.js` 是**生成文件**：源在 `src/client.js`（纯 ESM，方便单测），
`tools/build-client.mjs` 把它包成 `__ModuleLoader__.load({ id, factory })`
的 CommonJS 工厂——这是 harness 唯一会发给浏览器的形态，且插件不能 import 同级模块。

### 已知边界

* 只处理**点击**，不重写渲染出的 DOM：本地路径控件的 class 名是带哈希的
  （`_fileLink_1ypvv_59`），匹配靠 `fileLink` / `fileMention` 子串，外加
  「`title` 是绝对路径」这条结构性兜底，所以哈希变化不会让手势静默失效。
* 浏览器半部分只从**用户点击**触发，不做任何自动打开或自动删除。
* **回收站的前提是卷上有回收站**：`SendToRecycleBin` 在回收站被禁用的卷上会直接永久删除。
  这是 Windows 语义，插件无法替用户判断，所以指向那种卷的路径请自己确认后再点。
* 回收站里的东西只能从**资源管理器**还原，插件没有实现「撤销」。
* `/wiztree/open`（Ctrl/⌘+单击的手势）只定位**已存在**的绝对路径，不执行搜索或命令。
* **没有 `open_path` 工具**：打开路径是手势，不是工具。单击文件夹 = 移进回收站，
  Ctrl/⌘+单击 = 在资源管理器里定位，两者都由浏览器半部分发起。
* 宿主路由未做来源校验（与 `dsh-host-open-in-app` 不同）：它们只读路径是否存在、按用户手势
  打开或移入回收站，不读也不返回文件内容。若以后要暴露到局域网，需要补上 `ctx.connection`
  的信任检查 —— **`/wiztree/trash` 尤其如此**。

---

## 许可

MIT。`lib/scripts/` 下的分析脚本与技能同源，随本插件一并分发。
