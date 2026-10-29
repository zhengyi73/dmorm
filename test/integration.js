'use strict';

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const Sequelize = require('..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { startedAt: new Date().toISOString(), checks: [], samples: [] };
const reportPath = path.join(__dirname, 'integration-results.json');

async function check(name, run) {
  const start = Date.now();
  await run();
  report.checks.push({ name, milliseconds: Date.now() - start });
  console.log(`ok - ${name}`);
}

async function main() {
  const env = process.env;
  if (!env.DMORM_TEST_USER || env.DMORM_TEST_PASSWORD === undefined) {
    throw new Error('Set DMORM_TEST_USER and DMORM_TEST_PASSWORD for a disposable DM test database.');
  }
  const dmdb = require('dmdb');
  const host = env.DMORM_TEST_HOST || 'localhost';
  const port = Number(env.DMORM_TEST_PORT || 5236);
  const schema = env.DMORM_TEST_SCHEMA || env.DMORM_TEST_USER;
  const runName = `DMORM_TEST_${process.pid}_${Date.now()}`;
  const createInstance = pool => new Sequelize(
    env.DMORM_TEST_DATABASE || env.DMORM_TEST_USER,
    env.DMORM_TEST_USER,
    env.DMORM_TEST_PASSWORD,
    {
      dialect: 'dmdb', host, port, logging: false,
      pool: { max: 3, min: 0, acquire: 30000, idle: 1000, evict: 100, ...pool },
      dialectOptions: { schema, appName: runName }
    }
  );
  report.server = `${host}:${port}`;
  report.driverVersion = require('dmdb/package.json').version;
  report.poolMax = 3;
  report.queryCount = 0;
  report.sessionPeak = 0;
  let monitor;
  let sequelize;
  let created = false;
  let sampling = false;
  let sampler;
  let sampleError;
  let table;

  async function sample(label) {
    const result = await monitor.execute(
      'SELECT COUNT(*), COALESCE(SUM(N_USED_STMT), 0) FROM V$SESSIONS WHERE APPNAME = :1 AND CONNECTED = 1',
      [runName], { autoCommit: true, outFormat: dmdb.OUT_FORMAT_ARRAY, resultSet: false }
    );
    const [sessions, statements] = result.rows[0].map(Number);
    report.sessionPeak = Math.max(report.sessionPeak, sessions);
    assert.ok(sessions <= 3, `server has ${sessions} test sessions, exceeding pool.max=3`);
    if (label) report.samples.push({ label, sessions, statements });
    return sessions;
  }

  async function waitForZero(label) {
    const deadline = Date.now() + 5000;
    while (await sample() !== 0 && Date.now() < deadline) await delay(50);
    assert.equal(await sample(label), 0, 'test sessions were not closed on the server');
  }

  async function stopSampling() {
    sampling = false;
    if (sampler) await sampler;
    if (sampleError) throw sampleError;
  }

  try {
    monitor = await dmdb.getConnection({
      connectString: `${host}:${port}`, user: env.DMORM_TEST_USER,
      password: env.DMORM_TEST_PASSWORD, appName: `${runName}_MONITOR`, schema
    });
    await check('server session baseline', async () => assert.equal(await sample('baseline'), 0));
    sequelize = createInstance();
    table = sequelize.getQueryInterface().queryGenerator.quoteIdentifier(runName);
    const Item = sequelize.define('IntegrationItem', {
      id: { type: Sequelize.INTEGER, primaryKey: true, field: 'ID' },
      value: { type: Sequelize.STRING, field: 'VALUE' }
    }, { tableName: runName, timestamps: false });

    await check('authentication and version discovery', async () => {
      await sequelize.authenticate();
      report.databaseVersion = sequelize.options.databaseVersion;
      assert.equal(await sample('authenticated'), 1);
    });
    await sequelize.query(`CREATE TABLE ${table} ("ID" INT PRIMARY KEY, "VALUE" VARCHAR(200))`);
    created = true;
    const value = "O'Reilly [x] ? :unused $unused";
    await check('model create, findByPk and update with special characters', async () => {
      const inserted = await Item.create({ id: 1, value });
      assert.equal(inserted.id, 1);
      assert.equal((await Item.findByPk(1)).value, value);
      assert.equal((await Item.update({ value: 'updated' }, { where: { id: 1 } }))[0], 1);
      assert.equal((await Item.findByPk(1)).value, 'updated');
      await Item.create({ id: 5, value }, { bindParam: false });
      assert.equal((await Item.findByPk(5)).value, value);
    });
    await check('named, repeated and reordered binds and protected replacements', async () => {
      const [bound] = await sequelize.query('SELECT $second AS "a", $first AS "b", $second AS "c"', {
        bind: { first: 'first', second: value }, type: Sequelize.QueryTypes.SELECT
      });
      assert.deepEqual(bound, { a: value, b: 'first', c: value });
      const [positional] = await sequelize.query('SELECT $2 AS "a", $1 AS "b"', {
        bind: ['first', value], type: Sequelize.QueryTypes.SELECT
      });
      assert.deepEqual(positional, { a: value, b: 'first' });
      const [literal] = await sequelize.query("SELECT '?' AS \"q\", ? AS \"value\", ':unused' AS \"colon\"", {
        replacements: [value], type: Sequelize.QueryTypes.SELECT
      });
      assert.deepEqual(literal, { q: '?', value, colon: ':unused' });
    });
    await check('large integer precision and object row format', async () => {
      const [row] = await sequelize.query('SELECT CAST($1 AS BIGINT) AS "big"', {
        bind: ['9007199254740993'], type: Sequelize.QueryTypes.SELECT
      });
      assert.equal(String(row.big), '9007199254740993');
      const [precise] = await sequelize.query(
        'SELECT CAST($1 AS BIGINT) AS "negative", CAST($2 AS BIGINT) AS "small", CAST($3 AS DECIMAL(30,10)) AS "decimal"',
        { bind: ['-9007199254740993', '42', '1234567890123456.1234567891'], type: Sequelize.QueryTypes.SELECT }
      );
      assert.deepEqual(precise, { negative: '-9007199254740993', small: 42, decimal: '1234567890123456.1234567891' });
      const originalFormat = dmdb.outFormat;
      try {
        dmdb.outFormat = dmdb.OUT_FORMAT_OBJECT;
        assert.equal((await Item.findByPk(1)).value, 'updated');
      } finally { dmdb.outFormat = originalFormat; }
    });
    await check('2105 rows cross result-set fetch batches without losing rows', async () => {
      const rows = await sequelize.query('SELECT LEVEL AS "id" FROM DUAL CONNECT BY LEVEL <= 2105 ORDER BY LEVEL', {
        type: Sequelize.QueryTypes.SELECT
      });
      assert.equal(rows.length, 2105);
      assert.equal(Number(rows[0].id), 1);
      assert.equal(Number(rows[2104].id), 2105);
    });
    await check('transaction commit persists and invokes afterCommit', async () => {
      let committed = 0;
      await sequelize.transaction(async transaction => {
        transaction.afterCommit(() => { committed++; });
        await Item.create({ id: 2, value: 'committed' }, { transaction });
      });
      assert.equal(committed, 1);
      assert.equal((await Item.findByPk(2)).value, 'committed');
    });
    await check('transaction rollback removes changes', async () => {
      await assert.rejects(sequelize.transaction(async transaction => {
        await Item.create({ id: 3, value: 'rolled back' }, { transaction });
        throw new Error('rollback sentinel');
      }), /rollback sentinel/);
      assert.equal(await Item.findByPk(3), null);
    });
    await check('savepoint rollback preserves parent transaction', async () => {
      await sequelize.transaction(async parent => {
        const child = await sequelize.transaction({ transaction: parent });
        await Item.create({ id: 4, value: 'savepoint rollback' }, { transaction: child });
        await child.rollback();
        assert.equal(await Item.findByPk(4, { transaction: parent }), null);
      });
    });
    await check('unique constraints and query errors release connections', async () => {
      await assert.rejects(Item.create({ id: 1, value: 'duplicate' }), Sequelize.UniqueConstraintError);
      await assert.rejects(sequelize.query('SELECT DMORM_MISSING_TEST_COLUMN FROM DUAL'), Sequelize.DatabaseError);
      assert.equal(sequelize.connectionManager.pool.using, 0);
      assert.equal((await Item.findByPk(1)).value, 'updated');
    });
    await check('afterQuery hook failure releases the real connection', async () => {
      sequelize.addHook('afterQuery', 'integration-failure', () => { throw new Error('hook sentinel'); });
      try { await assert.rejects(Item.findByPk(1), /hook sentinel/); }
      finally { sequelize.removeHook('afterQuery', 'integration-failure'); }
      assert.equal(sequelize.connectionManager.pool.using, 0);
      assert.equal((await Item.findByPk(1)).value, 'updated');
    });

    await check('50 repeated SQL and constraint errors do not accumulate statement handles', async () => {
      for (let i = 0; i < 25; i++) {
        await assert.rejects(sequelize.query('SELECT DMORM_MISSING_TEST_COLUMN FROM DUAL'), Sequelize.DatabaseError);
        await assert.rejects(Item.create({ id: 1, value: 'duplicate' }), Sequelize.UniqueConstraintError);
      }
      assert.equal(sequelize.connectionManager.pool.using, 0);
      await sample('after 50 rejected queries');
      const latest = report.samples[report.samples.length - 1];
      // The driver caches at most 15 statement handles per connection by default.
      assert.ok(latest.statements <= latest.sessions * 15, `statement handles leaked: ${JSON.stringify(latest)}`);
    });
    sampling = true;
    sampler = (async () => {
      while (sampling) { await sample(); await delay(25); }
    })().catch(error => { sampleError = error; sampling = false; });
    await check('2000 model queries in 20 concurrent batches, with server session sampling', async () => {
      for (let wave = 0; wave < 20; wave++) {
        await Promise.all(Array.from({ length: 100 }, async () => {
          assert.equal((await Item.findByPk(1)).value, 'updated');
        }));
        report.queryCount += 100;
        assert.ok(sequelize.connectionManager.pool.size <= 3);
        assert.equal(sequelize.connectionManager.pool.using, 0);
        if (wave === 0 || wave === 9 || wave === 19) {
          if (global.gc) global.gc();
          report.samples.push({ label: `heap after ${report.queryCount} queries`, heapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2) });
          await sample(`batch ${wave + 1}`);
        }
      }
    });
    await check('idle eviction closes all real connections', async () => {
      await waitForZero('after idle eviction');
      assert.equal(sequelize.connectionManager.pool.size, 0);
      assert.equal((await Item.findByPk(1)).value, 'updated');
    });
    await check('model destroy returns affected row count', async () => {
      assert.equal(await Item.destroy({ where: { id: 1 } }), 1);
    });
    await sequelize.query(`DROP TABLE ${table}`);
    created = false;
    await sequelize.close();
    sequelize = null;
    await check('sequelize.close leaves no test sessions or test table', async () => {
      await waitForZero('after primary instance close');
      const result = await monitor.execute('SELECT COUNT(*) FROM ALL_TABLES WHERE OWNER = :1 AND TABLE_NAME = :2', [schema, runName]);
      assert.equal(Number(result.rows[0][0]), 0);
    });
    await check('300 queries recycle physical connections with maxUses=10', async () => {
      const recycled = createInstance({ maxUses: 10 });
      let createdConnections = 0;
      recycled.addHook('afterConnect', () => { createdConnections++; });
      try {
        await Promise.all(Array.from({ length: 300 }, () => recycled.query('SELECT 1')));
        report.queryCount += 300;
        assert.equal(recycled.connectionManager.pool.using, 0);
        assert.ok(createdConnections >= 30);
        report.recycledConnectionsCreated = createdConnections;
        await sample('after maxUses recycling');
      } finally { await recycled.close(); }
      await waitForZero('after recycled instance close');
    });
    await check('five instance creation/shutdown cycles leave zero sessions', async () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        const instance = createInstance();
        try {
          await Promise.all(Array.from({ length: 100 }, () => instance.query('SELECT 1')));
          report.queryCount += 100;
        } finally { await instance.close(); }
        await waitForZero(`after shutdown cycle ${cycle + 1}`);
      }
    });
    await stopSampling();
    report.status = 'passed';
    console.log(`DM integration passed: ${report.checks.length} checks; ${report.queryCount} stress queries; server session peak ${report.sessionPeak}, final 0.`);
  } finally {
    sampling = false;
    if (sampler) await sampler;
    try {
      if (sequelize) {
        try { if (created) await sequelize.query(`DROP TABLE ${table}`); }
        finally { await sequelize.close(); }
      }
    } finally {
      if (monitor) await monitor.close();
    }
  }
}

main().catch(error => {
  report.status = 'failed';
  report.error = { message: error.message, sql: error.sql };
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${reportPath}`);
});
