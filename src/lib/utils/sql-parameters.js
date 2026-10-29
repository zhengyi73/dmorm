'use strict';

// Apply substitutions only to SQL code, preserving literals, identifiers and comments.
module.exports = function mapSqlParameters(sql, replace) {
  const quoted = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\//g;
  let offset = 0;
  let result = '';
  let match;
  while ((match = quoted.exec(sql))) {
    result += replace(sql.slice(offset, match.index)) + match[0];
    offset = quoted.lastIndex;
  }
  return result + replace(sql.slice(offset));
};
