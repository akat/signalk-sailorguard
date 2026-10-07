'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { GeofenceMonitor, PositionLostMonitor, DepthMonitor, WindMonitor } = require('../lib/monitors')
const ac = require('../lib/anchor-config')

const ANCHOR = { lat: 37.9, lon: 23.7 }
const M_PER_DEG_LAT = 111195

const cfg = (patch) => ac.applyPatch(ac.defaultConfig(), patch).config
const geofenceCfg = (radius = 50) => cfg({ anchor: { ...ANCHOR, radius, enabled: true } })
// Point `meters` north of the anchor.
const north = (meters) => ({ lat: ANCHOR.lat + meters / M_PER_DEG_LAT, lon: ANCHOR.lon })

test('geofence: confirms the breach over consecutive fixes and clears inside the radius', () => {
  const m = new GeofenceMonitor({ confirmFixes: 2, triggerMargin: 10 })
  const c = geofenceCfg(50)
  let t = 0
  m.update(north(20), (t += 10000), c)
  assert.equal(m.active, false)
  m.update(north(55), (t += 10000), c) // beyond radius, within margin
  m.update(north(58), (t += 10000), c)
  assert.equal(m.active, false)
  m.update(north(63), (t += 10000), c)
  assert.equal(m.active, false, 'one fix outside is not enough')
  m.update(north(65), (t += 10000), c)
  assert.equal(m.active, true)
  assert.ok(Math.abs(m.distance - 65) < 0.5)
  m.update(north(52), (t += 10000), c)
  assert.equal(m.active, true, 'stays active in the hysteresis band')
  m.update(north(45), (t += 10000), c)
  assert.equal(m.active, false)
})

test('geofence: a single GPS glitch is ignored', () => {
  const m = new GeofenceMonitor({ confirmFixes: 1 })
  const c = geofenceCfg(50)
  assert.equal(m.update(north(10), 1000, c), true)
  assert.equal(m.update(north(5000), 2000, c), false) // ~9700 kn
  assert.equal(m.active, false)
  assert.equal(m.update(north(12), 3000, c), true)
})

test('geofence: a sustained jump is accepted (no permanent lock-out like the firmware)', () => {
  const m = new GeofenceMonitor({ confirmFixes: 1, maxRejects: 3 })
  const c = geofenceCfg(50)
  m.update(north(10), 1000, c)
  const accepted = [2000, 3000, 4000, 5000].map((t) => m.update(north(500), t, c))
  assert.deepEqual(accepted, [false, false, false, true])
  assert.equal(m.active, true)
})

test('geofence: disabled config resets the state', () => {
  const m = new GeofenceMonitor({ confirmFixes: 1 })
  m.update(north(100), 1000, geofenceCfg(50))
  assert.equal(m.active, true)
  m.update(north(100), 2000, ac.applyPatch(geofenceCfg(50), { anchor: { enabled: false } }).config)
  assert.equal(m.active, false)
})

test('position lost: raises after the timeout only while armed', () => {
  const m = new PositionLostMonitor({ timeoutSeconds: 60 })
  const off = ac.defaultConfig()
  m.tick(0, off)
  m.tick(120000, off)
  assert.equal(m.active, false)
  const on = geofenceCfg()
  m.tick(200000, on) // armed now
  m.tick(250000, on)
  assert.equal(m.active, false)
  m.tick(261000, on)
  assert.equal(m.active, true)
  m.onFix(262000)
  m.tick(263000, on)
  assert.equal(m.active, false)
})

test('depth: needs confirm samples, ignores 0 m and has hysteresis', () => {
  const m = new DepthMonitor({ confirmSamples: 2, hysteresis: 0.3 })
  const c = cfg({ depth: { alarm: true, min_depth: 3 } })
  m.update(2.9, 1, c)
  assert.equal(m.active, false)
  m.update(0, 2, c) // ignored, does not reset the counter
  m.update(2.8, 3, c)
  assert.equal(m.active, true)
  m.update(3.2, 4, c)
  assert.equal(m.active, true)
  m.update(3.4, 5, c)
  assert.equal(m.active, false)
  assert.equal(new DepthMonitor().update(NaN, 1, c), false)
})

test('wind: converts m/s to knots with hysteresis', () => {
  const m = new WindMonitor({ hysteresis: 1 })
  const c = cfg({ wind: { alarm: true, max_speed: 20 } })
  m.update(10, 1, c) // 19.4 kn
  assert.equal(m.active, false)
  m.update(10.4, 2, c) // 20.2 kn
  assert.equal(m.active, true)
  m.update(10.0, 3, c) // 19.4 kn: inside hysteresis
  assert.equal(m.active, true)
  m.update(9.7, 4, c) // 18.9 kn
  assert.equal(m.active, false)
})

test('wind: averaging smooths gusts', () => {
  const m = new WindMonitor({ averageSeconds: 10 })
  const c = cfg({ wind: { alarm: true, max_speed: 20 } })
  m.update(5, 0, c)
  m.update(5, 1000, c)
  m.update(15, 2000, c) // one 29 kn gust, average ~16 kn
  assert.equal(m.active, false)
})
