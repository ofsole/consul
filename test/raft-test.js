#!/usr/local/bin/node
var Docker = require('dockerode');
var Consul = require('consul');
var async = require('async');

// dockerode will automatically pick up your DOCKER_HOST, DOCKER_CERT_PATH
// but we need to set the version explicitly to support Triton
// ref https://github.com/apocas/dockerode/issues/154
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
var docker = new Docker();
docker.version = 'v1.20';

listConsul(function (err, consulNodes) {
    if (err) {
        console.log(err);
        return;
    }
    switch (consulNodes.length) {
    case 3:
        console.log('Running 3-node raft tests.');
        run3NodeTests(consulNodes);
        break;
    case 5:
        console.log('Running 5-node raft tests.');
        run5NodeTests(consulNodes);
        break;
    default:
        console.log(consulNodes.length + ' Consul nodes up.');
        console.log('We need exactly 3 or 5 nodes to be up. Exiting.');
        break;
    }
    return;
});

// runs a series of tests on raft behavior for a 3-node Consul cluster
function run3NodeTests(consulNodes) {
    console.log('Bootstrap node is:', consulNodes[0].Name);
    waitForElection(consulNodes, function (err, result) {
        if (err) {
            console.log(err);
            return;
        }
        console.log('raft is healthy: ', result);
        async.series([
            function (cb) { test3_1(consulNodes, cb); },
            function (cb) { test3_2(consulNodes, cb); },
            function (cb) { test3_3(consulNodes, cb); }
        ], function (errResult, testResults) {
            if (errResult) {
                console.log(errResult);
            } else {
                for (var i in testResults) {
                    if (!testResults[i]) {
                        console.log('Failed!', testResults);
                        return;
                    }
                }
                console.log('Passed!');
            }
        });
    });
}

// Runs a series of tests on raft behavior for a 5-node Consul cluster
function run5NodeTests(consulNodes) {
    console.log('Bootstrap node is:', consulNodes[0].Names[0]);
    waitForElection(consulNodes, function (err, result) {
        if (err) {
            console.log(err);
            return;
        }
        console.log('raft is healthy: ', result);
        async.series([
            function (cb) { test5_1(consulNodes, cb); },
            function (cb) { test5_2(consulNodes, cb); }
        ], function (errResult, testResults) {
            if (errResult) {
                console.log(errResult);
            } else {
                for (var i in testResults) {
                    if (!testResults[i]) {
                        console.log('Failed!', testResults);
                        return;
                    }
                }
                console.log('Passed!');
            }
        });
    });
}


// Test that a non-bootstrap node rejoins the raft after reboot
function test3_1(consulNodes, callback) {
    console.log('[test3_1] -----------------------------');
    var consul1 = consulNodes[0],
        consul2 = consulNodes[1],
        consul3 = consulNodes[2];

    async.series([
        function (cb) { stop(consul3, cb); },
        function (cb) { waitForElection([consul1, consul2], cb); },
        function (cb) { start(consul3, cb); },
        function (cb) { waitForElection(consulNodes, cb); }
    ], function (err, results) {
        callback(err, results[results.length - 1]);
    });
}

// Test that the bootstrap node rejoins the same raft after reboot
function test3_2(consulNodes, callback) {
    console.log('[test3_2] -----------------------------');
    var consul1 = consulNodes[0],
        consul2 = consulNodes[1],
        consul3 = consulNodes[2];

    async.series([
        function (cb) { stop(consul1, cb); },
        function (cb) { waitForElection([consul2, consul3], cb); },
        function (cb) { start(consul1, cb); },
        function (cb) { waitForElection(consulNodes, cb); }
    ], function (err, results) {
        callback(err, results[results.length - 1]);
    });
}

// Test that non-bootstrap nodes rejoin the raft even if bootstrap
// node is gone
function test3_3(consulNodes, callback) {
    console.log('[test3_3] -----------------------------');
    var consul1 = consulNodes[0],
        consul2 = consulNodes[1],
        consul3 = consulNodes[2];

    async.series([
        function (cb) { stop(consul1, cb); },
        function (cb) { stop(consul3, cb); },
        function (cb) { start(consul3, cb); },
        function (cb) { waitForElection([consul3, consul2], cb); },
        function (cb) { start(consul1, cb); },
        function (cb) { waitForElection(consulNodes, cb); }
    ], function (err, results) {
        callback(err, results[results.length - 1]);
    });
}

// Test that consistent reads fail without quorum but that they become
// available after partition heals
function test5_1(consulNodes, callback) {
    var consul1 = consulNodes[0],
        consul2 = consulNodes[1],
        consul3 = consulNodes[2],
        consul4 = consulNodes[3],
        consul5 = consulNodes[4];

    async.series([
        function (cb) { stop(consul1, cb); },
        function (cb) { stop(consul2, cb); },
        function (cb) { testWrites([consul3, consul4, consul5],
                                   'stale', true, cb); },
        function (cb) { testWrites([consul3, consul4, consul5],
                                   'consistent', false, cb); },
        function (cb) { start(consul2, cb); },
        function (cb) { waitForElection(consulNodes.slice(1), cb); },
        function (cb) { testWrites([consul3, consul4, consul5],
                                   'consistent', true, cb); },
        function (cb) { start(consul1, cb); },
        function (cb) { waitForElection(consulNodes, cb); }
    ], function (err, results) {
        callback(err, results[results.length - 1]);
    });
}

// Test that majority writes win after raft heals
function test5_2(consulNodes, callback) {
    var consul1 = consulNodes[0],
        consul2 = consulNodes[1],
        consul3 = consulNodes[2],
        consul4 = consulNodes[3],
        consul5 = consulNodes[4];

    async.series([
        function (cb) { createNetsplit([consul1, consul2],
                                       [consul3, consul4, consul5], cb); },
        function (cb) { testWrites([consul1, consul2],
                                   'stale', true, cb); },
        function (cb) { testWrites([consul1, consul2],
                                   'consistent', false, cb); },
        function (cb) { healNetsplit([consul1, consul2, consul3,
                                      consul4, consul5], cb); },
        function (cb) { waitForElection(consulNodes, cb); },
        function (cb) { testWrites([consul1, consul2],
                                   'consistent', true, cb); }
    ], function (err, results) {
        callback(err, results[results.length - 1]);
    });
}


// Queries Consul to determine the status of the raft. Compares the status
// against a list of containers and verifies that the leader is among those
// nodes. If failing, will retry twice with some backoff and then return
// error to the callback if the raft still has not healed.
// @param    {containers} array of container objects from our Consul nodes
//           array that should be members of the raft.
// @callback {callback} function(err, result)
function waitForElection(containers, callback) {

    var expected = [];
    containers.forEach(function (container) {
        expected.push(container.Ip+':8300');
    });
    expected.sort();
    console.log('expected peers:', expected.toString());

    var isMatch = false;
    var count = 0;
    var maxCount = 3;

    async.doUntil(
        function (cb) {
            getLeader(containers[0], function (err, leader) {
                if (err || !leader) {
                    cb(err);
                    return;
                }
                isMatch = (expected.indexOf(leader) != -1);
                cb(null);
            });
        },
        function () {
            count++;
            return (isMatch || count >= maxCount);
        },
        function (err) {
            if (err) {
                return callback(err, false);
            } else {
                if (!isMatch) {
                    return callback(('error: raft leader is not '+
                                     'among expected nodes'), null);
                }
                console.log('raft leader is among expected nodes');
                return callback(null, true);
            }
        });
}

// @param    {[containers]} array of container objects from our Consul
//                          nodes array that we want to test writes against
// @callback {callback} function(err, result)
function testWrites(containers, consistency, expectPass, callback) {
    // TODO: implementation
    console.log('testWrites:', containers.length, consistency,
                'expectPass:', expectPass);
    callback(null, 'testWrites');
}

function createNetsplit(group1, group2, callback) {
    // TODO: implementation
    console.log(group1);
    console.log(group2);
    console.log(callback);
}

function healNetsplit(containers, callback) {
    // TODO: implementation
    console.log(containers);
    console.log(callback);
}


// Create an array of containers labelled with the service 'consul',
// sorted by name
// @callback {fn} function(err, result)
function listConsul(callback) {
    var consul = [];
    docker.listContainers(
        {all: false,
         filters: ['{"label":["com.docker.compose.service=consul"]}']},
        function (err, containers) {
            if (err) {
                callback(err, null);
                return;
            }
            async.each(containers, function (container, cb) {
                var cmd = ['ip', 'addr', 'show', 'eth0'];
                runExec(container, cmd, function (e, ip) {
                    if (e) {
                        cb(e);
                        return;
                    }
                    container['Ip'] = matchIp(ip);
                    cb(null);
                });
            }, function (inspectErr) {
                if (inspectErr) {
                    callback(inspectErr, null);
                }
                containers.forEach(function (container) {
                    container['Name'] = container.Names[0].replace('/', '');
                    consul.push(container);
                });
                consul.sort(byName);
                callback(null, consul);
                return;
            });
        });
}

function byName(a, b) {
    var x = a.Names[0]; var y = b.Names[0];
    return ((x < y) ? -1 : ((x > y) ? 1 : 0));
}

// @callback {fn} function(err, result)
function stop(container, fn) {
    console.log('stopping', container.Name);
    docker.getContainer(container.Id).stop(fn);
}

// @callback {fn} function(err, result)
function start(container, fn) {
    console.log('starting', container.Name);
    docker.getContainer(container.Id).start(fn);
}

// @callback {fn} function(err, leader)
function getLeader(container, fn) {
    runExec(container,
            ['curl', '127.0.0.1:8500/v1/status/leader'],
            function (err, leader) {
                if (err || leader === null) {
                    return fn(err, null);
                }
                return fn(null, matchIpPort(leader)[0]);
            });
}

// @callback {fn} function(err, peers)
// peers will be an array of strings in the form "{ip}:{port}"
function getPeers(container, fn) {
    runExec(container,
            ['curl', '-s', '127.0.0.1:8500/v1/status/peers'],
            function (err, peers) {
                if (err || peers === null) {
                    return fn(err, null);
                }
                return fn(null, matchIpPort(peers));
            });
}

// returns a string
function matchIp(input) {
    return input.match(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/);
}

// returns an array of strings in the form ["{ip}:{port}"]
function matchIpPort(input) {
    return input.match(/[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}:8300/g);
}

// Runs `docker exec` and concatenates stream into a single `results`
// string for the callback.
// @param    {container} container to run command on
// @param    {command} command and args ex. ['curl', '-v', 'example.com']
// @callback {callback(err, results)} results
function runExec(container, command, callback) {
    var options = {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: command
    };

    docker.getContainer(container.Id).exec(options, function (execErr, exec) {
        if (execErr) {
            callback(execErr, null);
        }
        exec.start({Tty: true, Detach: true}, function (err, stream) {
            if (err) {
                callback(err, null);
            }
            var body = '';
            stream.setEncoding('utf8');
            stream.once('error', function (error) {
                callback(error, null);
            });
            stream.once('end', function () {
                callback(null, body);
            });
            stream.on('data', function (chunk) {
                body += chunk;
            });

        });
    });
}
