# file-proxy

Windows 上的 IIS 文件版本管理系统：绑定站点工作目录，上传 zip 发布（自动备份旧版）、在线编辑、版本历史/对比/回滚，多站点、审计日志、发布互斥、旧版自动清理。

## 运行

支持 Node 20+（Node 22+ 用内建 `node:sqlite`，Node 20 回退纯 WASM 驱动，两端均无原生编译依赖）。

```bash
npm install
npm start          # 默认 http://localhost:3000
```

默认账号 `admin` / `admin123`，通过环境变量 `ADMIN_USER`、`ADMIN_PASS`、`SESSION_SECRET`、`PORT` 覆盖。

## pm2 部署（Windows）

```bash
npm i -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # 开机自启提示按输出执行
```

`ecosystem.config.js` 中的 `SESSION_SECRET`、`ADMIN_PASS` 生产环境务必改掉。

## 功能

- 绑定/解绑多个 IIS 站点目录，展示文件数与总大小
- 目录浏览 + 文本文件在线编辑（2MB 上限，防目录穿越）
- 上传 zip 发布：当前文件先打包为旧版快照 → 解压替换 → 记录新版本
- 版本历史：清单/文件数/操作人，快照 zip 可下载
- 版本对比：任选两版，输出新增/修改/删除（sha256 判定）
- 一键回滚（回滚前同样备份当前）
- 站点级发布互斥锁（并发返回 409）
- 排除规则（glob，如 `*.log`、`node_modules`）；保留 N 个版本自动清理
- 审计日志：登录/绑定/编辑/发布/回滚/清理

## 测试

启动服务后另开终端：

```bash
npm test           # node test/e2e.js，60 项端到端断言
```

## 结构

```
src/server.js              入口 + 路由挂载
src/db.js                  数据驱动切换（node:sqlite / node-sqlite3-wasm）+ 建表 + 管理员初始化
src/services/              archive/version/publish/file/site/audit
src/routes/                auth/sites/files/publish/versions/audit
public/                    前端 SPA（Vue3 CDN，无构建）
data/snapshots/<siteId>/   版本快照 zip
```

## 说明

- 支持 Node 20+：Node 22+ 用内建 `node:sqlite`，Node 20 自动回退纯 WASM 的 `node-sqlite3-wasm`，均无原生编译依赖；日志模式统一 DELETE（WASM 不支持 WAL）。
- 替换采用"先快照、临时目录解压、再覆盖"，失败时现有文件不受损坏。
- 发布/回滚期间站点锁定，界面显示"发布中"。