由于时间的关系，只能在sequelize的基础上扩展


使用方式和sequelize一样

由于是自己使用，可以学习使用，请勿在项目中使用

联系方式：
vx: gf778800

## 连接和测试

运行时需另行安装达梦驱动：`npm install dmdb`。通过 `pool.max` / `pool.min` / `pool.idle` 配置 ORM 连接池；不要在连接钩子中另建驱动连接池。`dialectOptions` 会传给达梦驱动，可在其中设置 `schema`、`connectString` 等属性。使用完实例后调用 `await sequelize.close()`。

`npm test` 运行无需数据库的回归测试。真实达梦集成验证使用 `npm run test:integration`，运行前设置 `DMORM_TEST_USER`、`DMORM_TEST_PASSWORD`，可选设置 `DMORM_TEST_HOST`、`DMORM_TEST_PORT`、`DMORM_TEST_SCHEMA`、`DMORM_TEST_DATABASE`。请使用有建表权限的测试库；脚本会创建并清理独有名称的测试表。

修复详情、测试边界以及尚未完成的达梦兼容性适配见 [REVIEW.md](./REVIEW.md)。

真实测试会通过独有的 APPNAME 标记连接，检查服务器会话和语句句柄，执行 2,800 次压力查询、50 次错误查询及 2,105 行结果集读取；结果写入本地 `test/integration-results.json`，不保存数据库密码。BIGINT 超出安全整数范围及 DECIMAL 返回字符串，以保留精度。
