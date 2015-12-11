'use strict';

var EventEmitter = require('events').EventEmitter;
var Promise = require('bluebird');
var _ = require('lodash');
var amqplib = require('amqplib');
var memoizee = require('memoizee');
var CronJob = require('cron').CronJob;

module.exports = build;

function build (options) {
	var emitter = new EventEmitter();

	var config = {
		url: options && options.url || options,
		emitter: emitter
	};

	var getPublisher = memoizee(_.partial(createPublisher, config));
	var getSubscriber = memoizee(_.partial(createSubscriber, config));

	var api = _.extend(emitter, {
		publish: publish,
		subscribe: subscribe,
		schedule: schedule
	});

	return api;

	function publish (queueName, message, context) {
		var content = { context: api === this ? context : context || this, message: message };
		return getPublisher(queueName).then(function (publisher) {
			return publisher(content);
		});
	}

	function subscribe (queueName, handler) {
		return getSubscriber(queueName).then(function (subscriber) {
			return subscriber(handler);
		});
	}

	function schedule (cronTime, name, handler, params, timeZone) {
		if (_.isObject(cronTime)) {
			timeZone = cronTime.timeZone;
			params = cronTime.params;
			handler = cronTime.handler;
			name = cronTime.name;
			cronTime = cronTime.cronTime;
		}
		new CronJob(cronTime, trigger, null, true, timeZone);
		return subscribe(name, handler);
		function trigger () {
			publish(name, params);
		}
	}
}

function createPublisher (config, queueName) {
	return getChannel(config.url).then(assertQueue(queueName)).then(function (channel) {
		return function publish (content) {
			return channel.sendToQueue(queueName, new Buffer(JSON.stringify(content)));
		};
	});
}

function createSubscriber (config, queueName) {
	return getChannel(config.url).then(assertQueue(queueName)).then(function (channel) {
		return function subscribe (handler) {
			return channel.consume(queueName, onMessage);
			function onMessage (message) {
				var content = JSON.parse(message.content.toString());
				return Promise.resolve().tap(function () {
					config.emitter.emit('task', {
						task: queueName,
						data: content.message,
						context: content.context
					});
				}).then(function () {
					return handler.call(content.context, content.message);
				}).tap(function (result) {
					config.emitter.emit('result', {
						task: queueName,
						data: content.message,
						context: content.context,
						result: result
					});
				}).catch(function (error) {
					config.emitter.emit('error', {
						task: queueName,
						data: content.message,
						context: content.context,
						error: error
					});
				}).finally(function () {
					return channel.ack(message);
				});
			}
		};
	});
}

var getChannel = memoizee(createChannel);

function createChannel (url) {
	return amqplib.connect(url).then(function (connection) {
		return connection.createChannel();
	});
}

function assertQueue (queueName) {
	return function (channel) {
		return channel.assertQueue(queueName, { durable: true }).then(function () {
			return channel;
		});
	};
}
