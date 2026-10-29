'use strict';

const AbstractConnectionManager = require('../abstract/connection-manager');
const SequelizeErrors = require('../../errors');
const { logger } = require('../../utils/logger');
const DataTypes = require('../../data-types').dmdb;
const debug = logger.debugContext('connection:dmdb');
const parserStore = require('../parserStore')('dmdb');

/**
 * DM connections are owned by the ORM pool. Never create a driver pool here:
 * closing a borrowed driver connection would only return it to that hidden pool.
 * @private
 */
class ConnectionManager extends AbstractConnectionManager {
  constructor(dialect, sequelize) {
    sequelize.config.port = sequelize.config.port || 5236;
    super(dialect, sequelize);
    this.lib = this._loadDialectModule('dmdb');
    this._invalidConnections = new WeakSet();
    this._closedConnections = new WeakSet();
    this.refreshTypeParser(DataTypes);
  }

  _refreshTypeParser(dataType) {
    parserStore.refresh(dataType);
  }

  _clearTypeParser() {
    parserStore.clear();
  }

  static _typecast(field, next) {
    if (parserStore.get(field.type)) {
      return parserStore.get(field.type)(field, this.sequelize.options, next);
    }
    return next();
  }

  async connect(config) {
    const dialectOptions = config.dialectOptions || {};
    const connectionConfig = {
      user: config.username,
      password: config.password,
      ...dialectOptions,
      connectString: dialectOptions.connectString || dialectOptions.connectionString || `${config.host}:${config.port}`
    };

    try {
      const connection = await this.lib.getConnection(connectionConfig);
      if (typeof connection.on === 'function') {
        connection.on('error', error => {
          this._invalidConnections.add(connection);
          debug('connection error: %s', error.errCode || error.code || error.message);
        });
      }
      debug('connection acquired');
      return connection;
    } catch (err) {
      switch (err.code) {
        case 'ECONNREFUSED':
          throw new SequelizeErrors.ConnectionRefusedError(err);
        case 'ER_ACCESS_DENIED_ERROR':
          throw new SequelizeErrors.AccessDeniedError(err);
        case 'ENOTFOUND':
          throw new SequelizeErrors.HostNotFoundError(err);
        case 'EHOSTUNREACH':
          throw new SequelizeErrors.HostNotReachableError(err);
        case 'EINVAL':
          throw new SequelizeErrors.InvalidConnectionError(err);
        default:
          throw new SequelizeErrors.ConnectionError(err);
      }
    }
  }

  async disconnect(connection) {
    if (connection.closed === true || this._closedConnections.has(connection)) {
      return;
    }
    this._invalidConnections.add(connection);
    await connection.close();
    this._closedConnections.add(connection);
  }

  async releaseConnection(connection) {
    if (!this.validate(connection)) {
      await this.destroyConnection(connection);
      return;
    }
    await super.releaseConnection(connection);
  }

  invalidate(connection) {
    this._invalidConnections.add(connection);
  }

  validate(connection) {
    return !!connection
      && connection.closed !== true
      && !this._invalidConnections.has(connection)
      && !this._closedConnections.has(connection);
  }
}

module.exports = ConnectionManager;
module.exports.ConnectionManager = ConnectionManager;
module.exports.default = ConnectionManager;
