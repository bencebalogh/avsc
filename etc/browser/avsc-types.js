/* jshint browserify: true */

'use strict';

/**
 * Optional entry point for browser builds.
 *
 * To use it: `require('avsc/etc/browser/avsc-types')`.
 *
 */

var schemas = require('../../lib/schemas'),
    types = require('../../lib/types'),
    values = require('../../lib/values');


function parse(schema, opts) {
  return types.createType(schemas.parseAttrs(schema), opts);
}


module.exports = {
  Type: types.Type,
  combine: values.combine,
  infer: values.infer,
  parse: parse,
  types: types.builtins
};
