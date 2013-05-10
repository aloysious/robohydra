#!/usr/bin/env node
/*global require, process, console, JSON, Buffer, __dirname*/

/**
 * Module dependencies.
 */

var http      = require('http'),
    https     = require('https'),
    fs        = require('fs'),
    qs        = require('qs'),
    commander = require('commander');
var robohydra    = require('../lib/robohydra'),
    Request      = robohydra.Request,
    Response     = robohydra.Response,
    stringForLog = robohydra.stringForLog;
var RoboHydraSummoner = require('../lib/robohydrasummoner').RoboHydraSummoner;


(function () {
    "use strict";

    commander.version('0.3.0+').
        usage("mysetup.conf [confvar=value confvar2=value2 ...]").
        option('-I <path>', 'Adds a new path in the plugin search path list').
        option('-p, --port <port>', 'Listen on this port (default 3000)', 3000).
        parse(process.argv);


    // This is a bit crappy as it uses the global commander
    // variable. But whaeva.
    function showHelpAndDie(message) {
        if (message) {
            console.log(message);
        }
        console.log(commander.helpInformation());
        process.exit(1);
    }


    // Process the options
    var extraPluginLoadPath = [];
    if (commander.I) {
        extraPluginLoadPath.push(commander.I);
    }
    // Check parameters and load RoboHydra configuration
    if (commander.args.length < 1) {
        showHelpAndDie();
    }
    var configPath = commander.args[0];
    var robohydraConfigString = fs.readFileSync(configPath, 'utf-8');
    var robohydraConfig = JSON.parse(robohydraConfigString);
    if (! robohydraConfig.plugins) {
        showHelpAndDie(configPath + " doesn't seem like a valid RoboHydra plugin (missing 'plugins' property in the top-level object)");
    }
    // After the second parameter, the rest is extra configuration variables
    var extraVars = {};
    for (var i = 1, len = commander.args.length; i < len; i++) {
        var varAndValue  = commander.args[i].split('=', 2);
        if (varAndValue.length !== 2) {
            showHelpAndDie();
        } else {
            extraVars[varAndValue[0]] = varAndValue[1];
        }
    }

    var summoner = new RoboHydraSummoner(
        robohydraConfig.plugins,
        robohydraConfig.summoner,
        {extraVars: extraVars, extraPluginLoadPaths: extraPluginLoadPath}
    );
    // This merely forces a default Hydra to be created. It's nice because
    // it forces plugins to be loaded, and we get plugin loading errors
    // early
    summoner.summonRoboHydraForRequest(new Request({url: '/'}));

    // Routes are all dynamic, so we only need a catch-all here
    var requestHandler = function(nodeReq, nodeRes) {
        var req = new Request({
            url: nodeReq.url,
            method: nodeReq.method,
            headers: nodeReq.headers
        });
        var res = new Response().chain(nodeRes).
            on('end', function(evt) {
                console.log(stringForLog(nodeReq, evt.response));
            });

        // Fetch POST data if available
        nodeReq.addListener("data", function (chunk) {
            var tmp = new Buffer(req.rawBody.length + chunk.length);
            req.rawBody.copy(tmp);
            chunk.copy(tmp, req.rawBody.length);
            req.rawBody = tmp;
        });
        nodeReq.addListener("end", function () {
            try {
                req.bodyParams = qs.parse(req.rawBody.toString());
            } catch(e) {
                // It's ok if qs can't parse the body
            }

            summoner.summonRoboHydraForRequest(req).handle(req, res);
        });
    };

    var server;
    if (robohydraConfig.secure) {
        var sslOptionsObject = {};
        var keyPath  = robohydraConfig.sslOptions.key,
            certPath = robohydraConfig.sslOptions.cert;
        try {
            sslOptionsObject.key  = fs.readFileSync(keyPath);
            sslOptionsObject.cert = fs.readFileSync(certPath);
        } catch(e) {
            console.log("Could not read the HTTPS key or certificate file.");
            console.log("Paths were '" + keyPath + "' and '" + certPath + "'.");
            console.log("You must set properties 'key' and 'cert' inside 'sslOptions'.");
            process.exit(1);
        }
        server = https.createServer(sslOptionsObject, requestHandler);
    } else {
        server = http.createServer(requestHandler);
    }


    server.on('error', function (e) {
        if (e.code === 'EADDRINUSE') {
            console.log("Couldn't listen in port " + commander.port +
                        ", aborting.");
        }
    });
    server.listen(commander.port, function() {
        var adminUrl = "http://localhost:" + commander.port + "/robohydra-admin";
        console.log("RoboHydra ready on port %d - Admin URL: %s",
                    commander.port, adminUrl);
    });
}());
