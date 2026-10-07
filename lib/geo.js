'use strict'

const EARTH_RADIUS_M = 6371000
const MS_TO_KNOTS = 1.9438444924406

const toRad = (d) => (d * Math.PI) / 180
const toDeg = (r) => (r * 180) / Math.PI

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Initial bearing from point 1 to point 2, in radians [0, 2π).
function bearing(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1)
  const φ2 = toRad(lat2)
  const Δλ = toRad(lon2 - lon1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (Math.atan2(y, x) + 2 * Math.PI) % (2 * Math.PI)
}

function isLat(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90
}

function isLon(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180
}

// Accepts Signal K {latitude, longitude} or the app's {lat, lon}.
function parsePosition(value) {
  if (!value || typeof value !== 'object') return undefined
  const lat = value.latitude ?? value.lat
  const lon = value.longitude ?? value.lon
  if (!isLat(lat) || !isLon(lon)) return undefined
  return { lat, lon }
}

module.exports = { haversine, bearing, parsePosition, isLat, isLon, toDeg, MS_TO_KNOTS }
