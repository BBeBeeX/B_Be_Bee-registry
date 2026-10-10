# BBeBee 内容注册表（B_Be_Bee-registry）

BBeBee 音乐播放器的**第三方内容注册表**：社区在这里发布与共享音乐源、歌词源、主题和插件。

## 架构模型

本注册表采用**去中心化元数据指针模型**：

1. **音乐源（Music Sources）与歌词源（Lyric Sources）**：
   - 存储路径：`music-sources/{username}-{name}.json` 与 `lyric-sources/{username}-{name}.json`
   - **纯元数据指针**：注册表仅收录指针元数据，`repo` 字段指向作者的 GitHub 仓库。
   - **作者仓产物契约**：源仓库根目录下必须提供 `index.json` 作为该源的规则文档定义。
2. **插件（Plugins）**：
   - 存储路径：`plugins/{username}-{pluginname}.json`
   - **纯元数据指针**：注册表不托管插件编译代码，`repo` 指向作者的 GitHub 仓库。
   - **作者仓产物契约**：插件仓库根目录下必须提供 `index.js`（插件运行入口代码）与 `manifest.json`（插件清单与能力声明）。
3. **界面主题（Themes）**：
   - 存储路径：`themes/{author}-{name}/`
   - **内容进仓**：包含 `theme.json`（颜色设计 Token 定义）与 `preview.png`（预览图）。主题直接托管在本仓，无需 `repo`。必须通过 WCAG AA 对比度门禁与合法 `#hex` 校验。

> **提示**：本仓库无 `dist/` 编译产物目录，无 `registry.json` 中心化大文件，客户端与工具链直接消费各类型目录下的独立 JSON 条目。

---

## 目录结构

```
B_Be_Bee-registry/
├── music-sources/
│   └── {username}-{name}.json        # 音乐源元数据指针
├── lyric-sources/
│   └── {username}-{name}.json        # 歌词源元数据指针
├── plugins/
│   └── {username}-{pluginname}.json  # 插件元数据指针
├── themes/
│   └── {author}-{name}/              # 界面主题定义
│       ├── theme.json                # 主题 Token 定义（含 tokens.dark / tokens.light）
│       └── preview.png               # 主题预览图
├── scripts/
│   ├── validate.mjs                  # 全量校验门禁与负向测试套件
│   └── lib/                          # 校验规则与模型
├── .github/workflows/
│   └── validate.yml                  # CI 自动校验工作流
├── CONTRIBUTING.md                   # 贡献指南：Schema 规范与提交步骤
├── MODERATION.md                     # 审核标准、冒名处理与下架流程
└── README.md                         # 本说明文件
```

---

## 快速开始与本地校验

向本注册表添加或修改条目后，请在仓库根目录运行校验命令：

```bash
# 运行全量校验（离线或沙箱环境下网络不可达降级为警告）
node scripts/validate.mjs

# 严格模式（任何警告亦视为失败）
node scripts/validate.mjs --strict

# 跳过网络连通性探测（仅做严格语法与 Schema 校验）
node scripts/validate.mjs --skip-network

# 运行内置负向测试套件（验证坏输入拦截有效性）
node scripts/validate.mjs --test
```

所有 PR 在合并前必须确保 `node scripts/validate.mjs` 输出 **0 errors**。

详细提交指南请参考 [CONTRIBUTING.md](CONTRIBUTING.md)；审核规范请参考 [MODERATION.md](MODERATION.md)。

---

## 免责声明

- 本注册表收录的所有第三方内容（音乐源、歌词源、插件、主题）均由社区开发者提交，与 BBeBee 项目及注册表维护团队无关；请在条目元数据中如实署名。
- 插件和源的代码运行在用户本地沙箱环境中，请用户在安装前自行核对源码与作者仓库安全性。
