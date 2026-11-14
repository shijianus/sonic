# Sonic 公测前测试证据

当前最终本地测试记录见 [LOCAL-PUBLIC-BETA-TEST-REPORT.md](../testing/LOCAL-PUBLIC-BETA-TEST-REPORT.md)。

压力脚本只允许访问 `127.0.0.1`，自动启动本地 Engine，覆盖发布身份、health 鉴权、synthetic 搜索、音频 200/206/416/404、取消、SQLite 隔离和并发压力。

公测前仍需独立完成真实 OAuth、获准音源逐源播放、浏览器解码、真机、Cloudflare 绑定和公网部署前置检查。
