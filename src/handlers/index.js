/*
 * Copyright (c) 2016 TopCoder, Inc. All rights reserved.
 */

/**
 * Define all event handlers
 * @author TCSCODER
 * @version 1.0
 */

'usr strict';

const config = require('config');
const _ = require('lodash');
const request = require('request');
const Promise = require('bluebird');
const constants = require('../../common/constants');

/**
 * Create notification for a project event
 * @param {Array} userIds the array of user ids
 * @param {Object} project the project
 * @param {Object} notificationTypeSubject the notification type and subject
 * @returns the notification
 * @private
 */
function createProjectNotification(userIds, project, notificationTypeSubject) {
  const params = {
    projectId: project.id,
    projectName: project.name,
    projectDescription: project.description,
  };
  const notification = {
    recipients: _.map(userIds, (id) => {
      const recipient = {
        id,
        params,
      };
      return recipient;
    }),
  };
  _.extend(notification, notificationTypeSubject);

  return notification;
}

/**
 * Get project member ids by role
 * @param {Object} project the project
 * @param {String} role the role
 * @returns {Array} the array of project member ids
 * @private
 */
function getProjectMemberIdsByRole(project, role) {
  const members = _.filter(project.members, {
    role,
  });
  return _.map(members, member => member.userId);
}

/**
 * Makes a GET request to the API server
 * @param {String} url the relative url
 * @returns {Promise} the promise that resolves to the response body content
 * @private
 */
function requestPromise(url) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${config.API_BASE_URL}/${url}`;

    request.get(fullUrl, (err, res, body) => {
      if (err || res.statusCode > 299) {
        reject(err || new Error(`Failed to load url '${fullUrl}': statusCode = ${res.statusCode}`));
      } else {
        resolve(body.result.content);
      }
    });
  });
}

/**
 * Get project from API server
 * @param {Number} id the project id
 * @returns {Promise} the promise that resolves to the project
 * @private
 */
function* getProjectById(id) {
  return yield requestPromise(`projects/${id}`);
}

/**
 * Get user from API server
 * @param {Number} id the user id
 * @returns {Promise} the promise that resolves to the user
 * @private
 */
function* getUserById(id) {
  return yield requestPromise(`users/${id}`);
}

/**
 * Create notification for a project member event
 * @param {Array} userIds the array of user ids
 * @param {Object} project the project
 * @param {Object} member the member which is added or updated
 * @param {Object} notificationTypeSubject the notification type and subject
 * @returns the notification
 * @private
 */
function createProjectMemberNotification(userIds, project, member, notificationTypeSubject) {
  const params = {
    projectId: project.id,
    projectName: project.name,
    memberId: parseInt(member.id, 10),
    memberName: `${member.firstName} ${member.lastName}`,
    memberHandle: member.handle,
  };
  const notification = {
    recipients: _.map(userIds, (id) => {
      const recipient = {
        id,
        params,
      };
      return recipient;
    }),
  };
  _.extend(notification, notificationTypeSubject);

  return notification;
}

/**
 * Create notifications from project.draft-created event
 * @param {Object} data the event data
 * @return {Array} the array of notifications
 */
function projectDraftCreatedEventToNotifications(data) {
  const owner = _.find(data.members, {
    role: constants.memberRoles.customer,
    isPrimary: true,
  });

  if (!owner) {
    return [];
  }

  return [createProjectNotification([owner.userId], data, constants.notifications.project.created)];
}

/**
 * Create message from updated project
 * @param {Object} project the updated project
 * @return {Object} the message for slack channel
 */
function createSlackMessage(project) {
  const shortDescriptionUpper = 200;
  const short = project.description.length <= shortDescriptionUpper;
  const descriptions = [];
  descriptions.push({
    title: 'Description',
    value: project.description,
    short,
  });
  if (!short) {
    descriptions.push({
      title: 'Description',
      value: project.description.slice(0, shortDescriptionUpper),
      short: !short,
    });
  }

  return {
    username: config.PAYLOAD_USERNAME,
    icon_url: config.PAYLOAD_ICON_URL,
    attachments: [{
      fallback: `New Project: https://connect.topcoder.com/projects/${project.id}`,
      pretext: `New Project: https://connect.topcoder.com/projects/${project.id}`,
      fields: [{
        title: 'Ref Code',
        value: project.id,
        short: false,
      },
        ...descriptions,
      ],
    }],
  };
}


/**
 * Create notifications from project.updated event
 * @param {String} data the event data
 * @returns {Array} the array of notifications
 */
function projectUpdatedEventToNotifications(data) {
  if (data.updated.status === data.original.status) {
    return [];
  }

  const notifications = [];
  const project = data.updated;

  if (project.status === constants.projectStatuses.inReview) {
    // Notify to Team Members
    const teamMemberUserIds = getProjectMemberIdsByRole(project, constants.memberRoles.customer);
    const teamMemberNotification = createProjectNotification(
      teamMemberUserIds,
      project,
      constants.notifications.project.submittedForReview);
    notifications.push(teamMemberNotification);

    // Notify all managers and all copilots
    const allManagerAndCopilotUserIds =
      _.union(config.ALL_MANAGER_USER_IDS, config.ALL_COPILOT_USER_IDS);
    const allManagersAndCopilotsNotification = createProjectNotification(
      allManagerAndCopilotUserIds,
      project,
      constants.notifications.project.availableForReview);
    notifications.push(allManagersAndCopilotsNotification);

    // New message for managers
    const managerMessage = createSlackMessage(project);
    notifications.push({
      target: constants.memberRoles.manager,
      payload: managerMessage,
    });
  } else if (project.status === constants.projectStatuses.reviewed) {
    // Notify to all project members
    const projectMemberNotification = createProjectNotification(
      _.map(project.members, member => member.userId),
      project,
      constants.notifications.project.reviewed);
    notifications.push(projectMemberNotification);

    // Notify to all copilots if there's no copilot is assigned
    const projectCopilotIds = getProjectMemberIdsByRole(project, constants.memberRoles.copilot);
    const noCopilotAssigned = projectCopilotIds.length === 0;
    if (noCopilotAssigned) {
      const notification = createProjectNotification(
        config.ALL_COPILOT_USER_IDS,
        project,
        constants.notifications.project.availableToClaim);
      notifications.push(notification);
    }

    // New message for copilots
    const copilotMessage = createSlackMessage(project);
    notifications.push({
      target: constants.memberRoles.copilot,
      repost: noCopilotAssigned,
      payload: copilotMessage,
    });
  }

  return notifications;
}

/**
 * Create notifications from project.claim.reminder event
 * @param {Object} data the event data
 * @returns {Array} the array of notifcations
 */
function projectClaimReminderToNotifications(data) {
  const notifications = [];
  const project = data.updated;

  if (project.status === constants.projectStatuses.reviewed) {
    // Check if any copilot is assigned
    const projectCopilotIds = getProjectMemberIdsByRole(project, constants.memberRoles.copilot);
    const copilotAssigned = projectCopilotIds.length !== 0;

    // Notification to cancel repost
    notifications.push({
      target: constants.memberRoles.copilot,
      repost: !copilotAssigned,
    });
  }

  return notifications;
}

/**
 * Create notifications from project.member.added events
 * @param {Object} data the event data
 * @returns {Array} the array of notifications
 */
function* projectMemberAddedEventToNotifications(data) {
  const [project, addedMember] = yield [
    getProjectById(data.projectId),
    getUserById(data.userId),
  ];

  let notificationTypeSubject;
  if (data.role === constants.memberRoles.customer) {
    notificationTypeSubject = constants.notifications.teamMember.added;
  } else if (data.role === constants.memberRoles.manager) {
    notificationTypeSubject = constants.notifications.teamMember.managerJoined;
  } else if (data.role === constants.memberRoles.copilot) {
    notificationTypeSubject = constants.notifications.teamMember.copilotJoined;
  }

  const userIds = _.map(project.members, member => member.userId);

  return [createProjectMemberNotification(userIds, project, addedMember, notificationTypeSubject)];
}

/**
 * Create notifications from project.member.removed events
 * @param {Object} data the event data
 * @returns {Array} the array of notifications
 */
function* projectMemberRemovedEventToNotifications(data) {
  const [project, removedMember] = yield [
    getProjectById(data.projectId),
    getUserById(data.userId),
  ];

  let notificationTypeSubject;
  if (data.updatedBy === data.userId) {
    // Left
    notificationTypeSubject = constants.notifications.teamMember.left;
  } else {
    // Removed
    notificationTypeSubject = constants.notifications.teamMember.removed;
  }

  const userIds = _.map(project.members, member => member.userId);

  return [
    createProjectMemberNotification(userIds, project, removedMember, notificationTypeSubject),
  ];
}

/**
 * Create notifications from project.member.updated events
 * @param {Object} data the event data
 * @returns {Array} the array of notifications
 */
function* projectMemberUpdatedEventToNotifications(data) {
  if (data.updated.role !== constants.memberRoles.customer || !data.updated.isPrimary) {
    return [];
  }

  const [project, updatedMember] = yield [
    getProjectById(data.updated.projectId),
    getUserById(data.updated.userId),
  ];

  const userIds = _.map(project.members, member => member.userId);
  const notificationTypeSubject = constants.notifications.teamMember.ownerChanged;
  const params = {
    projectId: project.id,
    projectName: project.name,
    newOwnerUserId: updatedMember.id,
    newOwnerName: `${updatedMember.firstName} ${updatedMember.lastName}`,
    newOwnerHandle: updatedMember.handle,
  };

  const notification = {
    recipients: _.map(userIds, (id) => {
      const recipient = {
        id,
        params,
      };
      return recipient;
    }),
  };
  _.extend(notification, notificationTypeSubject);

  return [notification];
}


module.exports = {
  projectDraftCreatedEventToNotifications,
  projectUpdatedEventToNotifications,
  projectMemberAddedEventToNotifications,
  projectMemberRemovedEventToNotifications,
  projectMemberUpdatedEventToNotifications,
  projectClaimReminderToNotifications,
};
