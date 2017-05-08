var elasticsearch = require('elasticsearch');
var Stomp = require('stomp-client');
var logger = require('../utils/logger');
var kafka = require('no-kafka');

var client = new elasticsearch.Client({
    host: (process.env.FORKLIFT_GUI_ES_HOST || 'localhost') + ":" + (process.env.FORKLIFT_GUI_ES_PORT || 9200)
});

var kafkaClient = new kafka.Producer({
    connectionString: '127.0.0.1:29092'
});
kafkaClient.init();

var stompClient;
var service = {};

stompConnect();

function stompConnect() {
    logger.info("Connecting stomp client...");
    stompClient = new Stomp(process.env.FORKLIFT_GUI_STOMP_HOST || 'localhost', process.env.FORKLIFT_GUI_STOMP_PORT || 61613, null, null, null, null, {retries: 5, delay: 10000});
    stompClient.connect(function() {
        logger.info("Stomp client connected!");
    });
    stompClient.on('error', function(err) {
        logger.error('STOMP: ' + err.message);
    })
}
service.ping = function(done) {
    client.ping({
        // ping usually has a 3000ms timeout
        requestTimeout: 3000,
        // undocumented params are appended to the query string
        hello: "elasticsearch!"
    }, function (error) {
        if (error) {
            done(false);
        } else {
            done(true);
        }
    });
};

service.get = function(id, done) {
    var index = 'forklift-replay*';
    client.search({
        index: index,
        size: 1,
        body: {
            query: {
                query_string: {
                    query: id,
                    fields: ["_id"]
                }
            }
        }
    }).then(function (resp) {
        done(resp.hits.hits[0]);
    }, function(err) {
        done(null);
    });
};
service.poll = function(service, role, size, done) {
    var index = 'forklift-'+service+'*';

    logger.info("Polling: " + index + " for role " + role);

    var query;
    if (role == null) {
        query = {
            query_string: {
                query: "Error",
                fields: ["step"]
            }
        };
    } else {
        query = {
            bool: {
                must: {match: {"step": "Error"}},
                should: [
                    {match: {"queue": role}},
                    {match: {"role": role}}
                ]
            }
        };
    }
    client.search({
        index: index,
        size: size,
        body: {
            query: query,
            "sort": [{
                "time": {"order": "desc"}
            }]
        }
    }).then(function (resp) {
        done(resp.hits.hits);
    }, function(err) {
        logger.error(err.message);
        done(null, err.message);
    });
};

service.update = function(index, updateId, step, done) {
    client.update({
        index: index,
        id: updateId,
        type: 'log',
        body:  {
            doc: {
                step: step
            }
        }
    }, function (err) {
        if (err) {
            logger.error(err);
        }
        done();
    });
};


service.sendToActiveMq = function(msg, done) {
    if (msg.jmsHeaders['correlation-id']) {
        logger.info('Sending AMQ message: ' + msg.jmsHeaders['correlation-id']);
    } else {
        logger.info('Sending AMQ message');
    }
    // messages to the stomp connector should persist through restarts
    msg.jmsHeaders['persistent'] = 'true';
    // special tag to allow non binary msgs
    msg.jmsHeaders['suppress-content-length'] = 'true';
    stompClient.publish(msg.queue, msg.body, msg.jmsHeaders);
    done();
}

service.sendToKafka = function(msg, done) {
    logger.info('Sending Kafka message to ' + msg.topic);
    kafkaClient.send(msg).then(function(res) {
        if (res.err) {
            logger.error("Error sending message to kafka: " + JSON.stringify(res.err));
        } else {
            logger.info("Kafka message successfully sent: " + JSON.stringify(res));
        }
    }, function(err) {
        logger.error("Error sending message to kafka: " + JSON.stringify(err));
    });
    done();
}

service.stats = function(done) {
    getStats('forklift-retry*', function(retryStats) {
        logger.info("retry stats done " + JSON.stringify(retryStats));
        getStats('forklift-replay*', function(replayStats) {
            logger.info("replay stats done " + JSON.stringify(replayStats));
            return done({
                replay: replayStats,
                retry: retryStats
            })
        })
    })
};

var getStats = function(index, done) {
    client.search({
        index: index,
        size: 10000,
        body: {
            query: {
                query_string: {
                    query: "Error",
                    fields: ["step"]
                }
            },
            "sort": [{
                "time": {"order": "desc"}
            }]
        }
    }).then(function (resp) {
        var size = resp.hits.hits.length;
        var roleTotals = {};
        resp.hits.hits.forEach(function(hit, i) {
            hit = hit._source;

            var role = hit['role'] || hit['queue'];
            roleTotals[role] = (roleTotals[role] || 0) + 1;

            logger.info("DInfo: " + role + " " + roleTotals[role]);
        });
        logger.info("Finished stats");
        return done({
            totalLogs: size,
            roleTotals: roleTotals
        });

    }, function(err) {
        logger.error(err.message);
        done(null);
    });
};
module.exports = service;
