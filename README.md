# Minechat API (NodeJS + Express)

后端 API 网关，支持 Microsoft 登录并获取 Minecraft 用户名（用于用户名），实现单聊与群聊、消息类型（文字、文件、图片、视频、表情包、坐标控件、用户控件）、消息撤回（软删除）、已读与引用回复。

快速启动

1. 复制 `.env.example` 为 `.env` 并填写 `MICROSOFT_CLIENT_ID` 与 MySQL 配置。
2. 安装依赖：

```bash
npm install
```

3. 启动开发模式：

```bash
npm run dev
```

主要端点（概要）
- `GET /auth/microsoft` -> 重定向到 Microsoft 登录
- `GET /auth/callback?code=...` -> 授权回调，返回 JWT
- `GET /me` -> 当前用户信息（需 Authorization: Bearer <token>）
- `POST /chats` -> 创建群聊（body: {name, members})
- `GET /chats` -> 列出当前用户的会话
- `POST /chats/:id/messages` -> 发送消息（支持 multipart/form-data 上传文件）
- `POST /messages/:id/recall` -> 撤回（软删除）消息
- `POST /messages/:id/read` -> 标记已读

说明

该服务使用 MySQL 作为唯一持久化存储。请在 `.env` 中设置以下变量：

- `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DATABASE`

程序启动时会尝试连接指定的 MySQL 并自动创建必要表格（需要具有建表权限）。

`npm install` 会自动安装 `package.json` 中列出的依赖（包括 `mysql2`）。

详细说明请参阅代码与注释。
# Minechat API (NodeJS + Express)

后端 API 网关，支持 Microsoft 登录并获取 Minecraft 用户名（用于用户名），实现单聊与群聊、消息类型（文字、文件、图片、视频、表情包、坐标控件、用户控件）、消息撤回（软删除）、已读与引用回复。

快速启动

1. 复制 `.env.example` 为 `.env` 并填写 `MICROSOFT_CLIENT_ID` 等项。
2. 安装依赖：

```bash
npm install
```

3. 启动开发模式：

```bash
npm run dev
```
MySQL

如果希望使用 MySQL 存储（替代默认的 lowdb JSON 存储），在 `.env` 中设置 `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`。程序在启动时会尝试连接并自动创建必要的表格（如果有权限）。

```markdown
# Minechat API (NodeJS + Express)

后端 API 网关，支持 Microsoft 登录并获取 Minecraft 用户名（用于用户名），实现单聊与群聊、消息类型（文字、文件、图片、视频、表情包、坐标控件、用户控件）、消息撤回（软删除）、已读与引用回复。

快速启动

1. 复制 `.env.example` 为 `.env` 并填写 `MICROSOFT_CLIENT_ID` 与 MySQL 配置。
2. 安装依赖：

```bash
npm install
```

3. 启动开发模式：

```bash
npm run dev
```

主要端点（概要）
- `GET /auth/microsoft` -> 重定向到 Microsoft 登录
- `GET /auth/callback?code=...` -> 授权回调，返回 JWT
- `GET /me` -> 当前用户信息（需 Authorization: Bearer <token>）
- `POST /chats` -> 创建群聊（body: {name, members})
- `GET /chats` -> 列出当前用户的会话
- `POST /chats/:id/messages` -> 发送消息（支持 multipart/form-data 上传文件）
- `POST /messages/:id/recall` -> 撤回（软删除）消息
- `POST /messages/:id/read` -> 标记已读

说明

该服务使用 MySQL 作为唯一持久化存储。请在 `.env` 中设置以下变量：

- `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DATABASE`

程序启动时会尝试连接指定的 MySQL 并自动创建必要表格（需要具有建表权限）。

记得安装 MySQL 驱动（已在说明中）：

```bash
npm install mysql2
```

详细说明请参阅代码与注释。

```
