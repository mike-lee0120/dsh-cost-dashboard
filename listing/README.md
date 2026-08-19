# 收录到 dsh 插件市场（awesome-dsh-plugin）操作指引

本目录准备好了一份可以直接提交的收录文件。按下面步骤操作即可。

## 前置检查

- [x] `package.json` 声明 `dsh.bundle.patch` + 根目录 `cordis.patch.yml` —— 已有
- [x] 真实可运行代码、提交数 ≥ 10 —— 已有（24 commits）
- [ ] 仓库创建满 1 天 —— 提 PR 前确认
- [ ] 给仓库添加 GitHub topic：`dsh-plugin` —— 需要您在 GitHub 仓库页操作：
  Repository 首页 → About 右侧 ⚙️ → Topics 输入 `dsh-plugin` 保存

## 提交流程

1. 确认上面的前置检查都完成。

2. Fork [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 到您自己的 GitHub 账号，然后 clone 您的 fork。

3. 把本目录的 `mike-lee0120__dsh-cost-dashboard.yml` 复制到 fork 仓库的
   `data/plugins/` 目录下（文件名保持不变）。

4. 在 fork 仓库根目录重新生成 README（**不要手改 README**）：

   ```sh
   npm ci
   node scripts/generate-readme.mjs
   ```

5. 提交 `data/plugins/mike-lee0120__dsh-cost-dashboard.yml` 和重新生成的两个
   README（`README.md`、`README.zh.md`），推送到您的 fork。

6. 打开 Pull Request（base 为 awesome-dsh-plugin 的 main 分支）。

## PR 标题

```
Add mike-lee0120/dsh-cost-dashboard
```

## PR 描述

```
Cost dashboard plugin for DeepSeek Harness.

- installs via: dsh plugin --profile web add github:mike-lee0120/dsh-cost-dashboard
- declares dsh.bundle manifest (cordis.patch.yml included)
- category: usage
- description in the entry matches the implemented features:
  - session log scan + token accounting (verified against the official
    token-meter projection, see scripts/verify-totals.mjs)
  - builtin pricing incl. DeepSeek peak/off-peak time-of-day rates
  - LiteLLM catalog auto-sync to fill missing models
  - daily trend charts, per-model and per-session tables
  - optional read-only provider balance/spend (DeepSeek/OpenRouter/OpenAI/Anthropic)
```

## 说明

- 收录由 CI + 维护者人工评审：CI 校验 manifest/仓库年龄/格式/README 可重新生成，
  维护者会核对描述与代码是否相符。
- 合并后 `awesome-dsh-plugin.com/plugins.json` 更新，dshmarket 会自动收录
  （通常一天内生效）。
- 若描述需要修改，只改 `data/plugins/mike-lee0120__dsh-cost-dashboard.yml` 后
  重新生成 README 再提交，不要手改 README。
