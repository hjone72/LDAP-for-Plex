// Imports
var request = require('request');
var uuid = require('uuid');
var parseString = require('xml2js').parseString;
var ldap = require('ldapjs');   
var crypto = require('crypto');
var fs = require('fs');

const defaults = {
    debug: false,
    port: 2389,
    rootDN: 'ou=users, o=plex.tv',
    plexToken: '',
    plexMachineID: '',
    plexServerName: ''
};

const optionsFile = 'config/options.json';
const configFolder = 'config/'

if(!fs.existsSync(optionsFile) && !fs.existsSync(configFolder)) {
    fs.mkdirSync(configFolder);
    var json = JSON.stringify(defaults, null, '\t');
    fs.writeFileSync(optionsFile, json);
    console.log("Please fill out config/options.json");
    return;
} else if (!fs.existsSync(optionsFile)) {
    var json = JSON.stringify(defaults, null, '\t');
    fs.writeFileSync(optionsFile, json);
    console.log("Please fill out config/options.json");
    return;
}

var config = require('./config/options.json');

// Configuration
var version = '0.2';
var debug = config.debug;
var ldapPort = config.port;
var rootDN = config.rootDN; // This can be anything you like. It won't change anything though.
var plexToken = config.plexToken; // Your Plex token. This is used to get your friends list.
var plexMachineID = config.plexMachineID; // Only allow servers that have this MachineID.
var plexServerName = config.plexServerName; // The name of your server.

// Variables
var plexUser;
var server = ldap.createServer();

const headers = {
    'X-Plex-Client-Identifier': uuid.v4(),
    'X-Plex-Product': 'LDAP for Plex',
    'X-Plex-Device': 'LDAP for Plex',
    'X-Plex-Version': 'v' + version,
    'content-Type': 'application/xml; charset=utf-8',
    'Content-Length': 0
};

var options = {
    url: 'https://plex.tv/users/sign_in.json',
    method: 'POST',
    headers: headers
};

var db = {};        // In memory database. This also acts as a cache.

// Functions
function authHeaderVal(username, password) {
    // Generate a value based on UN and PW to send with the header for authentication.
    var authString = username + ':' + password;
    var buffer = new Buffer(authString.toString(), 'binary');
    return 'Basic ' + buffer.toString('base64');
}

/*
 function hashServer(server) {
 // <Server name="!PlexyName!" machineIdentifier="abcd" createdAt="1234"/>
 var toMD5 = server.name + server.machineIdentifier + server.createdAt;
 var serverHash = crypto.createHash('md5').update(toMD5).digest("hex");
 serverDB[serverHash] = server.name;
 }
 */

function log(msg) {
    if (debug) {
        console.log(msg);
    }
}

function loadPlexUser(username, password) {
    var loginHeaders = headers;
    loginHeaders.Authorization = authHeaderVal(username, password);
    var loginOptions = options;
    loginOptions.headers = loginHeaders;

    return new Promise(function (resolve, reject) {
        request(loginOptions, function (err, res, body) {
            if (!err && (res.statusCode == 200 || res.statusCode == 201)) {
                plexUser = (JSON.parse(body).user);
                plexUserToLDAP(plexUser);
                return resolve(plexUser);
            } else {
                return reject(body);
            }
        });
    });
}

function plexUserToLDAP(pUser, servers) {
    var obj = {
        attributes: {
            objectclass: ['Plex.tv User'],
            cn: pUser.username,
            uid: pUser.id,
            email: pUser.email,
            title: pUser.title,
            thumb: pUser.thumb,
            o: 'plex.tv'
        }
    };

    if (servers) {
        servers.forEach(function (server) {
            if (plexMachineID == server.$.machineIdentifier) {
                obj.attributes.groups = [server.$.name];
            }
        });
    }

    db['uid=' + pUser.id + ', ' + rootDN] = obj;
}

function loadPlexUsers(token) {
    return new Promise(function (resolve, reject) {
        var loadMe = function (callback) {
            request('https://plex.tv/users/account?X-Plex-Token=' + token, function (err, res, body) {
                // Load in the current user. You don't appear in your own friends list.
                if (!err && res.statusCode == 200) {
                    parseString(body, function (err, result) {
                        var me = result.user.$;
                        me.username = result.user.username;
                        var server = {$: {machineIdentifier: plexMachineID, name: plexServerName}}; // You don't appear in your friends list. Build some information so that you can auth too.
                        plexUserToLDAP(me, [server]);
                    });
                } else {
                    log(body);
                    return reject();
                }
            });
        };
        request('https://plex.tv/api/users?X-Plex-Token=' + token, function (err, res, body) {
            if (!err && res.statusCode == 200) {
                parseString(body, function (err, result) {
                    var users = result.MediaContainer.User;
                    users.forEach(function (user) {
                        plexUserToLDAP(user.$, user.Server);
                    });
                    return loadMe(resolve());
                });
            } else {
                log(body);
                return reject();
            }
        });
    });
}

// Start //
// LDAP Server //
if (plexToken === '') {
    console.log('A valid Plex token is required...');
    process.exit();
} else {
    // Preload database.
    console.log('Preloading Plex users...');
    loadPlexUsers(plexToken)
        .then(function () {
            console.log('Database loaded.');
            server.listen(ldapPort, function () {
                console.log('LDAP for Plex server up at: %s', server.url);
            });
        })
        .catch();
}

server.bind(rootDN, function (req, res, next) {
    log('bindDN: ' + req.dn.toString());

    if (db[req.dn.toString()]) {
        var username = db[req.dn.toString()].attributes.cn;
    } else {
        return next(new ldap.NoSuchObjectError(dn));
    }

    loadPlexUser(username, req.credentials)
        .then(function (user) {
            res.end();
            return next();
        })
        .catch(function (err) {
            console.log(err);
            return next(new ldap.InvalidCredentialsError());
        });
});

server.search(rootDN, function (req, res, next) {
    log('base object: ' + req.dn.toString());
    log('scope: ' + req.scope);
    log('filter: ' + req.filter.toString());

    var dn = req.dn.toString();
    var scopeCheck;
    var filled = false;

    var search = function (req, res, next) {
        switch (req.scope) {
            case 'base':
                if (rootDN !== dn) {
                    if (!db[dn]) {
                        return next(new ldap.NoSuchObjectError(dn));
                    }
                    if (req.filter.matches(db[dn].attributes)) {
                        filled = true;
                        res.send({
                            dn: dn,
                            attributes: db[dn].attributes
                        });
                    }

                    res.end();
                    return next();
                }

            case 'one':
                scopeCheck = function (k) {
                    if (req.dn.equals(k)) {
                        return true;
                    }

                    var parent = ldap.parseDN(k).parent();
                    return (parent ? parent.equals(req.dn) : false);
                };
                if (req.filter.toString() == '(objectclass=*)' && req.dn.toString() !== rootDN) {
                    res.end();
                    return next();
                }
                break;

            case 'sub':
                scopeCheck = function (k) {
                    return (req.dn.equals(k) || req.dn.parentOf(k));
                };

                break;
        }

        Object.keys(db).forEach(function (key) {
            if (!scopeCheck(key)) {
                log('Skipping this key as scopeCheck returned false. ' + key);
                return;
            }

            if (req.filter.matches(db[key].attributes)) {
                filled = true;
                res.send({
                    dn: 'uid=' + db[key].attributes.uid + ', ' + rootDN,
                    attributes: db[key].attributes
                });
            }
        });

        if (filled) {
            log('request is reported as filled.');
            res.end();
            return next();
        }
    };

    search(req, res, next);
    if (!filled) {
        // Load database again. There may have been changes.
        loadPlexUsers(plexToken)
            .then(function () {
                log('Database reloaded.');
                filled = true;
                search(req, res, next);
            })
    }
});
