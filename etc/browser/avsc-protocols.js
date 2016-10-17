/* jshint browserify: true */

'use strict';

/**
 * Optional entry point for browser builds.
 *
 * To use it: `require('avsc/etc/browser/avsc-protocols')`.
 *
 */

var protocols = require('../../lib/protocols'),
    schemas = require('../../lib/schemas'),
    types = require('../../lib/types'),
    values = require('../../lib/values');


function parse(schema, opts) {
  var attrs = schemas.parseAttrs(schema);
  return attrs.protocol || attrs.messages || attrs.types ?
    protocols.createProtocol(attrs, opts) :
    types.createType(attrs, opts);
}


module.exports = {
  Protocol: protocols.Protocol,
  Type: types.Type,
  assemble: schemas.assemble,
  combine: values.combine,
  infer: values.infer,
  parse: parse,
  types: types.builtins
};
