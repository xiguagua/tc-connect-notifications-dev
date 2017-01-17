/*
 * Copyright (c) 2016 TopCoder, Inc. All rights reserved.
 */

/**
 * Initialize and start application
 * @author TCSCODER
 * @version 1.0
 */
const config = require('config');
const _ = require('lodash');
const co = require('co');
const jackrabbit = require('jackrabbit');
const amqp = require('amqplib');
const Buffer = require('buffer').Buffer;
const logger = require('./common/logger');
const constants = require('./common/constants');
const handlers = require('./src/handlers');

// Connect to the target RabbitMQ to send (produce) notifications
const targetExchange = jackrabbit(config.TARGET_RABBIT_URL)
  .topic(config.TARGET_RABBIT_EXCHANGE_NAME);
targetExchange.queue({
  name: config.TARGET_RABBIT_QUEUE_NAME,
  key: config.TARGET_RABBIT_ROUTING_KEY,
});
targetExchange.queue({
  name: config.TARGET_RABBIT_COPILOT_QUEUE_NAME,
  key: config.TARGET_RABBIT_COPILOT_ROUTING_KEY,
});
targetExchange.queue({
  name: config.TARGET_RABBIT_MANAGER_QUEUE_NAME,
  key: config.TARGET_RABBIT_MANAGER_ROUTING_KEY,
});

let delayedChannel = null;
// Connect to the delayed queue to send copilot notifications
co(function* generateDelayedExchange() {
  const conn = yield amqp.connect(config.TARGET_RABBIT_URL);
  const ch = yield conn.createChannel();
  yield ch.assertExchange(
    config.TARGET_RABBIT_DELAYED_EXCHANGE_NAME,
    config.TARGET_RABBIT_DELAYED_EXCHANGE_TYPE, {
      arguments: {
        'x-delayed-type': 'direct',
      },
    });
  yield ch.assertQueue(config.TARGET_RABBIT_COPILOT_QUEUE_NAME);
  yield ch.bindQueue(
    config.TARGET_RABBIT_COPILOT_QUEUE_NAME,
    config.TARGET_RABBIT_DELAYED_EXCHANGE_NAME,
    config.TARGET_RABBIT_COPILOT_ROUTING_KEY);
  delayedChannel = ch;
});


/**
 * Handle events from the source RabbitMQ
 * return a lambda closure func
 * @param {Object} data the message data
 * @param {Function} ack the ack callback
 * @param {Function} nack the nack callback
 * @param {Object} message the message
 */
function handleEvent() {
  let delayedInterval = 0;

  return (data, ack, nack, message) => {
    const eventType = message.fields.routingKey;
    const correlationId = message.properties.correlationId;

    logger.info(`Receiving event with correlationId = '${correlationId}', type = '${eventType}'`);
    logger.debug(`Message: ${JSON.stringify(message)}`);

    co(function* generateNotifications() {
      switch (eventType) {
        case constants.events.projectDraftCreated:
          return handlers.projectDraftCreatedEventToNotifications(data);
        case constants.events.projectUpdated:
          return handlers.projectUpdatedEventToNotifications(data);
        case constants.events.projectClaimReminder:
          return handlers.projectClaimReminderToNotifications(data);
        case constants.events.projectMemberAdded:
          return yield handlers.projectMemberAddedEventToNotifications(data);
        case constants.events.projectMemberRemoved:
          return yield handlers.projectMemberRemovedEventToNotifications(data);
        case constants.events.projectMemberUpdated:
          return yield handlers.projectMemberUpdatedEventToNotifications(data);
        default:
          return [];
      }
    }).then((notifications) => {
      _.each(notifications, (notification) => {
        // Notify managers or copilots
        if (notification.target) {
          if (notification.repost === false) {
            clearTimeout(delayedInterval);
            return;
          }
          const routingKey = (() => {
            const m = {
              [constants.memberRoles.manager]: config.TARGET_RABBIT_MANAGER_ROUTING_KEY,
              [constants.memberRoles.copilot]: config.TARGET_RABBIT_COPILOT_ROUTING_KEY,
            };
            return target => m[target];
          })();
          targetExchange.publish(notification.payload, {
            key: routingKey(notification.target),
          });
          // repost if no copilot is assigned
          if (notification.repost) {
            (function delayedPublish() {
              delayedChannel.publish(
                config.TARGET_RABBIT_DELAYED_EXCHANGE_NAME,
                config.TARGET_RABBIT_COPILOT_ROUTING_KEY,
                Buffer.from(JSON.stringify(notification.payload)), {
                  headers: {
                    'x-delay': config.TARGET_RABBIT_DELAYED_INTERVAL,
                  },
                });
              delayedInterval = setTimeout(delayedPublish, config.TARGET_RABBIT_DELAYED_INTERVAL);
            }());
          }
        } else {
          // Notify others
          targetExchange.publish(notification, {
            key: config.TARGET_RABBIT_ROUTING_KEY,
          });
        }
      });

      ack();

      logger.info(`Complete handling event with correlationId = '${correlationId}', type = ` +
        `'${eventType}': ${notifications.length} notifications sent.`);
    }).catch((err) => {
      nack();

      logger.info(`Could not handle event with correlationId = '${correlationId}', type = ` +
        `'${eventType}'`, {
          err,
        });
    });
  };
}

// Connect to the source RabbitMQ to receive (consume) events
jackrabbit(config.SOURCE_RABBIT_URL)
  .topic(config.SOURCE_RABBIT_EXCHANGE_NAME)
  .queue({
    name: config.SOURCE_RABBIT_QUEUE_NAME,
    keys: _.values(constants.events),
  })
  .consume(handleEvent());

logger.info('tc-connect-notifications started...');
