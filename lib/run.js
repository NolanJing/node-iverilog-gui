'use strict';

var ejs = require('ejs');
var fs = require('fs');
var async = require('async');
var path = require('path');
var mkdirp = require('mkdirp');
var glob = require('glob');
var watch = require('watch');
var minimatch = require("minimatch");
var express = require('express');
var http = require('http');
var socketio = require('socket.io');
var spawn = require('child_process').spawn;
var log = require('./output');
var syncdir = require('./syncdir');

var io;

process.on('uncaughtException', function(err) {
  if (err.stack) {
    err = err.stack;
  }
  log.error('Caught exception:', err);
});

module.exports = function(options, callback) {
  callback = callback || function(err) {
    if (err) {
      return log.error(err);
    }
  };

  options = options || {};
  options.serverPort = options.serverPort || 8888;
  options.inputDirectory = options.inputDirectory || process.cwd();
  options.buildDirectory = options.buildDirectory || path.join(options.inputDirectory, 'build');
  options.outDirectory = options.outDirectory || path.join(options.buildDirectory, 'out');
  options.reportDirectory = options.reportDirectory || path.join(options.buildDirectory, 'report');
  options.filePattern = options.filePattern || '**/*.v';
  options.testBenchPattern = options.testBenchPattern || '**/*_tb.v';
  options.iverlogOpts = options.iverlogOpts || ['-Wall -Wno-timescale'];
  options.include = options.include || '**/*.v';

  if (options.server) {
    var app = express();
    app.use(express.static(options.reportDirectory));
    var server = http.createServer(app);
    io = socketio.listen(server);
    io.set('log level', 0);
    server.listen(options.serverPort, function(err) {
      if (err) {
        log.error('Could not listen', err);
      }
    });
    log.info('Listening on http://localhost:' + options.serverPort);
  }

  if (options.watch) {
    var watchOpts;
    var watchFn = function(f, curr, prev) {
      if (typeof f == "object" && prev === null && curr === null) {
        return setTimeoutForRun();
      }

      if (f.indexOf(options.buildDirectory) >= 0 || !minimatch(f, options.filePattern)) {
        return false;
      }
      if (prev === null) {
        log.info('new file detected', f);
      } else if (curr.nlink === 0) {
        log.info('file deleted', f);
      } else {
        log.info('file changed', f);
      }

      return setTimeoutForRun();

      function setTimeoutForRun() {
        if (runTimeout) {
          clearTimeout(runTimeout);
        }
        runTimeout = setTimeout(function() {
          return run(options, callback);
        }, 100);
        return runTimeout;
      }
    };
    watchOpts = {
      ignoreDotFiles: true,
      filter: function(fileName, stats) {
        if (fileName.indexOf(options.buildDirectory) >= 0) {
          return true;
        }
        if (minimatch(fileName, options.filePattern)) {
          return false;
        }
        if (stats.isDirectory()) {
          log.info("adding directory: " + fileName);
          watch.watchTree(fileName, watchOpts, watchFn);
          return false;
        }
        return true;
      }
    };
    var runTimeout = null;
    return watch.watchTree(options.inputDirectory, watchOpts, watchFn);
  } else {
    return run(options, callback);
  }
};

function run(options, callback) {
  if (io) {
    io.sockets.emit('buildStarted');
  }
  return async.auto({
    outDirectory: mkdirp.bind(null, options.outDirectory),
    reportDirectory: mkdirp.bind(null, options.reportDirectory),
    files: getFileList.bind(null, options.inputDirectory, options.filePattern),
    testBenches: ['files', function(callback, data) {
      return getTestBenches(data.files, options.testBenchPattern, callback);
    }],
    compileTestBenches: ['outDirectory', 'testBenches', function(callback, data) {
      return compileTestBenches(data.testBenches, options.include, options.iverlogOpts, options.outDirectory, callback);
    }],
    runTestBenches: ['compileTestBenches', function(callback, data) {
      return runTestBenches(data.testBenches, options.include, callback);
    }],
    analyzeTestBenchesResults: ['runTestBenches', function(callback, data) {
      return analyzeTestBenchesResults(data.testBenches, callback);
    }],
    skeleton: ['reportDirectory', copySkeleton.bind(null, options.reportDirectory)],
    reports: ['analyzeTestBenchesResults', function(callback, data) {
      return createReports(data.testBenches, options.reportDirectory, callback);
    }]
  }, function(err) {
    log.info('run complete');
    if (io) {
      io.sockets.emit('buildComplete');
    }
    return callback(err);
  });
}

function getFileList(inputDirectory, filePattern, callback) {
  return glob(filePattern, { cwd: inputDirectory }, function(err, files) {
    if (err) {
      return callback(err);
    }
    files = files.map(path.relative.bind(null, process.cwd()));
    return callback(null, files);
  });
}

function getTestBenches(files, testBenchPattern, callback) {
  var testBenchFiles = files.filter(function(file) {
    return minimatch(file, testBenchPattern);
  });
  var nonTestBenchFiles = files.filter(function(file) {
    return !minimatch(file, testBenchPattern);
  });
  var testBenches = testBenchFiles.map(function(testBenchFile) {
    return {
      fileName: testBenchFile,
      dependencies: nonTestBenchFiles
    };
  });
  return callback(null, testBenches);
}

function compileTestBenches(testBenches, includePattern, iverlogOpts, outDirectory, callback) {
  testBenches = testBenches.filter(function(file) {
    return minimatch(file.fileName, includePattern);
  });

  return async.forEach(
    testBenches,
    function(testBench, callback) {
      return compileTestBench(testBench, iverlogOpts, outDirectory, callback);
    },
    callback);
}

function compileTestBench(testBench, iverlogOpts, outDirectory, callback) {
  testBench.iverilogOutput = '';
  testBench.outputFileName = path.join(outDirectory, testBench.fileName + '.out');
  mkdirp(path.dirname(testBench.outputFileName));

  var opts = [];
  opts = opts.concat(iverlogOpts);
  opts.push('-o' + testBench.outputFileName);
  opts = opts.concat(testBench.dependencies);
  opts.push(testBench.fileName);
  log.info('Running iverilog', opts.join(' '));
  var iverilog = spawn('iverilog', opts);
  iverilog.stdout.on('data', function(data) {
    testBench.iverilogOutput += data.toString();
  });
  iverilog.stderr.on('data', function(data) {
    testBench.iverilogOutput += data.toString();
  });
  iverilog.on('close', function(code) {
    testBench.iverilogExitCode = code;
    return callback(null, testBench);
  });
}

function runTestBenches(testBenches, includePattern, callback) {
  testBenches = testBenches.filter(function(file) {
    return minimatch(file.fileName, includePattern);
  });

  return async.forEach(
    testBenches,
    function(testBench, callback) {
      return runTestBench(testBench, callback);
    },
    callback);
}

function runTestBench(testBench, callback) {
  testBench.exitCode = '';
  if (testBench.iverilogExitCode !== 0) {
    log.warn('skipping test bench', testBench.fileName, ' exit code was not 0');
    return callback();
  }
  testBench.output = '';
  log.info('running test bench', testBench.fileName, ':', testBench.outputFileName);
  var testBenchOutputFile = spawn(testBench.outputFileName, []);
  testBenchOutputFile.stdout.on('data', function(data) {
    testBench.output += data.toString();
  });
  testBenchOutputFile.stderr.on('data', function(data) {
    testBench.output += data.toString();
  });
  testBenchOutputFile.on('close', function(code) {
    testBench.exitCode = code;
    return callback(null, testBench);
  });
}

function analyzeTestBenchesResults(testBenches, callback) {
  return async.forEach(
    testBenches,
    function(testBench, callback) {
      return analyzeTestBenchResults(testBench, callback);
    },
    callback);
}

function analyzeTestBenchResults(testBench, callback) {
  var errors = [];
  testBench.iverilogOutputHtml = testBench.iverilogOutput || '';
  testBench.outputHtml = colorizeTestBenchOutput(testBench.output, errors);

  if (testBench.iverilogExitCode != 0) {
    testBench.simpleResult = 'fail';
    testBench.result = 'iverilog failed';
  } else if (testBench.exitCode != 0) {
    testBench.simpleResult = 'fail';
    testBench.result = 'test bench run failed';
  } else {
    if (errors.length > 0) {
      testBench.simpleResult = 'fail';
      testBench.result = 'errors';
    } else {
      testBench.simpleResult = 'success';
      testBench.result = 'success';
    }
  }
  return callback();
}

function colorizeTestBenchOutput(output, errors) {
  output = output || '';
  var lines = output
    .split('\n')
    .map(function(line, i) {
      return "<a href='#line" + (i + 1) + "' name='line" + (i + 1) + "' class='lineNumber'>" + (i + 1) + "</a>: " + colorizeTestBenchOutputLine(line, errors);
    });

  return lines.join('\n');
}

function colorizeTestBenchOutputLine(line, errors) {
  var expected, found;

  var m = line.match(/assertEquals\((.*?),(.*?),(.*?)\)/);
  if (m) {
    var variableName = m[1];
    expected = m[2].trim();
    found = m[3].trim();
    if (expected != found) {
      line = '<span class="error">' + line + '</span>';
      errors.push({
        type: 'assertEquals',
        variableName: variableName,
        expected: expected,
        found: found
      });
    } else {
      line = '<span class="success">' + line + '</span>';
    }
  }

  m = line.match(/fail\((.*?)\)/);
  if (m) {
    var message = m[1];
    line = '<span class="error">' + line + '</span>';
    errors.push({
      type: 'fail',
      message: message
    });
  }

  return line;
}

function createReports(testBenches, reportDirectory, callback) {
  return async.auto({
    layoutTemplate: loadTemplate.bind(null, path.join(__dirname, '../templates/layout.ejs')),
    testBenchReportTemplate: loadTemplate.bind(null, path.join(__dirname, '../templates/testBenchReport.ejs')),
    testBenchSummaryReportTemplate: loadTemplate.bind(null, path.join(__dirname, '../templates/testBenchSummaryReport.ejs')),
    testBenchReports: ['layoutTemplate', 'testBenchReportTemplate', function(callback, data) {
      return createTestBenchReports(testBenches, data.layoutTemplate, data.testBenchReportTemplate, reportDirectory, callback);
    }],
    testBenchSummaryReport: ['layoutTemplate', 'testBenchSummaryReportTemplate', 'testBenchReports', function(callback, data) {
      return createTestBenchSummaryReport(testBenches, data.layoutTemplate, data.testBenchSummaryReportTemplate, reportDirectory, callback);
    }]
  }, callback);
}

function loadTemplate(fileName, callback) {
  return fs.readFile(fileName, 'utf8', function(err, str) {
    if (err) {
      return callback(err);
    }
    var template = ejs.compile(str);
    return callback(null, template);
  });
}

function createTestBenchReports(testBenches, layoutTemplate, testBenchReportTemplate, reportDirectory, callback) {
  return async.forEach(
    testBenches,
    function(testBench, callback) {
      return createTestBenchReport(testBench, layoutTemplate, testBenchReportTemplate, reportDirectory, callback);
    },
    callback);
}

function createTestBenchReport(testBench, layoutTemplate, testBenchReportTemplate, reportDirectory, callback) {
  testBench.reportFileName = path.join(reportDirectory, testBench.fileName + '.html');
  testBench.reportRelativeFileName = testBench.fileName + '.html';
  log.info('creating report for test bench', testBench.fileName, '->', path.relative(process.cwd(), testBench.reportFileName));
  var body = testBenchReportTemplate({
    testBench: testBench
  });
  var str = layoutTemplate({
    title: 'Test Bench: ' + testBench.fileName,
    body: body
  });
  return fs.writeFile(testBench.reportFileName, str, callback);
}

function createTestBenchSummaryReport(testBenches, layoutTemplate, testBenchSummaryReportTemplate, reportDirectory, callback) {
  var summaryReportFileName = path.join(reportDirectory, 'index.html');
  log.info('creating test bench summary report', path.relative(process.cwd(), summaryReportFileName));
  var body = testBenchSummaryReportTemplate({
    testBenches: testBenches
  });
  var str = layoutTemplate({
    title: 'Test Bench Summary',
    body: body
  });
  return fs.writeFile(summaryReportFileName, str, callback);
}

function copySkeleton(reportDirectory, callback) {
  var sourceDirectory = path.join(__dirname, '../skeleton');
  var syncdirOpts = {
    createDirectoryCallback: function(sourceDir, destDir, callback) {
      log.info('Creating directory:', path.relative(reportDirectory, destDir));
      return callback(null, true);
    },
    copyFileCallback: function(sourceFile, destFile, callback) {
      log.info('Creating file', path.relative(reportDirectory, destFile));
      return callback(null, true);
    }
  };
  return syncdir(sourceDirectory, reportDirectory, syncdirOpts, callback);
}
