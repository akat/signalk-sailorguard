'use strict'

// Turns monitor state changes into Signal K notifications and push messages.
//
// Push policy, per alarm type (one type never blocks another):
//   - on raise: push now, or as soon as the type's cooldown has passed
//     (queued, never dropped)
//   - while active: repeat every `repeatSeconds` (0 = once)
//   - on clear: optional "all clear" push
//   - when the user disables an alarm, it clears silently

const NOTIFICATION_PATHS = {
  geofence: 'notifications.geofence.exit',
  position: 'notifications.geofence.positionLost',
  depth: 'notifications.depth.alarm',
  wind: 'notifications.wind.alarm'
}

class AlarmManager {
  /**
   * @param {object} opts
   * @param {Record<string, object>} opts.monitors  type -> monitor
   * @param {Record<string, {cooldownSeconds, repeatSeconds, pushOnClear}>} opts.policy
   * @param {(path: string, value: object) => void} opts.emitNotification
   * @param {(type: string, alarm: {type, state, data}) => Promise<void>} opts.push
   *        alarm as sent to the push gateway, which renders the text
   */
  constructor({ monitors, policy, emitNotification, push, log = () => {}, now = Date.now }) {
    this.monitors = monitors
    this.policy = policy
    this.emitNotification = emitNotification
    this.push = push
    this.log = log
    this.now = now
    this.state = {}
    for (const type of Object.keys(monitors)) {
      this.state[type] = { active: false, since: undefined, lastPushAt: -Infinity, timer: undefined, pushes: 0 }
    }
  }

  /** Compare a monitor's `active` flag with the last known state and act on a change. */
  evaluate(type, { silent = false } = {}) {
    const monitor = this.monitors[type]
    const st = this.state[type]
    if (!monitor || !st || monitor.active === st.active) return

    st.active = monitor.active
    if (st.active) {
      st.since = this.now()
      st.pushes = 0
      this.log(`${type} alarm raised: ${monitor.message()}`)
      this.notify(type, 'alarm', monitor.message())
      this.requestPush(type)
    } else {
      this.log(`${type} alarm cleared${silent ? ' (disabled)' : ''}`)
      this.cancelTimer(st)
      st.since = undefined
      this.notify(type, 'normal', silent ? 'Alarm disabled' : `${monitor.title}: back to normal`)
      if (!silent && this.policy[type]?.pushOnClear) {
        this.sendPush(type, { cleared: true })
      }
    }
  }

  evaluateAll(opts) {
    for (const type of Object.keys(this.monitors)) this.evaluate(type, opts)
  }

  notify(type, state, message) {
    this.emitNotification(NOTIFICATION_PATHS[type], {
      state,
      method: state === 'normal' ? [] : ['visual', 'sound'],
      message
    })
  }

  requestPush(type) {
    const st = this.state[type]
    if (st.timer) return // already queued
    const cooldownMs = (this.policy[type]?.cooldownSeconds ?? 10) * 1000
    const wait = st.lastPushAt + cooldownMs - this.now()
    if (wait <= 0) {
      this.firePush(type)
    } else {
      st.timer = setTimeout(() => {
        st.timer = undefined
        if (st.active) this.firePush(type)
      }, wait)
    }
  }

  firePush(type) {
    const st = this.state[type]
    st.lastPushAt = this.now()
    st.pushes++
    this.sendPush(type, {})
    const repeatMs = (this.policy[type]?.repeatSeconds ?? 0) * 1000
    if (repeatMs > 0) {
      st.timer = setTimeout(() => {
        st.timer = undefined
        if (st.active) this.requestPush(type)
      }, repeatMs)
    }
  }

  sendPush(type, { cleared = false }) {
    const alarm = { type, state: cleared ? 'normal' : 'alarm', data: compact(this.monitors[type].data()) }
    Promise.resolve(this.push(type, alarm)).catch((err) => this.log(`push for ${type} failed: ${err.message}`))
  }

  cancelTimer(st) {
    if (st.timer) clearTimeout(st.timer)
    st.timer = undefined
  }

  status() {
    const out = {}
    for (const [type, st] of Object.entries(this.state)) {
      const monitor = this.monitors[type]
      out[type] = {
        active: st.active,
        since: st.since ? new Date(st.since).toISOString() : null,
        pushes: st.pushes,
        notificationPath: NOTIFICATION_PATHS[type],
        ...monitor.data()
      }
    }
    return out
  }

  stop() {
    for (const st of Object.values(this.state)) this.cancelTimer(st)
  }
}

// Drop null/undefined fields; the gateway validates the rest.
function compact(data) {
  return Object.fromEntries(Object.entries(data || {}).filter(([, v]) => v !== null && v !== undefined))
}

module.exports = { AlarmManager, NOTIFICATION_PATHS }
