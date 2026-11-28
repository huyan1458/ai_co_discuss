# 中转休眠回归检查 / Relay hibernation check

从仓库根目录分别在两个终端运行以下命令。Run these commands in separate terminals from the repository root.

```sh
npx wrangler dev --local --ip 127.0.0.1 --port 8799 --config scripts/relay_hibernation_repro/wrangler.jsonc
```

```sh
node scripts/relay_hibernation_repro/client.mjs
```

预期依次输出 A、B、B、B。后两次检查各间隔 15 秒，至少一次应显示新的对象实例编号。客户端成功退出后用 Ctrl+C 停止 Wrangler。

Expect A, B, B, B. Each of the last two checks follows 15 seconds of inactivity. At least one must show a new object instance ID. Stop Wrangler with Ctrl+C when the client exits.
