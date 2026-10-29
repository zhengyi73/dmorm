'use strict';

const AbstractQuery = require('../abstract/query');
const sequelizeErrors = require('../../errors');
const _ = require('lodash');
const mapSqlParameters = require('../../utils/sql-parameters');
const { logger } = require('../../utils/logger');

const ER_DUP_ENTRY = 1062;
const ER_ROW_IS_REFERENCED = 1451;
const ER_NO_REFERENCED_ROW = 1452;

const debug = logger.debugContext('sql:dmdb');

// DM extended metadata uses native SQL type IDs, rather than dmdb.NUMBER.
const isBigIntColumn = column => column && (column.dbType === 8 || /^BIGINT$/i.test(column.dbTypeName || ''));
const isDecimalColumn = column => column && (column.dbType === 9 || /^(DECIMAL|NUMERIC|NUMBER|DEC)$/i.test(column.dbTypeName || ''));

class Query extends AbstractQuery {
  constructor(connection, sequelize, options) {
    super(connection, sequelize, { showWarnings: false, ...options });
  }
  static formatBindParameters(sql, values, dialect) {
    const parameters = [];
    const list = Array.isArray(values);
    sql = mapSqlParameters(sql, code => code.replace(/\B\$(\$|\w+)/g, (match, key) => {
      if (key === '$') return '$';
      const index = list && /^[1-9]\d*$/.test(key) ? Number(key) - 1 : key;
      if ((list && !/^[1-9]\d*$/.test(key))
        || (!list && /^\d+$/.test(key))
        || !Object.prototype.hasOwnProperty.call(values, index)
        || values[index] === undefined) {
        throw new Error(`Named bind parameter "${match}" has no value in the given object.`);
      }
      parameters.push(values[index]);
      return `:${parameters.length}`;
    }));
    return [sql, parameters.length ? parameters : undefined];
  }

  async run(sql, parameters) {
    this.sql = sql;
    
    const { connection, options } = this;

    const showWarnings = this.sequelize.options.showWarnings || options.showWarnings;

    const complete = this._logQuery(sql, debug, parameters);
    
    if (parameters) {
      debug('parameters(%j)', parameters);
    }

    let results;

    try {
      // Read column metadata before fetching rows: the driver's default BIGINT
      // and DECIMAL -> Number conversion loses precision before formatResults.
      const fetchInfo = Object.create(null);
      const executeOptions = {
        autoCommit: !options.transaction,
        resultSet: true,
        extendedMetaData: true,
        fetchInfo
      };
      results = await connection.execute(sql, parameters || [], executeOptions);
      await this.collectResultSets(results, fetchInfo);
    } catch (error) {
      // dmdb 1.0.52452 can leave a server statement allocated when execute
      // fails. Retire this connection on release, including transaction cleanup.
      this.sequelize.connectionManager.invalidate(connection);
      error.sql = sql;
      error.parameters = parameters;
      const formattedError = this.formatError(error);
      formattedError.parameters = parameters;
      throw formattedError;
    } finally {
      complete();
    }

    if (showWarnings && results && results.warningStatus > 0) {
      await this.logWarnings(results);
    }
    return this.formatResults(results);
  }

  async collectResultSets(result, fetchInfo) {
    const cursors = new Set();
    if (result.resultSet) cursors.add(result.resultSet);
    for (const implicit of result.implicitResults || []) {
      if (implicit && typeof implicit.getRows === 'function') cursors.add(implicit);
    }
    let failure;
    try {
      const read = async (cursor, columns) => {
        for (const column of columns || []) {
          if (isBigIntColumn(column) || isDecimalColumn(column)) {
            fetchInfo[column.name] = { type: this.sequelize.connectionManager.lib.STRING };
          }
        }
        const rows = [];
        for (;;) {
          const batch = await cursor.getRows(1000);
          if (!batch.length) return rows;
          rows.push(...batch);
        }
      };
      if (result.resultSet) {
        result.rows = await read(result.resultSet, result.metaData);
        delete result.resultSet;
      }
      if (result.implicitResults) {
        for (let i = 0; i < result.implicitResults.length; i++) {
          const cursor = result.implicitResults[i];
          if (cursors.has(cursor)) result.implicitResults[i] = await read(cursor, cursor.metaData);
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      for (const cursor of cursors) {
        try {
          await cursor.close();
        } catch (error) {
          this.sequelize.connectionManager.invalidate(this.connection);
          failure = failure || error;
        }
      }
    }
    if (failure) throw failure;
  }

  /**
   * High level function that handles the results of a query execution.
   *
   *
   * Example:
   *  query.formatResults([
   *    {
   *      id: 1,              // this is from the main table
   *      attr2: 'snafu',     // this is from the main table
   *      Tasks.id: 1,        // this is from the associated table
   *      Tasks.title: 'task' // this is from the associated table
   *    }
   *  ])
   *
   * @param {Array} data - The result of the query execution.
   * @private
   */
  formatResults(data) {
    let result = this.instance;
    const metadata = data;
    const affectedRows = metadata.rowsAffected === undefined ? metadata.affectedRows : metadata.rowsAffected;
    const columns = metadata.metaData || [];
    const convertValue = (value, column) => {
      if (typeof value === 'string' && isBigIntColumn(column) && /^-?\d+$/.test(value)) {
        value = BigInt(value);
      }
      if (typeof value !== 'bigint') return value;
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
    };
    data = (metadata.rows || []).map(row => {
      const entries = Array.isArray(row)
        ? columns.map((column, index) => [column.name, convertValue(row[index], column)])
        : Object.entries(row).map(([key, value]) => [key, convertValue(value, columns.find(column => column.name === key))]);
      return Object.fromEntries(entries);
    });

    if (this.isInsertQuery(metadata)) {
      if (metadata[this.getInsertIdField()] !== undefined) {
        this.handleInsertQuery(metadata);
      }
      if (!this.instance) result = metadata[this.getInsertIdField()];
    }

    if (this.isSelectQuery()) {
      return this.handleSelectQuery(data);
    }
    if (this.isShowTablesQuery()) {
      return this.handleShowTablesQuery(data);
    }
    if (this.isDescribeQuery()) {
      result = {};

      for (const _result of data) {
        const enumRegex = /^enum/i;
        result[_result.Field] = {
          type: enumRegex.test(_result.Type) ? _result.Type.replace(enumRegex, 'ENUM') : _result.Type.toUpperCase(),
          allowNull: _result.Null === 'YES',
          defaultValue: _result.Default,
          primaryKey: _result.Key === 'PRI',
          autoIncrement: Object.prototype.hasOwnProperty.call(_result, 'Extra')
            && _result.Extra.toLowerCase() === 'auto_increment',
          comment: _result.Comment ? _result.Comment : null
        };
      }
      return result;
    }
    if (this.isShowIndexesQuery()) {
      return this.handleShowIndexesQuery(data);
    }
    if (this.isCallQuery()) {
      return data[0];
    }
    if (this.isBulkUpdateQuery() || this.isBulkDeleteQuery()) {
      return affectedRows;
    }
    if (this.isVersionQuery()) {
      const value = data[0] && Object.values(data[0])[0];
      return value == null ? undefined : String(value);
    }
    if (this.isForeignKeysQuery()) {
      return data;
    }
    if (this.isUpsertQuery()) {
      return [result, affectedRows === 1];
    }
    if (this.isInsertQuery() || this.isUpdateQuery()) {
      return [result, affectedRows];
    }
    if (this.isShowConstraintsQuery()) {
      return data;
    }
    if (this.isRawQuery()) {
      return [data, metadata];
    }

    return result;
  }

  async logWarnings(results) {
    const warningResults = await this.run('SHOW WARNINGS');
    const warningMessage = `DmDB Warnings (${this.connection.uuid || 'default'}): `;
    const messages = [];
    for (const _warningRow of warningResults) {
      if (_warningRow === undefined || typeof _warningRow[Symbol.iterator] !== 'function') {
        continue;
      }
      for (const _warningResult of _warningRow) {
        if (Object.prototype.hasOwnProperty.call(_warningResult, 'Message')) {
          messages.push(_warningResult.Message);
        } else {
          for (const _objectKey of _warningResult.keys()) {
            messages.push([_objectKey, _warningResult[_objectKey]].join(': '));
          }
        }
      }
    }

    this.sequelize.log(warningMessage + messages.join('; '), this.options);

    return results;
  }

  formatError(err) {
    const errCode = Number(err.errCode || err.errno || err.code);

    switch (errCode) {
      case -6602:
        return new sequelizeErrors.UniqueConstraintError({ message: err.message, parent: err, errors: [], fields: {} });
      case -6607:
        return new sequelizeErrors.ForeignKeyConstraintError({ parent: err });
      case ER_DUP_ENTRY: {
        const match = err.message.match(/Duplicate entry '([\s\S]*)' for key '?((.|\s)*?)'?$/);
        let fields = {};
        let message = 'Validation error';
        const values = match ? match[1].split('-') : undefined;
        const fieldKey = match ? match[2] : undefined;
        const fieldVal = match ? match[1] : undefined;
        const uniqueKey = this.model && this.model.uniqueKeys[fieldKey];

        if (uniqueKey) {
          if (uniqueKey.msg) message = uniqueKey.msg;
          fields = _.zipObject(uniqueKey.fields, values);
        } else {
          fields[fieldKey] = fieldVal;
        }

        const errors = [];
        _.forOwn(fields, (value, field) => {
          errors.push(new sequelizeErrors.ValidationErrorItem(
            this.getUniqueConstraintErrorMessage(field),
            'unique violation', // sequelizeErrors.ValidationErrorItem.Origins.DB,
            field,
            value,
            this.instance,
            'not_unique'
          ));
        });

        return new sequelizeErrors.UniqueConstraintError({ message, errors, parent: err, fields });
      }

      case ER_ROW_IS_REFERENCED:
      case ER_NO_REFERENCED_ROW: {
        // e.g. CONSTRAINT `example_constraint_name` FOREIGN KEY (`example_id`) REFERENCES `examples` (`id`)
        const match = err.message.match(
          /CONSTRAINT ([`"])(.*)\1 FOREIGN KEY \(\1(.*)\1\) REFERENCES \1(.*)\1 \(\1(.*)\1\)/
        );
        const quoteChar = match ? match[1] : '`';
        const fields = match ? match[3].split(new RegExp(`${quoteChar}, *${quoteChar}`)) : undefined;

        return new sequelizeErrors.ForeignKeyConstraintError({
          reltype: String(errCode) === String(ER_ROW_IS_REFERENCED) ? 'parent' : 'child',
          table: match ? match[4] : undefined,
          fields,
          value: fields && fields.length && this.instance && this.instance[fields[0]] || undefined,
          index: match ? match[2] : undefined,
          parent: err
        });
      }

      default:
        return new sequelizeErrors.DatabaseError(err);
    }
  }

  handleShowIndexesQuery(data) {
    // Group by index name, and collect all fields
    data = data.reduce((acc, item) => {
      if (!(item.Key_name in acc)) {
        acc[item.Key_name] = item;
        item.fields = [];
      }

      acc[item.Key_name].fields[item.Seq_in_index - 1] = {
        attribute: item.Column_name,
        length: item.Sub_part || undefined,
        order: item.Collation === 'A' ? 'ASC' : undefined
      };
      delete item.column_name;

      return acc;
    }, {});

    return _.map(data, item => ({
      primary: item.Key_name === 'PRIMARY',
      fields: item.fields,
      name: item.Key_name,
      tableName: item.Table,
      unique: item.Non_unique !== 1,
      type: item.Index_type
    }));
  }
}

module.exports = Query;
module.exports.Query = Query;
module.exports.default = Query;
