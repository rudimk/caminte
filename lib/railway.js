var fs = require('fs');
var path = require('path');
var Schema = require('./schema').Schema;

var existsSync = fs.existsSync || path.existsSync;

if (global.railway) {
    railway.orm._schemas = [];
}

module.exports = function init(root) {
    var railway, app, models;

    if (typeof root !== 'object' || root.constructor.name !== 'Railway') {
        railway = global.railway;
        app = global.app;
        models = app.models;
    } else {
        railway = root;
        app = railway.app;
        root = railway.root;
        models = railway.models;
    }

    railway.orm._schemas = [];

    var confFile = (root || app.root) + '/config/database';
    var config;

    if (existsSync(confFile + '.json')) {
        try {
            config = JSON.parse(fs.readFileSync(confFile + '.json', 'utf-8'))[app.set('env')];
        } catch (e) {
            console.log('Could not parse config/database.json');
            throw e;
        }
    } else if (existsSync(confFile + '.yml')) {
        try {
            config = railway.utils.readYaml(confFile + '.yml')[app.set('env')];
        } catch (e) {
            console.log('Could not parse config/database.yml');
            throw e;
        }
        config = {};
    }
    // when driver name started with point - look for driver in app root (relative path)
    if (config.driver && config.driver.match(/^\./)) {
        config.driver = path.join(app.root, config.driver);
    }

    var schema = new Schema(config && config.driver || 'memory', config);
    schema.log = log;
    railway.orm._schemas.push(schema);

var context = prepareContext(models, railway, app, schema);

// run schema first
var schemaFile = (root || app.root) + '/db/schema.';
if (existsSync(schemaFile + 'js')) {
    schemaFile += 'js';
} else if (existsSync(schemaFile + 'coffee')) {
    schemaFile += 'coffee';
} else {
    schemaFile = false;
}

if (schemaFile) {
    var code = fs.readFileSync(schemaFile).toString();
    if (schemaFile.match(/\.coffee$/)) {
        code = require('coffee-script').compile(code);
    }
    var fn = new Function('context', 'require', 'with(context){(function(){' + code + '})()}');
    fn(context, require);
}

// and freeze schemas
railway.orm._schemas.forEach(function (schema) {
    schema.freeze();
});

// check validations and display warning

var displayWarning = false;
Object.keys(models).forEach(function (model) {
    var Model = models[model];
    if (Model._validations) {
        displayWarning = true;
    }
});

if (displayWarning) {
    var $ = railway.utils.stylize.$;
    // require('util').puts($('WARNING:').bold.red + ' ' + $('I can see that you\'ve added validation to db/schema.js. However schema.js file is only used to describe database schema. Therefore validations configured in db/schema.js will be ignored.\nFor business logic (incl. validations) please create models as separate .js files here: app/models/*.js').yellow);
}

function log(str, startTime) {
    var $ = railway.utils.stylize.$;
    var m = Date.now() - startTime;
    railway.utils.debug(str + $(' [' + (m < 10 ? m : $(m).red) + ' ms]').bold);
    app.emit('app-event', {
        type: 'query',
        param: str,
        time: m
    });
}

function prepareContext(models, railway, app, defSchema, done) {
    var ctx = {app: app},
        _models = {},
        settings = {},
        cname,
        schema,
        wait = connected = 0,
        nonJugglingSchema = false;

    done = done || function () {};

    /**
     * Multiple schemas support
     * example:
     * schema('redis', {url:'...'}, function () {
     *     describe models using redis connection
     *     ...
     * });
     * schema(function () {
     *     describe models stored in memory
     *     ...
     * });
     */
    ctx.schema = function () {
        var name = argument('string');
        var opts = argument('object') || {};
        var def = argument('function') || function () {};
        schema = new Schema(name || opts.driver || 'memory', opts);
        railway.orm._schemas.push(schema);
        wait += 1;
        ctx.gotSchema = true;
        schema.on('log', log);
        schema.on('connected', function () {
            if (wait === ++connected) done();
        });
        def();
        schema = false;
    };

    /**
     * Use custom schema driver
     */
    ctx.customSchema = function () {
        var def = argument('function') || function () {};
        nonJugglingSchema = true;
        def();
        Object.keys(ctx.exports).forEach(function (m) {
            ctx.define(m, ctx.exports[m]);
        });
        nonJugglingSchema = false;
    };
    ctx.exports = {};
    ctx.module = { exports: ctx.exports };

    /**
     * Define a class in current schema
     */
    ctx.describe = ctx.define = function (className, callback) {
        var m;
        cname = className;
        _models[cname] = {};
        settings[cname] = {};
        if (nonJugglingSchema) {
            m = callback;
        } else {
            callback && callback();
            m = (schema || defSchema).define(className, _models[cname], settings[cname]);
        }
        if (global.railway) {
            global[cname] = m;
        }
        return models[cname] = ctx[cname] = m;
    };

    /**
     * Define a property in current class
     */
    ctx.property = function (name, type, params) {
        if (!params) params = {};
        if (typeof type !== 'function' && typeof type === 'object') {
            params = type;
            type = String;
        }
        params.type = type || String;
        _models[cname][name] = params;
    };

    /**
     * Set custom table name for current class
     * @param name - name of table
     */
    ctx.setTableName = function (name) {
        if (cname) settings[cname].table = name;
    };

    ctx.Text = Schema.Text;

    return ctx;

    function argument(type) {
        var r;
        [].forEach.call(arguments.callee.caller.arguments, function (a) {
            if (!r && typeof a === type) r = a;
        });
        return r;
    }
}

};