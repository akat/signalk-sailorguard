'use strict'

// Alarm state machines. They are pure (time is passed in) so they can be unit
// tested without a server. Each monitor exposes `active`, `title`, `message()`
// and `data()`; the AlarmManager watches `active` for transitions.

const { haversine, bearing, MS_TO_KNOTS } = require('./geo')
const { hasAnchorPosition } = require('./anchor-config')

class GeofenceMonitor {
  constructor(options = {}) {
    this.type = 'geofence'
    this.title = 'Anchor alarm'
    this.triggerMargin = options.triggerMargin ?? 10
    this.confirmFixes = Math.max(1, options.confirmFixes ?? 2)
    this.maxSpeedKnots = options.maxSpeedKnots ?? 30
    this.maxRejects = Math.max(1, options.maxRejects ?? 3)
    this.reset()
  }

  reset() {
    this.active = false
    this.outsideCount = 0
    this.rejected = 0
    this.lastAccepted = undefined
    this.distance = undefined
    this.bearing = undefined
    this.radius = undefined
  }

  // Called when the anchor position or radius changes: keep the GPS filter
  // baseline but re-evaluate the breach from scratch.
  rearm() {
    this.active = false
    this.outsideCount = 0
    this.distance = undefined
    this.bearing = undefined
  }

  /** @returns {boolean} whether the fix was accepted */
  update(pos, t, config) {
    if (!config.anchor.enabled || !hasAnchorPosition(config)) {
      this.reset()
      return false
    }
    // Reject fixes implying an impossible speed (GPS glitches), but only a
    // few in a row: a sustained "jump" is real and becomes the new baseline.
    // This replaces the firmware's 100 m jump filter, which could reject every
    // later fix forever.
    if (this.lastAccepted) {
      const dt = (t - this.lastAccepted.t) / 1000
      if (dt >= 0.5 && dt <= 60) {
        const moved = haversine(this.lastAccepted.lat, this.lastAccepted.lon, pos.lat, pos.lon)
        const knots = (moved / dt) * MS_TO_KNOTS
        if (knots > this.maxSpeedKnots && this.rejected < this.maxRejects) {
          this.rejected++
          return false
        }
      }
    }
    this.rejected = 0
    this.lastAccepted = { lat: pos.lat, lon: pos.lon, t }

    const { lat, lon, radius } = config.anchor
    this.radius = radius
    this.distance = haversine(lat, lon, pos.lat, pos.lon)
    this.bearing = bearing(lat, lon, pos.lat, pos.lon)

    if (this.distance > radius + this.triggerMargin) this.outsideCount++
    else this.outsideCount = 0

    if (!this.active && this.outsideCount >= this.confirmFixes) this.active = true
    else if (this.active && this.distance <= radius) this.active = false
    return true
  }

  message() {
    return `Vessel left geofence: ${Math.round(this.distance ?? 0)} m from anchor (radius ${Math.round(this.radius ?? 0)} m).`
  }

  data() {
    return {
      distance: this.distance !== undefined ? Math.round(this.distance) : null,
      radius: this.radius ?? null,
      bearing: this.bearing !== undefined ? Math.round((this.bearing * 180) / Math.PI) : null
    }
  }
}

// Raised while the geofence is armed but no position has been received for
// `timeoutSeconds`: the most dangerous failure is a silent GPS.
class PositionLostMonitor {
  constructor(options = {}) {
    this.type = 'position'
    this.title = 'Anchor alarm: GPS lost'
    this.timeoutMs = Math.max(0, options.timeoutSeconds ?? 60) * 1000
    this.active = false
    this.lastFixAt = undefined
    this.armedAt = undefined
  }

  onFix(t) {
    this.lastFixAt = t
    this.active = false
  }

  tick(now, config) {
    const armed = this.timeoutMs > 0 && config.anchor.enabled && hasAnchorPosition(config)
    if (!armed) {
      this.armedAt = undefined
      this.active = false
      return
    }
    if (this.armedAt === undefined) this.armedAt = now
    const since = Math.max(this.lastFixAt ?? 0, this.armedAt)
    this.active = now - since > this.timeoutMs
  }

  secondsWithoutFix(now = Date.now()) {
    return this.lastFixAt ? Math.round((now - this.lastFixAt) / 1000) : undefined
  }

  message() {
    const secs = this.secondsWithoutFix()
    return secs !== undefined
      ? `No GPS position for ${secs} s. The anchor alarm cannot watch the boat.`
      : 'No GPS position received. The anchor alarm cannot watch the boat.'
  }

  data() {
    return { secondsWithoutFix: this.secondsWithoutFix() ?? null }
  }
}

class DepthMonitor {
  constructor(options = {}) {
    this.type = 'depth'
    this.title = 'Depth alarm'
    this.hysteresis = Math.max(0, options.hysteresis ?? 0.3)
    this.confirmSamples = Math.max(1, options.confirmSamples ?? 2)
    this.ignoreZero = options.ignoreZero ?? true
    this.reset()
  }

  reset() {
    this.active = false
    this.belowCount = 0
    this.depth = undefined
    this.threshold = undefined
  }

  update(depth, t, config) {
    if (!config.depth.alarm) {
      this.reset()
      return false
    }
    if (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0) return false
    // An empty NMEA depth field is often decoded as 0 m; ignore it by default.
    if (depth === 0 && this.ignoreZero) return false

    const min = config.depth.min_depth
    this.depth = depth
    this.threshold = min
    if (depth <= min) this.belowCount++
    else this.belowCount = 0

    if (!this.active && this.belowCount >= this.confirmSamples) this.active = true
    else if (this.active && depth > min + this.hysteresis) this.active = false
    return true
  }

  message() {
    return `Depth ${(this.depth ?? 0).toFixed(1)} m (limit ${(this.threshold ?? 0).toFixed(1)} m).`
  }

  data() {
    return { depth: round(this.depth, 1), threshold: this.threshold ?? null }
  }
}

class WindMonitor {
  constructor(options = {}) {
    this.type = 'wind'
    this.title = 'Wind alarm'
    this.hysteresis = Math.max(0, options.hysteresis ?? 1)
    this.averageMs = Math.max(0, options.averageSeconds ?? 0) * 1000
    this.source = options.source === 'true' ? 'true' : 'apparent'
    this.label = this.source === 'true' ? 'True' : 'Apparent'
    this.reset()
  }

  reset() {
    this.active = false
    this.samples = []
    this.speed = undefined
    this.threshold = undefined
  }

  /** @param speedMs wind speed in m/s (Signal K units) */
  update(speedMs, t, config) {
    if (!config.wind.alarm) {
      this.reset()
      return false
    }
    if (typeof speedMs !== 'number' || !Number.isFinite(speedMs) || speedMs < 0 || speedMs > 100) {
      return false
    }
    let knots = speedMs * MS_TO_KNOTS
    if (this.averageMs > 0) {
      this.samples.push({ t, knots })
      while (this.samples.length && this.samples[0].t < t - this.averageMs) this.samples.shift()
      knots = this.samples.reduce((s, x) => s + x.knots, 0) / this.samples.length
    }
    const max = config.wind.max_speed
    this.speed = knots
    this.threshold = max
    if (!this.active && knots >= max) this.active = true
    else if (this.active && knots <= Math.max(max - this.hysteresis, 0)) this.active = false
    return true
  }

  message() {
    return `${this.label} wind ${(this.speed ?? 0).toFixed(1)} kn (limit ${(this.threshold ?? 0).toFixed(1)} kn).`
  }

  data() {
    return { wind: round(this.speed, 1), threshold: this.threshold ?? null, source: this.source }
  }
}

function round(v, digits) {
  if (typeof v !== 'number') return null
  const f = 10 ** digits
  return Math.round(v * f) / f
}

module.exports = { GeofenceMonitor, PositionLostMonitor, DepthMonitor, WindMonitor }
