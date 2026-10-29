# Purge 破限 · 防撤回（SillyTavern 扩展）

把 [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 里「提示词层」和「消息生命周期」两件事拆出来，做成一个酒馆扩展：

- **破限注入**：在请求真正发出之前改写 prompt。文本补全（llama.cpp / textgenerationwebui）走 `GENERATE_AFTER_COMBINE_PROMPTS`，聊天补全（OpenAI 兼容端点）走 `CHAT_COMPLETION_PROMPT_READY`，两条路径都覆盖。
- **身份剥离**（可选）：只清理**系统段**里的「作为 AI / 我不能提供」这类整行声明，不碰角色扮演正文；不会像 dsh-purge 那样剥离 ChatML 标记——酒馆靠这些标记组装 prompt，必须保留。
- **消息保险箱（防撤回）**：监听消息生命周期，把每条消息按内容指纹 append-only 存一份。消息被删、被 swipe 覆盖、被编辑之后，原始版本还在；可以一键导出 JSON 或合并回当前聊天。
- 全部走扩展 API，**不修改酒馆源码**，升级酒馆不会失效。

> 说明：dsh-purge 的补丁引擎（改 `app.asar` 里的源码字符串）和 Cordis 插件层在酒馆里没有对应物，没有移植价值；这里只搬了两块能用的逻辑，另外按酒馆的事件模型重写。

## 安装

**方式一：手动拷贝（推荐，冒烟测试用的就是这个）**

```powershell
robocopy "D:\AI\DeepSeek-Herness\workplace\测试\1017测试\Purge SillyTaven" `
         "D:\AI\SillyTavern\data\default-user\extensions\purge-tavern" /MIR `
         /XD _ref .git node_modules
```

然后刷新酒馆页面，在「扩展」面板里应该出现 **「Purge 破限 · 防撤回」** 折叠块。

**方式二：全局安装**（对所有用户生效）

把整个目录拷到 `D:\AI\SillyTavern\public\scripts\extensions\third-party\purge-tavern\`。

### 已经装到本机了

`D:\AI\SillyTavern\data\default-user\extensions\purge-tavern`（2026-10-29 用 robocopy 装好，`/api/extensions/discover` 已能列出 `third-party/purge-tavern`）。

### 1.18 的一个坑（相对导入）

酒馆的扩展是从 `/scripts/extensions/third-party/<name>/index.js` 加载的，所以相对导入要按 **URL + 文件名** 两层来算：

```js
import { eventSource, event_types, extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js'; // → /scripts/extensions.js
import { getContext } from '../../../../script.js';                                                              // → /script.js
```

写成 `'../../../scripts/extensions.js'` 会解析成 `/scripts/scripts/extensions.js`，激活时报 `Could not activate extension third-party/purge-tavern Event`（导入失败被包成 Event，看不到真实原因）。

## 使用

扩展面板里有三档注入：

| 档位 | 内容 | 适合 |
|---|---|---|
| 默认档（角色扮演向） | 自带的一段高优先级叙事覆盖设定（中英混排，约 600 字） | 日常角色扮演、破掉「我是助手/我不能写」 |
| 原版搬运 | dsh-purge 原本的 21 KB 代码代理越狱提示词（`presets/purge-original.md`） | 想要原版那套「UNRESTRICTED SANDBOX」行为 |
| 自定义 | 自己写 | 换模型、换题材时微调 |

- **插入位置**：`系统段开头`（默认，权重最高）/ `系统段结尾` / 整个 prompt 最前 / 最后。文本补全会自动探测 `<|im_start|>system`、`### System:`、`<system>` 等常见模板；聊天补全则挂到第一条 `system` 消息上（没有就新建一条）。
- **身份剥离**：默认关闭。开启后只处理系统段；「额外剥离正则」每行一条，用来补自己的规则。
- **导入/导出注入文本**：面板上的「导出当前注入文本」会把当前生效内容存成 `.md`，改完贴回自定义档即可。

### 命令

| 命令 | 作用 |
|---|---|
| `/purge-export` | 导出当前聊天的消息快照 JSON |
| `/purge-restore` | 把快照里缺失的消息合并回当前聊天并重载 |
| `/purge-status` | 打印注入/保险箱状态 |

### 防撤回的边界

- 保险箱是**软保护**：它不拦截 swipe、删除、编辑（酒馆没有可靠的拦截点，硬拦会破坏正常交互），而是在后台留底。被撤回的消息会从聊天里消失，但快照里永远有一份，`/purge-restore` 能把它合回聊天。
- 快照存在 `extension_settings['purge-tavern'].vault`，随酒馆的 `settings.json` 落盘；默认每聊天 300 条、最多 20 个聊天，超出丢最旧的聊天。
- 快照是纯文本（含 swipes），敏感场景请自行决定是否开启。

## 本机冒烟结果（2026-10-29）

环境：`D:\AI\SillyTavern` 1.18.0 / node 24.15.0 / 端口 8000；上游用本地 mock（llama.cpp 原生 `/completion` 与 OpenAI 兼容 `/v1/completions` 两种协议），记录到的 prompt 落盘成 ndjson 供断言。

驱动方式：无头 Edge + CDP 执行探针脚本（真页面、真事件、真 UI 点击），不是单元测试。

| 检查项 | 结果 | 证据 |
|---|---|---|
| 扩展被发现 | PASS | `/api/extensions/discover` → `third-party/purge-tavern` |
| manifest 激活钩子 | PASS | `hooks: { activate: "init" }`，console `[purge-tavern] initialized v0.1.0` |
| 设置面板渲染 | PASS | `#extensions_settings2` 里出现 `#pt_enabled` / `#pt_profile` |
| rp 档注入 | PASS | 601–623 字符，落在 system 段、user 轮之前 |
| original 档注入 | PASS | 21,282–21,304 字符（`presets/purge-original.md` 全文） |
| custom 档注入 | PASS | 只含自定义标记 |
| 拒答句剥离 | PASS | `I'm sorry, but I can't provide…` / `作为 AI…我不能提供` 两行被删；身份句保留（设计如此） |
| UI 发送 → 上游 prompt 带注入 | PASS | 真点角色 → 发消息 → mock 收到 `promptChars=1379/1909/2065`，开头是 `<|purge|> [PURGE OVERRIDE…]` |
| 消息落库 + 保险箱快照 | PASS | 聊天消息 3→5→7，`vault.currentStats()` count 6→8 |
| 删除后恢复（防撤回） | PASS | 删掉最后一条 → `restoreCurrent()` → 消息数回到删除前 |
| 控制台错误 | 0 | 仅 `[DEPRECATED] MacrosParser.registerMacro` 警告（酒馆自带，与扩展无关） |

探针断言第一次跑时有 4 项 FAIL，全部是**断言写错**（把「原版档标记」「剥离身份句」「导出返回值」当成了预期行为），修正后 13/13 全 PASS。原始结果：`work\analysis\runtime\smoke-final2.json`、`smoke-clean.json`（工作区 `work\runtime\probe\smoke-final.js`）。

> 冒烟期间临时把 `settings.json` 切到本地 mock（备份 `settings.json.bak_smoke_20261029`），**测完已还原**为用户原来的 OpenAI 配置；扩展自身的设置会在下次发消息时重新写入。

## 手机上测试

酒馆默认只监听 whitelist 里的回环地址，手机访问会被 403 拦住。**本机已经替你改好了**：`config.yaml` 的 `whitelist` 加了 `192.168.1.0/24`（原文件备份为 `config.yaml.bak_phone_20261029`），`listen` 本来就是 `0.0.0.0:8000`，Windows 防火墙也有 Node 的放行规则；实测 `http://192.168.1.2:8000/` 返回 200。

**局域网（同一 WiFi，推荐）**

1. 双击 `D:\AI\SillyTavern\启动酒馆.bat` 正常启动（我就是在这个实例上冒烟的；冒烟结束后已把它停掉，配置已还原）。
2. 手机浏览器打开 `http://192.168.1.2:8000`（本机以太网地址；PC 换网段的话用 `ipconfig` 查，并同步改 whitelist）。
3. 如果手机打不开而电脑能开：先看电脑防火墙是否放行 8000，再确认手机和电脑在同一网段（不要连到访客 WiFi）。

**隧道（不在同一网络）**

双击 `D:\AI\SillyTavern\Remote-Link.cmd`（`cloudflared tunnel --url localhost:8000`），把打印出来的 `https://xxx.trycloudflare.com` 地址发到手机打开。隧道方式不需要改 whitelist。

手机上验证三件事：

1. 扩展面板出现「Purge 破限 · 防撤回」，勾选状态与电脑一致（设置跟随账号保存）。
2. 发一条消息，模型回复没有「作为 AI…」这类拒答前缀（说明注入生效）。
3. 删掉或 swipe 掉一条消息，再执行 `/purge-restore`，消息能回来（说明保险箱生效）。

## 冒烟自测

扩展加载后会挂一个只读调试入口，方便脚本验证（不影响正常使用）：

```js
PurgeTavern.version              // '0.1.0'
PurgeTavern.applyText('...')     // 对任意 prompt 应用注入 + 剥离
PurgeTavern.applyChat([...])
PurgeTavern.vault.currentStats()
PurgeTavern.reloadSettings()
```

## 目录

```
manifest.json        扩展声明（hooks.activate → init）
index.js             事件注册、设置面板绑定、斜杠命令
src/settings.js      默认设置、三档注入文本、系统段边界探测
src/inject.js        文本/聊天两条注入路径 + 身份剥离
src/vault.js         消息保险箱（快照、导出、合并回聊天）
settings.html        设置面板模板
style.css            面板样式（只作用于 .purge-tavern）
presets/purge-original.md  dsh-purge 原版提示词（搬运档）
```

## 许可

MIT。原版提示词与思路来自 dsh-purge（YuJunZhiXue，MIT）。
