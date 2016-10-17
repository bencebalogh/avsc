/* jshint node: true */

'use strict';

/**
 * Shim without file-system operations.
 *
 * We also patch a few methods because of browser incompatibilities (see below
 * for more information).
 *
 */

// Since there are no utf8 and binary functions on browserify's `Buffer`, we
// must patch in tap methods using the generic slice and write methods.
(function polyfillTap() {
  var Tap = require('../../../lib/utils').Tap;

  Tap.prototype.readString = function () {
    var len = this.readLong();
    var pos = this.pos;
    var buf = this.buf;
    this.pos += len;
    if (this.pos > buf.length) {
      return;
    }
    return this.buf.slice(pos, pos + len).toString();
  };

  Tap.prototype.writeString = function (s) {
    var len = Buffer.byteLength(s);
    this.writeLong(len);
    var pos = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
      return;
    }
    this.buf.write(s, pos);
  };

  Tap.prototype.writeBinary = function (s, len) {
    var pos = this.pos;
    this.pos += len;
    if (this.pos > this.buf.length) {
      return;
    }
    this.buf.write(s, pos, len, 'binary');
  };
})();


function createError() { return new Error('unsupported in the browser'); }


module.exports = {
  createImportHook: function (fpath, kind, cb) { cb(createError()); },
  createSyncImportHook: function () { throw createError(); },
  existsSync: function () { return false; },
  readFileSync: function () { throw createError(); }
};
