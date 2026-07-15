# 易机圈数码 - 商家管理后台

数码设备租赁平台的网页版商家管理后台。

## 项目结构

```
├── server.js          # Express 后端服务（API + 静态文件）
├── public/            # 管理后台前端（由 server.js 托管）
│   ├── index.html     # 主管理界面
│   ├── login.html     # 登录页
│   ├── js/main.js     # 前端 JS（早期版本）
│   └── products/      # 产品图片
├── docs/              # GitHub Pages 静态前端（独立部署用）
│   ├── index.html
│   ├── login.html
│   └── js/api-config.js  # ⚠️ API 地址配置文件
├── scripts/           # 管理脚本
├── cloudbaserc.json   # CloudBase 云托管部署配置
├── Dockerfile         # Docker 构建文件
└── package.json
```

## 部署方式

### 方式一：CloudBase 云托管（推荐）

```bash
# 使用 CloudBase CLI 部署
tcb cloudrun deploy
```

部署前请在 CloudBase 控制台 → 云托管 → 环境变量中配置：

| 变量名 | 说明 |
|--------|------|
| `CLOUD_SECRET_ID` | CloudBase 密钥 ID |
| `CLOUD_SECRET_KEY` | CloudBase 密钥 Key |
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `BRANCH_ADMINS` | 分校管理员：`school1:pwd1;school2:pwd2` |
| `CORS_ORIGINS` | CORS 允许的域名（逗号分隔，GitHub Pages 需要） |

### 方式二：本地运行

```bash
cp .env.example .env
# 编辑 .env 填入真实密钥
npm install
npm start
# 访问 http://localhost:3000
```

### 方式三：GitHub Pages（仅前端）

`docs/` 目录包含了可独立部署的管理后台前端，修改 `docs/js/api-config.js` 中的 API 地址后，在仓库 Settings → Pages 中设置 Source 为 `main` 分支的 `/docs` 文件夹。

> ⚠️ GitHub Pages 仅托管前端静态文件，后端 API 仍需运行在 CloudBase 云托管上，且需要将 GitHub Pages 域名加入 `CORS_ORIGINS`。

## 安全提醒

- `.env` 文件包含真实密钥，已加入 `.gitignore`，切勿提交
- `cloudbaserc.json` 中的 `envParams` 为模板占位符，实际部署时通过 CloudBase 控制台配置
- 建议定期轮换 CloudBase 密钥
