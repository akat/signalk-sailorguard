'use strict'

// Pure helpers for the `navigation.anchor.akat` alarm configuration object that
// the 6Pack app writes. The wire format is shared with the ESP32 firmware:
//
//   {
//     anchor: { enabled, radius, lat, lon, ts },
//     depth:  { alarm, min_depth },   // metres
//     wind:   { alarm, max_speed }    // knots
//   }
//
// Every field is optional on input and several historical aliases are accepted
// (see docs/api.md). Output is always the canonical shape above.

const { isLat, isLon } = require('./geo')

const MIN_RADIUS = 1
const MAX_RADIUS = 10000

function defaultConfig() {
  return {
    anchor: { enabled: false, radius: 100, lat: null, lon: null, ts: null },
    depth: { alarm: false, min_depth: 2 },
    wind: { alarm: false, max_speed: 20 }
  }
}

function parseBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : undefined
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 'enabled', 'alarm'].includes(v)) return true
    if (['false', '0', 'no', 'off', 'disabled', 'inactive', 'clear'].includes(v)) return false
  }
  return undefined
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    return Number.isFinite(n) ? n : undefined
  }
  if (value && typeof value === 'object' && 'value' in value) return parseNumber(value.value)
  return undefined
}

// Epoch milliseconds from a number or an ISO string (the app writes both).
function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
    const t = Date.parse(value)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

function clone(config) {
  return {
    anchor: { ...config.anchor },
    depth: { ...config.depth },
    wind: { ...config.wind }
  }
}

function hasAnchorPosition(config) {
  return isLat(config.anchor.lat) && isLon(config.anchor.lon)
}

/**
 * Merge a (partial) config object into `current` and return
 * `{ config, changed, warnings }`. `current` is never mutated.
 */
function applyPatch(current, input, now = Date.now()) {
  const next = clone(current)
  const warnings = []
  let payload = input
  if (payload && typeof payload === 'object' && payload.value && typeof payload.value === 'object') {
    payload = payload.value
  }
  if (!payload || typeof payload !== 'object') {
    return { config: next, changed: false, warnings: ['value is not an object'] }
  }

  const anchorIn = (payload.anchor && typeof payload.anchor === 'object') ? payload.anchor : {}

  // Radius: anchor.radius wins, top-level radius/radiusMeters kept for older clients.
  const radius = parseNumber(anchorIn.radius ?? payload.radius ?? payload.radiusMeters)
  if (radius !== undefined) {
    if (radius >= MIN_RADIUS && radius <= MAX_RADIUS) next.anchor.radius = radius
    else warnings.push(`radius ${radius} out of range ${MIN_RADIUS}-${MAX_RADIUS} m, ignored`)
  }

  const lat = parseNumber(anchorIn.lat ?? anchorIn.latitude)
  const lon = parseNumber(anchorIn.lon ?? anchorIn.longitude)
  let positionChanged = false
  if (lat !== undefined) {
    if (isLat(lat)) {
      positionChanged = positionChanged || lat !== next.anchor.lat
      next.anchor.lat = lat
    } else warnings.push(`invalid anchor latitude ${lat}`)
  }
  if (lon !== undefined) {
    if (isLon(lon)) {
      positionChanged = positionChanged || lon !== next.anchor.lon
      next.anchor.lon = lon
    } else warnings.push(`invalid anchor longitude ${lon}`)
  }
  const ts = parseTimestamp(anchorIn.ts)
  if (ts !== undefined) next.anchor.ts = ts
  else if (positionChanged) next.anchor.ts = now

  const enabled = parseBool(anchorIn.enabled ?? payload.enabled)
  if (enabled !== undefined) next.anchor.enabled = enabled
  if (next.anchor.enabled && !hasAnchorPosition(next)) {
    next.anchor.enabled = false
    warnings.push('geofence cannot be enabled without an anchor position')
  }

  const depthIn = payload.depth ?? payload.depthConfig
  if (depthIn && typeof depthIn === 'object') {
    const min = parseNumber(depthIn.min_depth ?? depthIn.minDepth ?? depthIn.threshold)
    if (min !== undefined) {
      if (min > 0) next.depth.min_depth = min
      else warnings.push(`invalid min_depth ${min}`)
    }
    const alarm = parseBool(depthIn.alarm ?? depthIn.enabled)
    if (alarm !== undefined) next.depth.alarm = alarm
  }

  const windIn = payload.wind ?? payload.windConfig
  if (windIn && typeof windIn === 'object') {
    const max = parseNumber(windIn.max_speed ?? windIn.maxSpeed ?? windIn.threshold)
    if (max !== undefined) {
      if (max > 0) next.wind.max_speed = max
      else warnings.push(`invalid max_speed ${max}`)
    }
    const alarm = parseBool(windIn.alarm ?? windIn.enabled ?? windIn.active)
    if (alarm !== undefined) next.wind.alarm = alarm
  }

  return { config: next, changed: !equals(current, next), warnings }
}

/**
 * Apply a leaf write such as `navigation.anchor.akat.anchor.lat` (subPath
 * `anchor.lat`). Returns undefined when the leaf is not part of the alarm config.
 */
function applyLeaf(current, subPath, value, now = Date.now()) {
  const parts = subPath.split('.')
  if (parts.length === 1 && ['anchor', 'depth', 'wind', 'depthConfig', 'windConfig'].includes(parts[0])) {
    return applyPatch(current, { [parts[0]]: value }, now)
  }
  if (parts.length === 2 && ['anchor', 'depth', 'wind'].includes(parts[0])) {
    return applyPatch(current, { [parts[0]]: { [parts[1]]: value } }, now)
  }
  return undefined
}

function toCanonical(config) {
  const anchor = { enabled: config.anchor.enabled, radius: config.anchor.radius }
  if (hasAnchorPosition(config)) {
    anchor.lat = config.anchor.lat
    anchor.lon = config.anchor.lon
  }
  if (config.anchor.ts) anchor.ts = config.anchor.ts
  return {
    anchor,
    depth: { alarm: config.depth.alarm, min_depth: config.depth.min_depth },
    wind: { alarm: config.wind.alarm, max_speed: config.wind.max_speed }
  }
}

function equals(a, b) {
  return JSON.stringify(toCanonical(a)) === JSON.stringify(toCanonical(b))
}

function fromStored(stored) {
  if (!stored || typeof stored !== 'object') return defaultConfig()
  return applyPatch(defaultConfig(), stored).config
}

module.exports = {
  defaultConfig,
  applyPatch,
  applyLeaf,
  toCanonical,
  fromStored,
  hasAnchorPosition,
  parseBool,
  parseNumber,
  parseTimestamp
}
