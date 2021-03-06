/* Run tests expecting the following structure under test

  group/
    subgroup/
      options.json
      testName/
        actual.js
        expected.js
        options.json
      options.json
    options.json


   options.json are babel options for the tests in that group or test. Test options will be merged with group options. 
   Plugin options will be merged by plugin as well. 

   A special option "throws" can be present, which will test for an error being thrown matching the regex that's the value of 
   the option.
   
   You can invoke this with options
   
   --path group/subgroup/test
   --path group/subgroup
   
    Only run tests that match the pattern, use a * to match any group or test. If only one segment is passed, 
    will run all tests in the group. For example:

    mocha test/index.js --path fixtures/interop/imports-hoisting     // run just test fixtures/interop/imports-hoisting
    mocha test/index.js --path nomangle/interop                      // run all tests under nomangle/interop

*/

var assert =    require('assert');
var eol =       require('os').EOL;
var fs =        require('fs');
var path =      require('path');
var _ =         require('lodash');
var args =      require('yargs').argv;
var appRoot =   require('app-root-path');

var babel =     require('babel-core');
var codeFrame = require("babel-code-frame");

var buildExternalHelpers = babel.buildExternalHelpers;


var babelHelpers = eval(buildExternalHelpers(null, "var"));

var PLUGIN_NAME = "transform-es2015-modules-commonjs-simple";
var ORIGINAL_PLUGIN_NAME = "transform-es2015-modules-commonjs";

var testPath = args.path;
var parts = [];

if (testPath) {
  parts = testPath.split('/');
  if (parts.length === 0 || parts.length > 3) {
    console.log("--path must include an argument that 1-3 parts, separated by a slash, e.g. '*/overview' or 'auxiliary-comment'");
    process.exit(1);
  }
}

while (parts.length < 3) parts.push('*');

var maxDepth = 2;
var textEncoding =  'utf8';

function testGroup(dir, name, options, depth) {
  //var fixtureRoot = path.join(testRoot, testGroup);
  
  depth = depth || 0;
  var opts = mergeOpts(options, getOpts(dir));

  var filter = parts[depth];


  // check for exec.js
  try {
    var fname = '/test'+name+'/exec.js';
    var js = fs.readFileSync(appRoot.resolve(fname), 'utf-8');

    testExec(name, js, opts);
  }
  catch(e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }

    // no exec.js - traverse for fixtures
    
    getDirectories(dir)
      .filter(function(folder) {
         return filter === '*' || folder === filter;
      }).map(function(folder) {
        (depth === maxDepth ? test : testGroup)(path.join(dir, folder), `${name}/${folder}`, opts, depth+1);
      });
  }
}

function runExec(opts, execCode) {
  var fn = new Function('babelHelpers', 'assert', 'transform', 'opts', 'exports', execCode);
  return fn.apply(null, [babelHelpers, assert, babel.transform, opts, {}]);
}

// from babel-transform-fixture-test-runner

function testExec(name, execCode, execOpts) {
  var result = babel.transform(execCode, finalizeOpts(execOpts));
    execCode = result.code;
    try {
      it(name, function() {
        runExec(execOpts, execCode);  
      })
    } catch (err) {
      err.message = name + ": " + err.message;
      err.message += codeFrame(execCode);
      throw err;
    }
}

function test(dir, name, options) {
  it(name, function () {
    var actualPath = path.join(dir, 'actual.js');
    var expectedPath = path.join(dir, 'expected.js');

    var opts = mergeOpts(options, getOpts(dir));
    var throwsOpt = opts.throws;


    deleteTestingOptions(opts);

    opts = finalizeOpts(opts);

    var actual;

    try {
       actual = babel.transformFileSync(actualPath, opts).code;
    }
    catch(e) {
      if (throwsOpt) {
        var regex = new RegExp(throwsOpt);
        var expectedPattern = "Pattern /" + throwsOpt + "/";
        if (!regex.test(e.message)) {
          assert.equal(expectedPattern, e.message, "Should throw an error matching the pattern");
        } else {
          return assert.ok(expectedPattern);
        }
      } 
      throw e;
    }
    
    var expected = fs.readFileSync(expectedPath, textEncoding);

    assert.equal(normalizeEndings(actual), normalizeEndings(expected));
  });
}

function deleteTestingOptions(options) {
  ["throws"].forEach(function(e) {
    if (options[e]) delete options[e];
  });
}

function getDirectories(srcpath) {
  return fs.readdirSync(srcpath).filter(function(file) {
    return fs.statSync(path.join(srcpath, file)).isDirectory();
  });
}

function getOpts(srcpath) {
  var opts = {};
  try {
    opts = JSON.parse(fs.readFileSync(path.resolve(srcpath, "options.json"), textEncoding));
  }
  catch(e) { } 
  return opts; 
}

function finalizeOpts(opts) {

  // convert module name to relative path
  
  opts.plugins = (opts.plugins||[]).map(function(e) {

      if (e[0] === PLUGIN_NAME) {
        e[0] = appRoot.resolve("/lib");
      }

      return e.length === 1 ? 
        e[0] : 
        e;
    });
    
    return opts;

}

function mergeOpts(target, src) {
    var last = null;

    var plugins = (target.plugins || [])
      .concat(src.plugins || []);
    
    plugins = plugins.map(function(e) {
        e = asArray(e);

        if (e[0] === ORIGINAL_PLUGIN_NAME) {
          e[0] = PLUGIN_NAME;
        }
        return e;
      })
      // remove dup module defs
      .sort(function(a,b) {
        
        return a[0].localeCompare(b[0]);
      })
      .filter(function(e) {
        if (!last || e[0] !== last[0]) {
          last = e;
          return true;
        };

        // merge plugin options from child options.json
        if (e[1]) {
          last[1] = _.assign({}, last[1], e[1]);
        }
        
        return false;
      });


    var options = _.assign({}, target, src);
    options.plugins = plugins;

    return options;
}

function asArray(obj) {
  if (obj === null || obj === undefined) return [];
  return Array.isArray(obj) ?
    obj.map(function(e) {
      return e;
    }) : 
    [obj];
}

/* ensure o/s specific line endings, and multiple blank lines aren't a problem:
   -- normalize line endings
   -- remove duplicate all all blank lines
   -- ensure every file ends with a newline
*/

function normalizeEndings(text) {
  
  text = text.replace(/\r\n/g, '\n');
  text = text + '\n';

  text = text.replace(/[\n]{2,}/g, '\n');
  text = text.replace(/\n/g, eol);

  return text;
}

// main entry

testGroup(__dirname, '', {});

