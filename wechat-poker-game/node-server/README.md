# Node 大陆部署版

这一目录是与 `cloudflare/` 并存的 Node.js 服务版本。它保留现有网页 UI 和游戏规则，使用 WebSocket 同步房间状态，并将账号资料与每个账号最近 5 局的回放记录写入 MySQL。

## 本机准备

1. 安装 Node.js 20+ 与 MySQL 8。
2. 创建数据库和账号后导入 `schema.sql`：

```sql
CREATE USER 'poker_user'@'127.0.0.1' IDENTIFIED BY '请替换为强密码';
GRANT ALL PRIVILEGES ON four_player_poker.* TO 'poker_user'@'127.0.0.1';
FLUSH PRIVILEGES;
```

3. 复制环境变量文件并填写数据库密码：

```bash
cp .env.example .env
npm install
set -a && . ./.env && set +a
npm start
```

Windows PowerShell 可用：

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^([^#=]+)=(.*)$') { Set-Item -Path "Env:$($matches[1])" -Value $matches[2] }
}
npm start
```

访问 `http://127.0.0.1:3000`。生产服务默认监听 `0.0.0.0`，可供 Nginx 反向代理。

## Docker

复制 `.env.example` 为 `.env` 后，分别填写 `MYSQL_PASSWORD` 与 `MYSQL_ROOT_PASSWORD` 两个强密码。Docker Compose 会自动让应用连接到内部的 `mysql` 服务，无需手动修改主机名。

随后运行：

```bash
docker compose -f node-server/docker-compose.yml up -d --build
```

## 腾讯云上线

1. 购买位于中国大陆的腾讯云轻量应用服务器或 CVM，安装 Docker 与 Docker Compose。
2. 使用自己的域名完成 ICP 备案；备案完成后，在域名 DNS 中将 A 记录指向服务器公网 IP。
3. 将仓库克隆到服务器，填写 `node-server/.env`，再运行 Docker Compose。
4. 将 `node-server/nginx.conf` 复制到 Nginx 站点配置，替换 `server_name example.com` 为你的域名，启用 HTTPS 证书。
5. 在腾讯云安全组中仅开放 `80`、`443`；不要将 MySQL 的 `3306` 端口对公网开放。

Nginx 配置已包括 `/api/rooms/:roomCode/ws` 的升级头，不能删除，否则实时房间无法同步。

## 数据与扩容

- 账号、昵称唯一性、资料锁定和最多 5 局回放记录由 MySQL 保存。
- 进行中的房间保留在当前 Node 进程内。单机好友房部署应只运行一个 `app` 实例；若要水平扩容，需要将房间状态和 WebSocket 广播迁至 Redis（例如 Socket.IO Redis Adapter）或专门的实时房间服务。
- `.env`、数据库卷和用户上传头像数据属于私密数据，不要提交到 Git 仓库。
