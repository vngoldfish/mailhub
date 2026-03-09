import fs from 'fs';
import path from 'path';

const FILE_PATH = path.resolve("./notifications.json");

let notifications = [];

try {
    if (fs.existsSync(FILE_PATH)) {
        notifications = JSON.parse(fs.readFileSync(FILE_PATH, 'utf8'));
    }
} catch (e) {
    notifications = [];
}

export function addNotification(notif) {
    const newNotif = {
        ...notif,
        date: new Date().toISOString()
    };
    notifications.unshift(newNotif);
    if (notifications.length > 20) notifications.pop();
    saveNotifications();
    return newNotif;
}

export function getNotifications() {
    return notifications;
}

function saveNotifications() {
    try {
        fs.writeFileSync(FILE_PATH, JSON.stringify(notifications, null, 2));
    } catch (e) {
        console.error("Failed to save notifications", e);
    }
}
