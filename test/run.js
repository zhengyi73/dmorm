'use strict';

const assert = require('assert').strict;
const { EventEmitter } = require('events');
const Sequelize = require('..');
const Query = require('../src/lib/dialects/dmdb/query');
const SqlString = require('../src/lib/sql-string');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(options = {}, execute) {
  const state = { active: 0, peak: 0, connections: [], calls: [], configs: [] };
  const driver = {
    STRING: 2001,
    createPool() { throw new Error('The ORM must not create hidden driver pools'); },
    async getConnection(config) {
      state.configs.push(config);
      const connection = new EventEmitter();
      connection.closed = false;
      state.connections.push(connection);
      state.peak = Math.max(state.peak, ++state.active);
      connection.execute = async (sql, binds, executeOptions) => {
        assert.equal(connection.closed, false, 'a closed connection was reused');
        state.calls.push({ connection, sql, binds, options: executeOptions });
        if (execute) return execute(sql, binds, executeOptions, connection);
        if (/id_code/i.test(sql)) return { rows: [['8.1.3']], metaData: [{ name: 'ID_CODE' }] };
        if (/^select/i.test(sql)) return { rows: [[1]], metaData: [{ name: 'value' }] };
        return { rowsAffected: 1 };
      };
      connection.close = async () => {
        assert.equal(connection.closed, false, 'connection closed twice');
        connection.closed = true;
        state.active--;
      };
      return connection;
    }
  };
  const sequelize = new Sequelize('APP', 'user', 'p@ss:?&word', {
    dialect: 'dmdb', dialectModule: driver, databaseVersion: '8.1.3',
    logging: false, pool: { max: 3, min: 0, idle: 50, evict: 10, acquire: 300 },
    ...options
  });
  return { sequelize, state, driver };
}

async function withFixture(options, fn, execute) {
  const f = fixture(options, execute);
  try { await fn(f); } finally { await f.sequelize.close(); }
  assert.equal(f.state.active, 0, 'all physical connections must be closed');
}

test('package entry loads and reports its version', () => {
  assert.equal(Sequelize.version, require('../package.json').version);
});

test('1000 concurrent queries obey pool.max and release every connection', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    await Promise.all(Array.from({ length: 1000 }, () => sequelize.query('SELECT 1')));
    assert.ok(state.peak <= 3);
    assert.equal(sequelize.connectionManager.pool.using, 0);
    assert.equal(sequelize.connectionManager.pool.waiting, 0);
    assert.equal(state.connections.length, 3);
  });
});

test('connection recycling does not accumulate physical connections', async () => {
  await withFixture({ pool: { max: 2, min: 0, maxUses: 2 } }, async ({ sequelize, state }) => {
    for (let i = 0; i < 100; i++) await sequelize.query('SELECT 1');
    assert.ok(state.connections.length >= 50);
    assert.ok(state.peak <= 2);
    assert.ok(state.active <= 2);
  });
});

test('idle connections are physically closed', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1');
    const deadline = Date.now() + 1000;
    while (state.active && Date.now() < deadline) await delay(20);
    assert.equal(state.active, 0);
  });
});

test('credentials are passed separately and dialect options reach the driver', async () => {
  await withFixture({ dialectOptions: { connectString: 'cluster', loginEncrypt: false, schema: 'APP' } }, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1');
    assert.deepEqual(state.configs[0], {
      user: 'user', password: 'p@ss:?&word', connectString: 'cluster', loginEncrypt: false, schema: 'APP'
    });
  });
});

test('connectionString alias and default endpoint are supported', async () => {
  await withFixture({ dialectOptions: { connectionString: 'standby:5237' } }, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1');
    assert.equal(state.configs[0].connectString, 'standby:5237');
  });
  await withFixture({}, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1');
    assert.equal(state.configs[0].connectString, 'localhost:5236');
  });
});

test('closed and errored connections are replaced without crashing', async () => {
  await withFixture({ pool: { max: 1, min: 0 } }, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1');
    const first = state.connections[0];
    first.emit('error', new Error('socket lost'));
    await sequelize.query('SELECT 1');
    assert.equal(first.closed, true);
    assert.equal(state.connections.length, 2);
    const second = state.connections[1];
    await second.close();
    await sequelize.query('SELECT 1');
    assert.equal(state.connections.length, 3);
  });
});

test('version discovery shares one probe and returns a scalar', async () => {
  await withFixture({ databaseVersion: 0 }, async ({ sequelize, state }) => {
    await Promise.all(Array.from({ length: 30 }, () => sequelize.query('SELECT 1')));
    assert.equal(state.calls.filter(call => /id_code/.test(call.sql)).length, 1);
    assert.equal(sequelize.options.databaseVersion, '8.1.3');
    assert.equal(state.connections[0].closed, true);
  });
});

test('failed version probes close connections and can retry', async () => {
  let attempts = 0;
  await withFixture({ databaseVersion: 0 }, async ({ sequelize, state }) => {
    await assert.rejects(sequelize.query('SELECT 1'), /probe failed/);
    assert.equal(state.active, 0);
    assert.equal(sequelize.connectionManager.versionPromise, null);
    await sequelize.query('SELECT 1');
    assert.equal(sequelize.options.databaseVersion, '8.1.3');
  }, async sql => {
    if (/id_code/.test(sql) && ++attempts === 1) throw new Error('probe failed');
    return { rows: [['8.1.3']], metaData: [{ name: 'value' }] };
  });
});

for (const hook of ['beforeQuery', 'afterQuery']) {
  test(`${hook} failure returns the acquired connection`, async () => {
    await withFixture({}, async ({ sequelize }) => {
      sequelize.addHook(hook, 'failure', () => { throw new Error('hook failed'); });
      await assert.rejects(sequelize.query('SELECT 1'), /hook failed/);
      assert.equal(sequelize.connectionManager.pool.using, 0);
      sequelize.removeHook(hook, 'failure');
      await sequelize.query('SELECT 1');
    });
  });
}

test('query constructor failure also releases the connection', async () => {
  await withFixture({}, async ({ sequelize }) => {
    sequelize.dialect.Query = class extends Query {
      constructor(...args) { super(...args); throw new Error('constructor failed'); }
    };
    await assert.rejects(sequelize.query('SELECT 1'), /constructor failed/);
    assert.equal(sequelize.connectionManager.pool.using, 0);
  });
});

test('afterConnect failure closes the connection before pool ownership', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    sequelize.addHook('afterConnect', () => { throw new Error('afterConnect failed'); });
    await assert.rejects(sequelize.query('SELECT 1'), /afterConnect failed/);
    assert.equal(state.active, 0);
  });
});

test('beforeDisconnect failure still closes physical connections', async () => {
  const { sequelize, state } = fixture();
  await sequelize.query('SELECT 1');
  sequelize.addHook('beforeDisconnect', () => { throw new Error('beforeDisconnect failed'); });
  await assert.rejects(sequelize.close());
  assert.equal(state.active, 0);
});

test('driver connection errors retain ORM error types', async () => {
  await withFixture({}, async ({ sequelize, driver }) => {
    driver.getConnection = async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
    await assert.rejects(sequelize.query('SELECT 1'), Sequelize.ConnectionRefusedError);
  });
});

test('bind parameters follow placeholder order, including repeated names', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    await sequelize.query('SELECT $2, $1, $2', { bind: ['first', 'second'] });
    assert.equal(state.calls[0].sql, 'SELECT :1, :2, :3');
    assert.deepEqual(state.calls[0].binds, ['second', 'first', 'second']);
    await sequelize.query('SELECT $b, $a, $b', { bind: { a: 10, b: null } });
    assert.deepEqual(state.calls[1].binds, [null, 10, null]);
  });
});

test('bind substitution preserves SQL literals, identifiers and comments', () => {
  const sql = `SELECT '$missing', "col$missing", [col$missing], $a, $$ -- $missing\n/* $missing */`;
  const [formatted, binds] = Query.formatBindParameters(sql, { a: 42 }, 'dmdb');
  assert.equal(formatted, `SELECT '$missing', "col$missing", [col$missing], :1, $ -- $missing\n/* $missing */`);
  assert.deepEqual(binds, [42]);
  assert.throws(() => Query.formatBindParameters('SELECT $missing', {}, 'dmdb'), /no value/);
  assert.throws(() => Query.formatBindParameters('SELECT $toString', {}, 'dmdb'), /no value/);
});

test('replacements preserve quoted question marks, colons and comments', () => {
  assert.equal(SqlString.format("SELECT '?', ?, '?' -- ?", ["O'Reilly"], null, 'dmdb'), "SELECT '?', 'O''Reilly', '?' -- ?");
  assert.equal(SqlString.formatNamedParameters("SELECT ':unused', :a /* :unused */", { a: 7 }, null, 'dmdb'), "SELECT ':unused', 7 /* :unused */");
  assert.throws(() => SqlString.format('SELECT ?, ?', [1], null, 'dmdb'), /Not enough/);
  assert.throws(() => SqlString.formatNamedParameters('SELECT :toString', {}, null, 'dmdb'), /no value/);
});

test('raw SQL is not rewritten, including bracket characters in values', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    await sequelize.query("SELECT '[abc]', 'a]b[c' FROM DUAL");
    assert.equal(state.calls[0].sql, "SELECT '[abc]', 'a]b[c' FROM DUAL");
  });
});

test('identifiers retain their characters and escape embedded double quotes', async () => {
  await withFixture({}, async ({ sequelize }) => {
    const q = sequelize.dialect.queryGenerator;
    assert.equal(q.quoteIdentifier('a"b[\'c]'), '"a""b[\'c]"');
    assert.equal(q.selectQuery('Table', { attributes: ['Column'] }), 'SELECT "Column" FROM "Table";');
  });
});

test('metadata queries and JSON conditions escape string values', async () => {
  await withFixture({}, async ({ sequelize }) => {
    const q = sequelize.dialect.queryGenerator;
    const value = "x' OR 1=1 --";
    const escaped = sequelize.escape(value);
    for (const sql of [
      q.describeTableQuery(value), q.showIndexesQuery(value),
      q.showConstraintsQuery(value), q.getForeignKeysQuery(value, value),
      q.getForeignKeyQuery({ tableName: value, schema: value }, value),
      q.handleSequelizeMethod(Sequelize.json({ payload: value }))
    ]) {
      assert.ok(sql.includes(escaped), sql);
      assert.ok(!sql.includes("= 'x' OR"), sql);
    }
    assert.ok(q.handleSequelizeMethod(Sequelize.json('payload', false)).includes('false'));
  });
});

test('raw query metadata and rowsAffected survive formatting', async () => {
  const metadata = { rowsAffected: 4, outBinds: [10] };
  await withFixture({}, async ({ sequelize }) => {
    const [rows, result] = await sequelize.query('UPDATE T SET A=1');
    assert.deepEqual(rows, []);
    assert.equal(result, metadata);
    assert.equal(await sequelize.query('DELETE FROM T', { type: Sequelize.QueryTypes.BULKDELETE }), 4);
    assert.equal(await sequelize.query('UPDATE T SET A=1', { type: Sequelize.QueryTypes.BULKUPDATE }), 4);
    assert.deepEqual(await sequelize.query('UPDATE T SET A=1', { type: Sequelize.QueryTypes.UPDATE }), [undefined, 4]);
  }, async () => metadata);
});

test('large integers retain precision in both array and object row formats', async () => {
  for (const row of [[9007199254740993n, 42n, -9007199254740993n], { big: 9007199254740993n, small: 42n, negative: -9007199254740993n }]) {
    await withFixture({}, async ({ sequelize }) => {
      const rows = await sequelize.query('SELECT 1', { type: Sequelize.QueryTypes.SELECT });
      assert.deepEqual(rows, [{ big: '9007199254740993', small: 42, negative: '-9007199254740993' }]);
    }, async () => ({ rows: [row], metaData: ['big', 'small', 'negative'].map(name => ({ name })) }));
  }
});

test('BIGINT and DECIMAL are fetched losslessly before driver Number conversion', async () => {
  let closed = 0;
  let fetched = false;
  await withFixture({}, async ({ sequelize }) => {
    const rows = await sequelize.query('SELECT 1', { type: Sequelize.QueryTypes.SELECT });
    assert.deepEqual(rows, [{ big: '9007199254740993', small: 42, decimal: '1234567890123456.7890', text: 'unchanged' }]);
    assert.equal(closed, 1);
  }, async (sql, binds, options) => {
    assert.equal(options.resultSet, true);
    assert.equal(options.extendedMetaData, true);
    return {
      metaData: [
        { name: 'big', dbType: 8 }, { name: 'small', dbTypeName: 'BIGINT' },
        { name: 'decimal', dbType: 9 }, { name: 'text', dbTypeName: 'VARCHAR' }
      ],
      resultSet: {
        async getRows() {
          assert.equal(options.fetchInfo.big.type, 2001);
          assert.equal(options.fetchInfo.small.type, 2001);
          assert.equal(options.fetchInfo.decimal.type, 2001);
          assert.equal(options.fetchInfo.text, undefined);
          if (fetched) return [];
          fetched = true;
          return [['9007199254740993', '42', '1234567890123456.7890', 'unchanged']];
        },
        async close() { closed++; }
      }
    };
  });
});

test('result sets are closed when fetching fails', async () => {
  let closed = 0;
  await withFixture({}, async ({ sequelize }) => {
    await assert.rejects(sequelize.query('SELECT 1'), /fetch failed/);
    assert.equal(closed, 1);
    assert.equal(sequelize.connectionManager.pool.using, 0);
  }, async () => ({
    metaData: [], resultSet: {
      async getRows() { throw new Error('fetch failed'); },
      async close() { closed++; }
    }
  }));
});

test('failed result set close invalidates the connection', async () => {
  let first = true;
  await withFixture({}, async ({ sequelize, state }) => {
    await assert.rejects(sequelize.query('SELECT 1'), /cursor close failed/);
    await sequelize.query('SELECT 1');
    assert.equal(state.connections.length, 2);
    assert.equal(state.connections[0].closed, true);
  }, async () => {
    if (!first) return { rows: [], metaData: [] };
    first = false;
    return { metaData: [], resultSet: {
      async getRows() { return []; }, async close() { throw new Error('cursor close failed'); }
    } };
  });
});

test('all implicit cursors are closed even if an earlier fetch fails', async () => {
  let closed = 0;
  await withFixture({}, async ({ sequelize }) => {
    await assert.rejects(sequelize.query('CALL P()'), /fetch failed/);
    assert.equal(closed, 2);
  }, async () => ({ implicitResults: [
    { async getRows() { throw new Error('fetch failed'); }, async close() { closed++; } },
    { async getRows() { return []; }, async close() { closed++; } }
  ] }));
});

test('an explicitly supplied primary key is not overwritten by missing insertId', async () => {
  await withFixture({}, async ({ sequelize }) => {
    const Item = sequelize.define('Item', { id: { type: Sequelize.INTEGER, primaryKey: true } }, { timestamps: false });
    const item = await Item.create({ id: 42 });
    assert.equal(item.id, 42);
  });
});

test('model WHERE clauses quote aliases once', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    const Item = sequelize.define('Item', { id: { type: Sequelize.INTEGER, primaryKey: true } }, { timestamps: false });
    await Item.findByPk(1);
    assert.ok(state.calls[0].sql.includes('WHERE "Item"."id" = 1'));
    assert.ok(!state.calls[0].sql.includes('"""'));
  });
});

test('model inserts pass all generated parameters to the driver unchanged', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    const Item = sequelize.define('Item', {
      id: { type: Sequelize.INTEGER, primaryKey: true }, value: Sequelize.STRING
    }, { timestamps: false });
    const value = "O'Reilly [x] ? :unused $unused";
    await Item.create({ id: 7, value });
    assert.deepEqual(state.calls[0].binds, [7, value]);
    assert.ok(state.calls[0].sql.includes('VALUES (:1,:2)'));
    await Item.create({ id: 8, value }, { bindParam: false });
    assert.deepEqual(state.calls[1].binds, []);
    assert.ok(state.calls[1].sql.includes("O''Reilly [x] ? :unused $unused"));
  });
});

test('model update and delete return the driver affected-row count', async () => {
  await withFixture({}, async ({ sequelize }) => {
    const Item = sequelize.define('Item', { id: { type: Sequelize.INTEGER, primaryKey: true } }, { timestamps: false });
    assert.deepEqual(await Item.update({ id: 2 }, { where: { id: 1 } }), [1]);
    assert.equal(await Item.destroy({ where: { id: 2 } }), 1);
  });
});

test('DM error codes map to unique and foreign key constraint errors', async () => {
  for (const [errCode, ErrorClass] of [[-6602, Sequelize.UniqueConstraintError], [-6607, Sequelize.ForeignKeyConstraintError]]) {
    await withFixture({}, async ({ sequelize }) => {
      await assert.rejects(sequelize.query('SELECT $a', { bind: { a: 1 } }), error => {
        assert.ok(error instanceof ErrorClass);
        assert.equal(error.parent.errCode, errCode);
        assert.deepEqual(error.parameters, [1]);
        return true;
      });
      assert.equal(sequelize.connectionManager.pool.using, 0);
    }, async () => { throw Object.assign(new Error('constraint violation'), { errCode }); });
  }
});

test('every failed driver execution retires its connection on release', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    for (let i = 0; i < 10; i++) {
      await assert.rejects(sequelize.query('SELECT 1'), /SQL failed/);
      assert.equal(state.active, 0);
      assert.equal(sequelize.connectionManager.pool.size, 0);
    }
    assert.equal(state.connections.length, 10);
  }, async () => { throw new Error('SQL failed'); });
});

test('caught query errors retire transaction connections after cleanup', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    const transaction = await sequelize.transaction();
    await assert.rejects(sequelize.query('SELECT FAIL', { transaction }), /SQL failed/);
    assert.equal(state.active, 1);
    await sequelize.query('SELECT 1', { transaction });
    await transaction.rollback();
    assert.equal(state.active, 0);
    assert.equal(sequelize.connectionManager.pool.size, 0);
  }, async sql => {
    if (sql === 'SELECT FAIL') throw new Error('SQL failed');
    return {};
  });
});

test('fatal query errors prevent the connection from being reused', async () => {
  let first = true;
  await withFixture({}, async ({ sequelize, state }) => {
    await assert.rejects(sequelize.query('SELECT 1'), /fatal/);
    await sequelize.query('SELECT 1');
    assert.equal(state.connections.length, 2);
    assert.equal(state.connections[0].closed, true);
  }, async () => {
    if (first) { first = false; throw Object.assign(new Error('fatal'), { fatal: true }); }
    return { rows: [], metaData: [] };
  });
});

test('managed transactions disable auto-commit and release after commit', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    let committed = 0;
    await sequelize.transaction(async transaction => {
      transaction.afterCommit(() => { committed++; });
      await sequelize.query('UPDATE T SET A=1', { transaction });
    });
    assert.equal(committed, 1);
    assert.equal(state.calls.length, 2);
    assert.ok(state.calls.every(call => call.options.autoCommit === false));
    assert.equal(state.calls[1].sql, 'COMMIT;');
    assert.equal(sequelize.connectionManager.pool.using, 0);
    await sequelize.query('SELECT 1');
    assert.equal(state.calls[2].options.autoCommit, true);
  });
});

test('managed transaction errors roll back without calling afterCommit', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    let committed = false;
    await assert.rejects(sequelize.transaction(async transaction => {
      transaction.afterCommit(() => { committed = true; });
      await sequelize.query('UPDATE T SET A=1', { transaction });
      throw new Error('abort');
    }), /abort/);
    assert.equal(committed, false);
    assert.equal(state.calls[1].sql, 'ROLLBACK;');
    assert.equal(sequelize.connectionManager.pool.using, 0);
  });
});

for (const operation of ['commit', 'rollback']) {
  test(`failed ${operation} destroys the uncertain connection`, async () => {
    await withFixture({}, async ({ sequelize, state }) => {
      const transaction = await sequelize.transaction();
      let committed = false;
      transaction.afterCommit(() => { committed = true; });
      await assert.rejects(transaction[operation](), /transaction failed/);
      assert.equal(committed, false);
      assert.equal(transaction.finished, operation);
      assert.equal(state.active, 0);
      assert.equal(sequelize.connectionManager.pool.using, 0);
      await assert.rejects(sequelize.query('SELECT 1', { transaction }), /can no longer use/);
    }, async () => { throw new Error('transaction failed'); });
  });
}

test('commit awaits asynchronous connection release before resolving', async () => {
  await withFixture({}, async ({ sequelize }) => {
    let released = false;
    const manager = sequelize.connectionManager;
    const release = manager.releaseConnection.bind(manager);
    manager.releaseConnection = async connection => {
      await delay(10);
      await release(connection);
      released = true;
    };
    const transaction = await sequelize.transaction();
    await transaction.commit();
    assert.equal(released, true);
    await transaction.cleanup();
    assert.equal(manager.pool.using, 0);
  });
});

test('nested transactions use savepoints without releasing the parent connection', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    const parent = await sequelize.transaction();
    const child = await sequelize.transaction({ transaction: parent });
    await child.rollback();
    assert.equal(sequelize.connectionManager.pool.using, 1);
    assert.ok(state.calls[0].sql.startsWith('SAVEPOINT "'));
    assert.ok(state.calls[1].sql.startsWith('ROLLBACK TO SAVEPOINT "'));
    await parent.commit();
    assert.equal(sequelize.connectionManager.pool.using, 0);
  });
});

test('savepoint rollback failures invalidate and close the parent transaction', async () => {
  await withFixture({}, async ({ sequelize, state }) => {
    const parent = await sequelize.transaction();
    const child = await sequelize.transaction({ transaction: parent });
    await assert.rejects(child.rollback(), /savepoint failed/);
    assert.equal(state.active, 0);
    assert.equal(parent.finished, 'rollback');
    await assert.rejects(sequelize.query('SELECT 1', { transaction: parent }), /can no longer use/);
  }, async sql => {
    if (/ROLLBACK TO/.test(sql)) throw new Error('savepoint failed');
    return {};
  });
});

test('nested cleanup restores the parent in CLS', async () => {
  const context = new Map();
  Sequelize._cls = { get: key => context.get(key), set: (key, value) => context.set(key, value) };
  try {
    await withFixture({}, async ({ sequelize }) => {
      const parent = new Sequelize.Transaction(sequelize, {});
      await parent.prepareEnvironment();
      const child = new Sequelize.Transaction(sequelize, { transaction: parent });
      await child.prepareEnvironment();
      assert.equal(context.get('transaction'), child);
      await child.commit();
      assert.equal(context.get('transaction'), parent);
      await parent.commit();
      assert.equal(context.get('transaction'), null);
    });
  } finally { Sequelize._cls = undefined; }
});

test('failed transaction setup returns the connection', async () => {
  await withFixture({}, async ({ sequelize }) => {
    await assert.rejects(sequelize.transaction({ isolationLevel: 'READ COMMITTED' }), /setup failed/);
    assert.equal(sequelize.connectionManager.pool.using, 0);
  }, async sql => {
    if (/ISOLATION/.test(sql)) throw new Error('setup failed');
    return {};
  });
});

test('pool acquisition times out without creating connections beyond the limit', async () => {
  await withFixture({ pool: { max: 1, min: 0, acquire: 30 } }, async ({ sequelize, state }) => {
    const transaction = await sequelize.transaction();
    await assert.rejects(sequelize.query('SELECT 1'), Sequelize.ConnectionAcquireTimeoutError);
    assert.equal(state.connections.length, 1);
    await transaction.rollback();
    await sequelize.query('SELECT 1');
  });
});

test('read replicas and master connections retain separate bounded pools', async () => {
  await withFixture({ replication: { read: [{ host: 'replica' }], write: { host: 'master' } } }, async ({ sequelize, state }) => {
    await sequelize.query('SELECT 1', { type: Sequelize.QueryTypes.SELECT });
    await sequelize.query('SELECT 1', { type: Sequelize.QueryTypes.SELECT, useMaster: true });
    assert.deepEqual(state.configs.map(config => config.connectString), ['replica:5236', 'master:5236']);
    const connection = await sequelize.connectionManager.getConnection({ type: 'SELECT' });
    await sequelize.connectionManager.destroyConnection(connection);
    assert.equal(connection.closed, true);
  });
});

test('logging:false suppresses development output during model operations and errors', async () => {
  const messages = [];
  const original = console.log;
  console.log = (...args) => messages.push(args);
  try {
    await withFixture({}, async ({ sequelize }) => {
      const Item = sequelize.define('Item', { id: { type: Sequelize.INTEGER, primaryKey: true } }, { timestamps: false });
      await Item.create({ id: 1 });
      await Item.findAll();
    });
    await withFixture({}, async ({ sequelize }) => {
      await assert.rejects(sequelize.query('SELECT 1'));
    }, async () => { throw new Error('private query data'); });
  } finally { console.log = original; }
  assert.deepEqual(messages, []);
});

test('dialect selection honors the configured dialect', async () => {
  for (const dialect of ['dmdb', 'mysql', 'postgres', 'sqlite', 'mariadb']) {
    const sequelize = new Sequelize('db', 'user', 'password', { dialect, dialectModule: {}, logging: false });
    try { assert.equal(sequelize.getDialect(), dialect); assert.equal(sequelize.dialect.name, dialect); }
    finally { await sequelize.close(); }
  }
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok - ${name}`); }
    catch (error) { failures++; console.error(`not ok - ${name}\n${error.stack}`); }
  }
  console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
