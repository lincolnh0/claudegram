/**
 * Completion notification settings per chat.
 * Persists user preferences for the "Done" push notification after long tasks.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { z } from 'zod';

const notificationSettingsSchema = z.object({
  enabled: z.boolean().optional(),
});

const notificationSettingsFileSchema = z.object({
  settings: z.record(z.string(), notificationSettingsSchema),
});

export interface NotificationSettings {
  enabled: boolean;
}

const SETTINGS_DIR = path.join(os.homedir(), '.claudegram');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'notification-settings.json');
const chatNotificationSettings: Map<string, NotificationSettings> = new Map();

function ensureDirectory(): void {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: 0o700 });
  }
}

function normalizeSettings(settings?: Partial<NotificationSettings>): NotificationSettings {
  return {
    enabled: typeof settings?.enabled === 'boolean' ? settings.enabled : true,
  };
}

function loadSettings(): void {
  ensureDirectory();
  if (!fs.existsSync(SETTINGS_FILE)) return;

  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);

    const result = notificationSettingsFileSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[Notification] Invalid settings file format, starting fresh:', result.error.message);
      return;
    }

    for (const [key, settings] of Object.entries(result.data.settings)) {
      chatNotificationSettings.set(key, normalizeSettings(settings));
    }
  } catch (error) {
    console.error('[Notification] Failed to load settings:', error);
  }
}

function saveSettings(): void {
  ensureDirectory();
  const settings: Record<string, NotificationSettings> = {};
  for (const [key, value] of chatNotificationSettings.entries()) {
    settings[key] = value;
  }

  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ settings }, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error('[Notification] Failed to save settings:', error);
  }
}

loadSettings();

export function getNotificationSettings(sessionKey: string): NotificationSettings {
  const existing = chatNotificationSettings.get(sessionKey);
  if (existing) return existing;

  const defaults = normalizeSettings();
  chatNotificationSettings.set(sessionKey, defaults);
  saveSettings();
  return defaults;
}

export function setNotificationEnabled(sessionKey: string, enabled: boolean): void {
  const settings = getNotificationSettings(sessionKey);
  settings.enabled = enabled;
  saveSettings();
}

export function isNotificationEnabled(sessionKey: string): boolean {
  return getNotificationSettings(sessionKey).enabled;
}
