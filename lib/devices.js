'use strict'

// The phones that want this boat's alarms, persisted in the plugin data dir.
// Each device is known only by an opaque gateway handle (sgh_...). Raw push
// tokens never reach the boat server.

const { readJson, writeJson } = require('./json-file')

const HANDLE_RE = /^sgh_[A-Za-z0-9_-]{22}$/
const ALARM_TYPES = ['geofence', 'position', 'depth', 'wind', 'test']

const isValidHandle = (h) => typeof h === 'string' && HANDLE_RE.test(h)
const mask = (h) => (typeof h === 'string' && h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h)

function cleanString(v, max = 100) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

class DeviceStore {
  constructor(file, { maxDevices = 50 } = {}) {
    this.file = file
    this.maxDevices = maxDevices
    const stored = readJson(file, { devices: [] })
    this.entries = Array.isArray(stored.devices) ? stored.devices.filter((e) => isValidHandle(e?.handle)) : []
  }

  save() {
    writeJson(this.file, { version: 2, devices: this.entries })
  }

  list() {
    return this.entries.slice()
  }

  /**
   * Insert or refresh a device. The app's installationId identifies the phone,
   * so a new handle (after a push token rotation) replaces the old one.
   * @returns {{added, replacedHandle?: string}}
   */
  register(info, now = Date.now()) {
    const handle = info.handle
    const installationId = cleanString(info.installationId, 200)
    const existing = this.entries.find((e) => e.handle === handle || (installationId && e.installationId === installationId))
    const alarms = Array.isArray(info.alarms) ? info.alarms.filter((a) => ALARM_TYPES.includes(a)) : existing?.alarms
    const entry = {
      handle,
      installationId,
      platform: cleanString(info.platform, 20),
      appVersion: cleanString(info.appVersion, 40),
      deviceName: cleanString(info.deviceName, 100),
      alarms,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      lastSeen: new Date(now).toISOString()
    }
    this.entries = this.entries.filter((e) => e.handle !== handle && !(installationId && e.installationId === installationId))
    this.entries.push(entry)
    let evicted
    if (this.entries.length > this.maxDevices) {
      this.entries.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
      evicted = this.entries.splice(this.maxDevices).map((e) => e.handle)
    }
    this.save()
    return {
      added: !existing,
      replacedHandle: existing && existing.handle !== handle ? existing.handle : undefined,
      evicted
    }
  }

  /** @returns {string[]} the removed handles */
  unregister({ handle, installationId }) {
    const removed = this.entries.filter((e) => (handle && e.handle === handle) || (installationId && e.installationId === installationId))
    if (removed.length) {
      this.entries = this.entries.filter((e) => !removed.includes(e))
      this.save()
    }
    return removed.map((e) => e.handle)
  }

  remove(handles) {
    const dead = new Set(handles)
    const before = this.entries.length
    this.entries = this.entries.filter((e) => !dead.has(e.handle))
    const n = before - this.entries.length
    if (n) this.save()
    return n
  }

  clear() {
    const handles = this.entries.map((e) => e.handle)
    this.entries = []
    this.save()
    return handles
  }

  /** Forget devices whose app has not re-registered for `days` (it does on every connect). */
  prune(days, now = Date.now()) {
    if (!days || days <= 0) return []
    const cutoff = now - days * 86400000
    const old = this.entries.filter((e) => Date.parse(e.lastSeen) < cutoff).map((e) => e.handle)
    this.remove(old)
    return old
  }

  recipients(alarmType) {
    return this.entries
      .filter((e) => !Array.isArray(e.alarms) || alarmType === 'test' || e.alarms.includes(alarmType))
      .map((e) => e.handle)
  }
}

module.exports = { DeviceStore, isValidHandle, mask, ALARM_TYPES }
