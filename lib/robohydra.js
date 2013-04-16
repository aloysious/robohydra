var fs     = require('fs'),
    path   = require('path'),
    assert = require('assert');
var heads = require('./heads');
var utils              = require('./utils.js'),
    serveStaticFile    = utils.serveStaticFile,
    proxyRequest       = utils.proxyRequest,
    Request            = utils.Request,
    Response           = utils.Response;
var exceptions         = require('./exceptions.js'),
    RoboHydraException = exceptions.RoboHydraException,
    DuplicateRoboHydraHeadNameException =
        exceptions.DuplicateRoboHydraHeadNameException,
    InvalidRoboHydraConfigurationException =
        exceptions.InvalidRoboHydraConfigurationException,
    InvalidRoboHydraPluginException =
        exceptions.InvalidRoboHydraPluginException,
    RoboHydraPluginNotFoundException =
        exceptions.RoboHydraPluginNotFoundException,
    InvalidRoboHydraNextParametersException =
        exceptions.InvalidRoboHydraNextParametersException,
    RoboHydraHeadNotFoundException =
        exceptions.RoboHydraHeadNotFoundException,
    InvalidRoboHydraTestException =
        exceptions.InvalidRoboHydraTestException;


(function () {
    "use strict";

    var RoboHydra = function(extraAdminPluginConfig) {
        this._plugins    = [];
        this._headMap    = {};
        this.currentTest = {plugin: '*default*',
                            test:   '*default*'};
        this.testResults = {'*default*': {'*default*': {result: undefined,
                                                        passes: [],
                                                        failures: []}}};

        // Register special plugins
        // Admin
        var adminPlugin = require('./plugins/admin.js');
        var adminPluginConfig = {};
        for (var p in extraAdminPluginConfig) {
            adminPluginConfig[p] = extraAdminPluginConfig[p];
        }
        adminPluginConfig.robohydra = this;
        adminPlugin.heads = adminPlugin.getBodyParts(adminPluginConfig);
        this._registerPluginObject(adminPlugin);
        // Dynamic heads
        this._registerPluginObject({name: '*dynamic*', heads: []});
        // Current test heads
        this._registerPluginObject({name: '*current-test*', heads: []});
    };
    RoboHydra.prototype._validatePluginName = function(pluginName) {
        return (typeof(pluginName) === 'string' &&
                pluginName.match(new RegExp('^[a-z0-9_-]+$', 'i')));
    };
    RoboHydra.prototype._addHeadsToPluginStructure = function(heads, pluginStructure) {
        var anonymousHeadCount = 0;
        heads.forEach(function(head) {
            // Calculate head name if not specified
            if (head.name === undefined) {
                head.name = 'anonymousHead' + anonymousHeadCount;
                anonymousHeadCount++;
                while (pluginStructure.headMap.hasOwnProperty(head.name)) {
                    head.name = 'anonymousHead' + anonymousHeadCount;
                    anonymousHeadCount++;
                }
            }

            if (pluginStructure.headMap.hasOwnProperty(head.name)) {
                throw new DuplicateRoboHydraHeadNameException(head.name);
            }
            pluginStructure.headMap[head.name] = head;
        });
    };
    RoboHydra.prototype._registerPluginObject = function(plugin) {
        var name = plugin.name;
        if (this._getPluginInfo(plugin.name)) {
            throw new InvalidRoboHydraConfigurationException(
                "Duplicate plugin '" + name + "'");
        }

        var pluginToRegister = {
            name:  plugin.name,
            heads: plugin.heads || [],
            tests: plugin.tests || {}
        };

        var pluginInternalStructure = {headMap: {}, plugin: pluginToRegister};
        this._addHeadsToPluginStructure(pluginToRegister.heads,
                                        pluginInternalStructure);
        this._plugins.push(pluginInternalStructure);
    };
    RoboHydra.prototype.registerPluginObject = function(pluginObject) {
        var plugin = this._inflatePlugin(pluginObject);
        plugin.name = pluginObject.name;

        if (! this._validatePluginName(plugin.name)) {
            throw new InvalidRoboHydraPluginException("Invalid plugin name '" +
                                                      plugin.name + "'");
        }
        var hasHeads = (typeof plugin.heads === 'object') && plugin.heads.length;
        var hasTests = false;
        if (typeof(plugin.tests) === 'object') {
            for (var t in plugin.tests) {
                if (plugin.tests.hasOwnProperty(t)) { hasTests = true; }
            }
        }
        if (!hasHeads && !hasTests) {
            throw new InvalidRoboHydraPluginException("Plugin doesn't have any heads or tests");
        }

        this._registerPluginObject(plugin);
    };
    RoboHydra.prototype.registerDynamicHead = function(head) {
        var done = false;
        var pluginInfo = this._getPluginInfo('*dynamic*');
        if (pluginInfo) {
            this._addHeadsToPluginStructure([head], pluginInfo);
            pluginInfo.plugin.heads.push(head);
            done = true;
        }
        if (! done) {
            throw "Internal error: couldn't find the dynamic head plugin";
        }
    };
    RoboHydra.prototype.getPluginNames = function() {
        return this.getPlugins().map(function(p) { return p.name; });
    };
    RoboHydra.prototype.getPlugins = function() {
        return this._plugins.map(function(v) { return v.plugin; });
    };
    RoboHydra.prototype._getPluginInfo = function(pluginName) {
        var pluginList = this._plugins.filter(function(p) {
            return p.plugin.name === pluginName;
        });
        return pluginList.length ? pluginList[0] : undefined;
    };
    RoboHydra.prototype.getPlugin = function(pluginName) {
        var pluginInfo = this._getPluginInfo(pluginName);
        if (pluginInfo === undefined) {
            throw new RoboHydraPluginNotFoundException(pluginName);
        } else {
            return pluginInfo.plugin;
        }
    };
    RoboHydra.prototype.headForPath = function(url, afterHead) {
        var canMatch = !afterHead;
        for (var i = 0, len = this._plugins.length; i < len; i++) {
            var plugin = this._plugins[i].plugin;
            for (var j = 0, len2 = plugin.heads.length; j < len2; j++) {
                if (canMatch && plugin.heads[j].canHandle(url)) {
                    return {plugin: plugin, head: plugin.heads[j]};
                }

                if (typeof afterHead === 'object' &&
                    this._plugins[i].plugin.name === afterHead.plugin.name &&
                    plugin.heads[j].name  === afterHead.head.name) {
                    canMatch = true;
                }
            }
        }
        return undefined;
    };
    RoboHydra.prototype.handle = function(req, res, afterHead) {
        var r = this.headForPath(req.url, afterHead);
        if (r !== undefined) {
            res.statusCode = 200;
            var self = this;
            r.head.handle(req, res, function(req2, res2) {
                if (arguments.length !== 2) {
                    throw new InvalidRoboHydraNextParametersException(
                        r.plugin,
                        r.head,
                        arguments
                    );
                }
                self.handle(req2, res2, r);
            });
        } else {
            res.statusCode = 404;
            res.send("Not Found");
        }
    };
    RoboHydra.prototype.findHead = function(pluginName, headName) {
        var pluginInfo = this._getPluginInfo(pluginName);
        if (pluginInfo) {
            var head = pluginInfo.headMap[headName];
            if (head === undefined) {
                throw new RoboHydraHeadNotFoundException(pluginName, headName);
            } else {
                return head;
            }
        }
        throw new RoboHydraHeadNotFoundException(pluginName, headName);
    };
    RoboHydra.prototype.isHeadAttached = function(pluginName, headName) {
        // This will throw an exception if the head is not found
        var head = this.findHead(pluginName, headName);
        return head.attached();
    };
    RoboHydra.prototype.detachHead = function(pluginName, headName) {
        this.findHead(pluginName, headName).detach();
    };
    RoboHydra.prototype.attachHead = function(pluginName, headName) {
        this.findHead(pluginName, headName).attach();
    };
    RoboHydra.prototype._jsFilesIn = function(testDir) {
        var testFiles = [];
        try {
            testFiles = fs.readdirSync(testDir).filter(function(fname) {
                return (/\.js/).test(fname);
            });
        } catch(e) {
            if (e.code !== 'ENOENT') {
                throw e;
            }
        }
        return testFiles;
    };
    RoboHydra.prototype._inflatePlugin = function(pluginInfo) {
        var finalPluginConfig = {robohydra: this, path: pluginInfo.path};
        for (var p in pluginInfo.config) {
            finalPluginConfig[p] = pluginInfo.config[p];
        }
        var modulesObject = this.getModulesObject(finalPluginConfig);
        var pluginObject = pluginInfo.module.getBodyParts(
            finalPluginConfig,
            modulesObject
        );

        // Loads any external test files
        var testDir = path.join(pluginInfo.path, 'tests');
        this._jsFilesIn(testDir).forEach(function(testFile) {
            var testModule = require(path.join(testDir, testFile));
            var testDefinition = testModule.getBodyParts(finalPluginConfig,
                                                         modulesObject);
            var testName = testFile.replace(/\.js$/, '');
            pluginObject.tests = pluginObject.tests || {};
            if (testName in pluginObject.tests) {
                throw new InvalidRoboHydraPluginException("Test '" +
                                                          testName +
                                                          "' is duplicated");
            }
            pluginObject.tests[testName] = testDefinition;
        });

        return pluginObject;
    };
    RoboHydra.prototype.startTest = function(pluginName, testName) {
        this.stopTest();
        var found = false;
        var testPlugin;
        var pluginInfo = this._getPluginInfo(pluginName);
        if (pluginInfo) {
            if (pluginInfo.plugin.tests.hasOwnProperty(testName)) {
                testPlugin = pluginInfo.plugin;
                this.currentTest = {plugin: pluginName, test: testName};
                found = true;
            }
        }

        if (found) {
            var done = false;
            var currentTestInfo = this._getPluginInfo('*current-test*');
            if (currentTestInfo) {
                var heads = testPlugin.tests[testName].heads;
                this._addHeadsToPluginStructure(heads, currentTestInfo);
                Array.prototype.push.apply(currentTestInfo.plugin.heads, heads);
                done = true;
            }

            if (done) {
                this.testResults[pluginName] = this.testResults[pluginName] || {};
                this.testResults[pluginName][testName] = {result: undefined,
                                                          passes: [],
                                                          failures: []};
            }
        } else {
            throw new InvalidRoboHydraTestException(pluginName, testName);
        }
    };
    RoboHydra.prototype.stopTest = function() {
        this.currentTest = {plugin: '*default*', test: '*default*'};

        for (var i = 0, len = this._plugins.length; i < len; i++) {
            if (this._plugins[i].plugin.name === '*current-test*') {
                this._plugins[i] = {headMap: {},
                                    plugin: {name: '*current-test*', heads: []}};
            }
        }
    };
    RoboHydra.prototype.getAssertionFunction = function(assertion) {
        var thisRoboHydra = this;
        return function() {
            var currentTestPlugin = thisRoboHydra.currentTest.plugin,
                currentTestName   = thisRoboHydra.currentTest.test;
            var result =
                    thisRoboHydra.testResults[currentTestPlugin][currentTestName];

            var assertionFunction = assert[assertion];
            var message = arguments[assertionFunction.length-1] ||
                    "*unnamed-assertion*";

            try {
                assertionFunction.apply(assert, arguments);

                result.passes.push(message);
                result.result = result.result || 'pass';
            }
            catch (e) {
                if (e instanceof assert.AssertionError) {
                    result.failures.push(message);
                    result.result = 'fail';
                    return false;
                } else {
                    throw e;
                }
            }
            return true;
        };
    };
    RoboHydra.prototype.getModulesObject = function(conf) {
        var utilsObject = {assert: {}, fixtures: {}};

        // Assertions
        for (var assertion in assert) {
            if (assert.hasOwnProperty(assertion) && typeof assert[assertion] === 'function') {
                utilsObject.assert[assertion] =
                    this.getAssertionFunction(assertion);
            }
        }

        // Fixture loading (add caching?)
        utilsObject.fixtures.load = function(fixturePath) {
            var normalizedFixturePath = path.normalize(fixturePath);
            var sanitizedFixturePath =
                    normalizedFixturePath.replace(new RegExp("\\.\\.", "g"), "");
            var stringPath = path.join(conf.path, "fixtures", sanitizedFixturePath);
            return fs.readFileSync(stringPath);
        };

        return utilsObject;
    };


    exports.RoboHydra          = RoboHydra;
    exports.Request            = Request;
    exports.Response           = Response;
    exports.serveStaticFile    = serveStaticFile;
    exports.proxyRequest       = proxyRequest;
    exports.heads              = heads;
    exports.roboHydraHeadType  = heads.roboHydraHeadType;
    exports.RoboHydraException = RoboHydraException;
    for (var exception in exceptions) {
        exports[exception] = exceptions[exception];
    }
}());
