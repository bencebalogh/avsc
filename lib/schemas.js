/* jshint node: true */

// TODO: Allow array and map definitions without `<>` (protected by an
// option?).

'use strict';

/**
 * IDL to schema parsing logic.
 *
 */

var files = require('./files'),
    utils = require('./utils'),
    path = require('path'),
    util = require('util');


var f = util.format;

/**
 * Assemble an IDL file into a decoded schema.
 *
 */
function assemble(fpath, opts, cb) {
  if (!cb && typeof opts == 'function') {
    cb = opts;
    opts = undefined;
  }
  opts = opts || {};
  if (!opts.importHook) {
    opts.importHook = files.createImportHook();
  }

  // Types found in imports. We store them separately to be able to insert them
  // in the correct order in the final attributes.
  var importedTypes = [];
  var attrs, imports;
  opts.importHook(fpath, 'idl', function (err, str) {
    if (err) {
      cb(err);
      return;
    }
    if (!str) {
      // Skipped import (likely already imported).
      cb(null, {});
      return;
    }
    var tokenizer = new Tokenizer(str);
    try {
      var protocol = parseProtocol(tokenizer, opts);
    } catch (err) {
      err.path = fpath; // To help debug which file caused the error.
      cb(err);
      return;
    }
    attrs = protocol.attrs;
    imports = protocol.imports;
    fetchImports();
  });

  function fetchImports() {
    var info = imports.shift();
    if (!info) {
      // We are done with this file. We prepend all imported types to this
      // file's and we can return the final result.
      if (importedTypes.length) {
        attrs.types = attrs.types ?
          importedTypes.concat(attrs.types) :
          importedTypes;
      }
      cb(null, attrs);
    } else {
      var importPath = path.join(path.dirname(fpath), info.name);
      if (info.kind === 'idl') {
        assemble(importPath, opts, mergeImportedAttrs);
      } else {
        // We are importing a protocol or schema file.
        opts.importHook(importPath, info.kind, function (err, str) {
          if (err) {
            cb(err);
            return;
          }
          switch (info.kind) {
            case 'protocol':
            case 'schema':
              try {
                var obj = JSON.parse(str);
              } catch (err) {
                err.path = importPath;
                cb(err);
                return;
              }
              var attrs = info.kind === 'schema' ? {types: [obj]} : obj;
              mergeImportedAttrs(null, attrs);
              break;
            default:
              cb(new Error(f('invalid import kind: %s', info.kind)));
          }
        });
      }
    }
  }

  function mergeImportedAttrs(err, importedAttrs) {
    if (err) {
      cb(err);
      return;
    }
    // Merge  first the types (where we don't need to check for duplicates
    // since `parse` will take care of it), then the messages (where we need
    // to, as duplicates will overwrite each other).
    (importedAttrs.types || []).forEach(function (typeAttrs) {
      // Ensure the imported protocol's namespace is inherited correctly (it
      // might be different from the current one).
      if (typeAttrs.namespace === undefined) {
        var namespace = importedAttrs.namespace;
        if (!namespace) {
          var match = /^(.*)\.[^.]+$/.exec(importedAttrs.protocol);
          if (match) {
            namespace = match[1];
          }
        }
        typeAttrs.namespace = namespace || '';
      }
      importedTypes.push(typeAttrs);
    });
    try {
      Object.keys(importedAttrs.messages || {}).forEach(function (name) {
        if (!attrs.messages) {
          attrs.messages = {};
        }
        if (attrs.messages[name]) {
          throw new Error(f('duplicate message: %s', name));
        }
        attrs.messages[name] = importedAttrs.messages[name];
      });
    } catch (err) {
      cb(err);
      return;
    }
    fetchImports(); // Continue importing any remaining imports.
  }
}

// Helpers.

/**
 * Simple class to split an input string into tokens.
 *
 * There are different types of tokens, characterized by their `id`:
 *
 * + `number` numbers.
 * + `name` references.
 * + `string` double-quoted.
 * + `operator`, anything else, always single character.
 * + `javadoc`, only emitted when `next` is called with `emitJavadoc` set.
 * + `json`, only emitted when `next` is called with `'json'` as `id` (the
 *   tokenizer doesn't have enough context to predict these).
 *
 */
function Tokenizer(str) {
  this._str = str;
  this._pos = 0;
  this._queue = new BoundedQueue(3); // Bounded queue of last emitted tokens.
}

Tokenizer.prototype.next = function (opts) {
  this._queue.push(this._pos);
  var javadoc = this._skip(opts && opts.emitJavadoc);
  var token;
  if (javadoc) {
    token = {id: 'javadoc', val: javadoc};
  } else {
    var pos = this._pos;
    var str = this._str;
    var c = str.charAt(pos);
    var id;
    if (!c) {
      token = {id: '(eof)'};
    } else {
      if (opts && opts.id === 'json') {
        id = 'json';
        this._pos = this._endOfJson();
      } else if (c === '"') {
        id = 'string';
        this._pos = this._endOfString();
      } else if (/[0-9]/.test(c)) {
        id = 'number';
        this._pos = this._endOf(/[0-9]/);
      } else if (/[`A-Za-z_.]/.test(c)) {
        id = 'name';
        this._pos = this._endOf(/[`A-Za-z0-9_.]/);
      } else {
        id = 'operator';
        this._pos = pos + 1;
      }
      token = {id: id, val: str.slice(pos, this._pos)};
      if (id === 'json') {
        // Let's be nice and give a more helpful error message when this occurs
        // (JSON parsing errors wouldn't let us find the location otherwise).
        try {
          token.val = JSON.parse(token.val);
        } catch (err) {
          throw this.error('invalid JSON');
        }
      } else if (id === 'name') {
        // Unescape names (our parser doesn't need them).
        token.val = token.val.replace(/`/g, '');
      }
    }
  }
  if (opts && opts.id && opts.id !== token.id) {
    throw this.error(f('expected %s but got %s', opts.id, token.val));
  } else if (opts && opts.val && opts.val !== token.val) {
    throw this.error(f('expected %s but got %s', opts.val, token.val));
  } else {
    return token;
  }
};

Tokenizer.prototype.prev = function () {
  var pos = this._queue.pop();
  if (pos === undefined) {
    throw new Error('cannot backtrack more');
  }
  this._pos = pos;
  return this;
};

Tokenizer.prototype.error = function (msg) {
  var pos = this._queue.peek() || 1; // Use after whitespace position.
  var str = this._str;
  var lineNum = 1;
  var lineStart = 0;
  var i;
  for (i = 0; i < pos; i++) {
    if (str.charAt(i) === '\n') {
      lineNum++;
      lineStart = i;
    }
  }
  var err = new Error(msg);
  err.lineNum = lineNum;
  err.colNum = pos - lineStart;
  return err;
};

/** Skip whitespace and comments. */
Tokenizer.prototype._skip = function (emitJavadoc) {
  var str = this._str;
  var pos, c; // `pos` used for javadocs.

  while ((c = str.charAt(this._pos)) && /\s/.test(c)) {
    this._pos++;
  }
  if (c === '/') {
    switch (str.charAt(this._pos + 1)) {
    case '/':
      this._pos += 2;
      while ((c = str.charAt(this._pos)) && c !== '\n') {
        this._pos++;
      }
      return this._skip(emitJavadoc);
    case '*':
      this._pos += 2;
      if (str.charAt(this._pos) === '*') {
        pos = this._pos + 1;
      }
      while ((c = str.charAt(this._pos++))) {
        if (c === '*' && str.charAt(this._pos) === '/') {
          this._pos++;
          if (pos !== undefined && emitJavadoc) {
            return extractJavadoc(str.slice(pos, this._pos - 2));
          }
          return this._skip(emitJavadoc);
        }
      }
      throw this.error('unterminated comment');
    }
  }
};

/** Generic end of method. */
Tokenizer.prototype._endOf = function (pat) {
  var pos = this._pos;
  var str = this._str;
  while (pat.test(str.charAt(pos))) {
    pos++;
  }
  return pos;
};

/** Find end of a string. */
Tokenizer.prototype._endOfString = function () {
  var pos = this._pos + 1; // Skip first double quote.
  var str = this._str;
  var c;
  while ((c = str.charAt(pos))) {
    if (c === '"') {
      // The specification doesn't explicitly say so, but IDLs likely only
      // allow double quotes for strings (C- and Java-style).
      return pos + 1;
    }
    if (c === '\\') {
      pos += 2;
    } else {
      pos++;
    }
  }
  throw this.error('unterminated string');
};

/** Find end of JSON object, throwing an error if the end is reached first. */
Tokenizer.prototype._endOfJson = function () {
  var pos = utils.jsonEnd(this._str, this._pos);
  if (pos < 0) {
    throw new Error('invalid JSON at ' + this._pos);
  }
  return pos;
};

// Parsing functions.

function parseMessage(tk) {
  var javadoc = _readJavadoc(tk);
  return _readType(tk, javadoc === undefined ? {} : {doc: javadoc});
}

function parseProtocol(tk, opts) {
  var imports = [];
  var types = [];
  var messages = {};
  var hasMessage = false;
  _readImports(tk, imports);
  var protocolAttrs = {};
  var protocolJavadoc = _readJavadoc(tk);
  if (protocolJavadoc !== undefined) {
    protocolAttrs.doc = protocolJavadoc;
  }
  _readAnnotations(tk, protocolAttrs);
  tk.next({val: 'protocol'});
  if (tk.next().val !== '{') {
    protocolAttrs.protocol = tk.prev().next({id: 'name'}).val;
    tk.next({val: '{'});
  }
  var attrs = {}; // Type or message attributes (see below).
  while (tk.next().val !== '}') {
    tk.prev();
    if (!_readImports(tk, imports)) {
      var javadoc = _readJavadoc(tk);
      var typeAttrs = _readType(tk, attrs);
      // We now look ahead to figure out whether this was a standalone type
      // definition, or a message's response type. (Unfortunately, there is no
      // way to tell otherwise without disallowing inline type declarations.)
      attrs = {};
      var numImports = _readImports(tk, imports, true);
      _readAnnotations(tk, attrs);
      var name = tk.next().val; // Potential message name.
      if (!numImports && tk.next().val === '(') {
        // We are reading a message.
        hasMessage = true;
        var oneWay = false;
        if (typeAttrs === 'void' || typeAttrs.type === 'void') {
          if (opts && opts.oneWayVoid) {
            oneWay = true;
          }
          if (typeAttrs === 'void') {
            typeAttrs = 'null';
          } else {
            typeAttrs.type = 'null';
          }
        }
        attrs.response = typeAttrs;
        _readMessageParams(tk, attrs);
        if (javadoc !== undefined && attrs.doc === undefined) {
          attrs.doc = javadoc;
        }
        if (oneWay) {
          attrs['one-way'] = true;
        }
        if (messages[name]) {
          // We have to do this check here otherwise the duplicate will be
          // overwritten (and `parse` won't be able to catch it).
          throw new Error(f('duplicate message: %s', name));
        }
        messages[name] = attrs;
        attrs = {};
      } else {
        // This was a standalone type definition.
        if (javadoc) {
          if (typeof typeAttrs == 'string') {
            typeAttrs = {doc: javadoc, type: typeAttrs};
          } else if (typeAttrs.doc === undefined) {
            typeAttrs.doc = javadoc;
          }
        }
        types.push(typeAttrs);
        // We backtrack until just before the type's type name.
        tk.prev().prev();
      }
      javadoc = undefined;
    }
  }
  tk.next({id: '(eof)'});
  if (types.length) {
    protocolAttrs.types = types;
  }
  if (hasMessage) {
    protocolAttrs.messages = messages;
  }
  return {attrs: protocolAttrs, imports: imports};
}

function _readAnnotations(tk, attrs) {
  while (tk.next().val === '@') {
    // Annotations are allowed to have names which aren't valid Avro names,
    // we must advance until we hit the first left parenthesis.
    var parts = [];
    while (tk.next().val !== '(') {
      parts.push(tk.prev().next().val);
    }
    attrs[parts.join('')] = tk.next({id: 'json'}).val;
    tk.next({val: ')'});
  }
  tk.prev();
}

function _readMessageParams(tk, attrs) {
  // Tokenizer should be just after the open parens.
  attrs.request = [];
  if (tk.next().val !== ')') {
    tk.prev();
    do {
      attrs.request.push(_readField(tk));
    } while (tk.next().val !== ')' && tk.prev().next({val: ','}));
  }
  switch (tk.next().val) {
    case 'throws':
      // It doesn't seem like the IDL is explicit about which syntax to used
      // for multiple errors. We will assume a comma-separated list.
      attrs.errors = [];
      do {
        attrs.errors.push(_readType(tk));
      } while (tk.next().val !== ';' && tk.prev().next({val: ','}));
      tk.prev();
      break;
    case 'oneway':
      attrs['one-way'] = true;
      break;
    default:
      tk.prev();
  }
  tk.next({val: ';'});
}

function _readJavadoc(tk) {
  var token = tk.next({emitJavadoc: true});
  if (token.id === 'javadoc') {
    return token.val;
  } else {
    tk.prev();
  }
}

function _readField(tk) {
  var javadoc = _readJavadoc(tk);
  var attrs = {type: _readType(tk)};
  if (javadoc !== undefined && attrs.doc === undefined) {
    attrs.doc = javadoc;
  }
  _readAnnotations(tk, attrs);
  attrs.name = tk.next({id: 'name'}).val;
  if (tk.next().val === '=') {
    attrs['default'] = tk.next({id: 'json'}).val;
  } else {
    tk.prev();
  }
  return attrs;
}

function _readType(tk, attrs) {
  attrs = attrs || {};
  _readAnnotations(tk, attrs);
  attrs.type = tk.next({id: 'name'}).val;
  switch (attrs.type) {
    case 'record':
    case 'error':
      return _readRecord(tk, attrs);
    case 'fixed':
      return _readFixed(tk, attrs);
    case 'enum':
      return _readEnum(tk, attrs);
    case 'map':
      return _readMap(tk, attrs);
    case 'array':
      return _readArray(tk, attrs);
    case 'union':
      if (Object.keys(attrs).length > 1) {
        throw new Error('union annotations are not supported');
      }
      return _readUnion(tk);
    default:
      // Reference.
      return Object.keys(attrs).length > 1 ? attrs : attrs.type;
  }
}

function _readFixed(tk, attrs) {
  if (tk.next().val !== '(') {
    attrs.name = tk.prev().next({id: 'name'}).val;
    tk.next({val: '('});
  }
  attrs.size = parseInt(tk.next({id: 'number'}).val);
  tk.next({val: ')'});
  if (tk.next().val !== ';') {
    tk.prev();
  }
  return attrs;
}

function _readMap(tk, attrs) {
  tk.next({val: '<'});
  attrs.values = _readType(tk);
  tk.next({val: '>'});
  return attrs;
}

function _readArray(tk, attrs) {
  tk.next({val: '<'});
  attrs.items = _readType(tk);
  tk.next({val: '>'});
  return attrs;
}

function _readEnum(tk, attrs) {
  if (tk.next().val !== '{') {
    attrs.name = tk.prev().next({id: 'name'}).val;
    tk.next({val: '{'});
  }
  attrs.symbols = [];
  do {
    attrs.symbols.push(tk.next().val);
  } while (tk.next().val !== '}' && tk.prev().next({val: ','}));
  return attrs;
}

function _readUnion(tk) {
  var arr = [];
  tk.next({val: '{'});
  do {
    arr.push(_readType(tk));
  } while (tk.next().val !== '}' && tk.prev().next({val: ','}));
  return arr;
}

function _readRecord(tk, attrs) {
  attrs.name = tk.next({id: 'name'}).val;
  attrs.fields = [];
  tk.next({val: '{'});
  while (tk.next().val !== '}') {
    tk.prev();
    attrs.fields.push(_readField(tk));
    tk.next({val: ';'});
  }
  return attrs;
}

function _readImports(tk, imports, maybeMessage) {
  var numImports = 0;
  while (tk.next().val === 'import') {
    var token = tk.next().val;
    tk.prev();
    if (!numImports && maybeMessage && token === '(') {
      // This will happen if a message is named import.
      tk.prev();
      return;
    }
    var kind = tk.next({id: 'name'}).val;
    var fname = JSON.parse(tk.next({id: 'string'}).val);
    tk.next({val: ';'});
    imports.push({kind: kind, name: fname});
    numImports++;
  }
  tk.prev();
  return numImports;
}

/**
 * Simple bounded queue.
 *
 * Not the fastest, but will definitely do.
 *
 */
function BoundedQueue(length) {
  this._length = length | 0;
  this._data = [];
}

BoundedQueue.prototype.push = function (val) {
  this._data.push(val);
  if (this._data.length > this._length) {
    this._data.shift();
  }
};

BoundedQueue.prototype.peek = function () {
  return this._data[this._data.length - 1];
};

BoundedQueue.prototype.pop = function () { return this._data.pop(); };

/**
 * Extract Javadoc contents from the comment.
 *
 * The parsing done is very simple and simply removes the line prefixes and
 * leading / trailing empty lines. It's better to be conservative with
 * formatting rather than risk losing information.
 *
 */
function extractJavadoc(str) {
  var lines = str
    .replace(/^[ \t]+|[ \t]+$/g, '') // Trim whitespace.
    .split('\n').map(function (line, i) {
      return i ? line.replace(/^\s*\*\s?/, '') : line;
    });
  while (!lines[0]) {
    lines.shift();
  }
  while (!lines[lines.length - 1]) {
    lines.pop();
  }
  return lines.join('\n');
}


module.exports = {
  BoundedQueue: BoundedQueue,
  Tokenizer: Tokenizer,
  assemble: assemble,
  parseMessage: parseMessage,
  parseProtocol: parseProtocol
};
