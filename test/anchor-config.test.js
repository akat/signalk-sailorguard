'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const ac = require('../lib/anchor-config')

const appPayload = {
  anchor: { enabled: true, radius: 40, lat: 37.9, lon: 23.7, ts: 1696690000000 },
  depth: { alarm: true, min_depth: 3.0 },
  wind: { alarm: false, max_speed: 25.0 }
}

test('applies the payload the 6Pack app sends', () => {
  const { config, changed, warnings } = ac.applyPatch(ac.defaultConfig(), appPayload)
  assert.equal(changed, true)
  assert.deepEqual(warnings, [])
  assert.deepEqual(ac.toCanonical(config), appPayload)
})

test('accepts a {value: ...} wrapper and aliases', () => {
  const { config } = ac.applyPatch(ac.defaultConfig(), {
    value: {
      radius: '55',
      anchor: { latitude: 1, longitude: 2, enabled: 'on' },
      depthConfig: { enabled: 1, minDepth: 4 },
      windConfig: { active: 'true', maxSpeed: 30 }
    }
  })
  assert.equal(config.anchor.radius, 55)
  assert.equal(config.anchor.enabled, true)
  assert.deepEqual([config.anchor.lat, config.anchor.lon], [1, 2])
  assert.deepEqual(config.depth, { alarm: true, min_depth: 4 })
  assert.deepEqual(config.wind, { alarm: true, max_speed: 30 })
})

test('refuses to enable the geofence without an anchor position', () => {
  const { config, warnings } = ac.applyPatch(ac.defaultConfig(), { anchor: { enabled: true, radius: 50 } })
  assert.equal(config.anchor.enabled, false)
  assert.equal(config.anchor.radius, 50)
  assert.match(warnings[0], /without an anchor position/)
})

test('ignores out-of-range values but keeps the rest', () => {
  const start = ac.applyPatch(ac.defaultConfig(), appPayload).config
  const { config, warnings } = ac.applyPatch(start, { anchor: { radius: -5, lat: 123 }, depth: { min_depth: 0 } })
  assert.equal(config.anchor.radius, 40)
  assert.equal(config.anchor.lat, 37.9)
  assert.equal(config.depth.min_depth, 3)
  assert.equal(warnings.length, 3)
})

test('partial updates merge and do not reset other fields', () => {
  const start = ac.applyPatch(ac.defaultConfig(), appPayload).config
  const { config } = ac.applyPatch(start, { wind: { alarm: true } })
  assert.equal(config.wind.alarm, true)
  assert.equal(config.wind.max_speed, 25)
  assert.equal(config.anchor.enabled, true)
  assert.equal(config.depth.alarm, true)
})

test('leaf writes (including ISO ts from setAnchorPosition) are merged', () => {
  let cfg = ac.defaultConfig()
  cfg = ac.applyLeaf(cfg, 'anchor.lat', 10).config
  cfg = ac.applyLeaf(cfg, 'anchor.lon', 20).config
  cfg = ac.applyLeaf(cfg, 'anchor.ts', '2026-10-07T10:00:00.000Z').config
  cfg = ac.applyLeaf(cfg, 'anchor.enabled', true).config
  assert.deepEqual(ac.toCanonical(cfg).anchor, {
    enabled: true,
    radius: 100,
    lat: 10,
    lon: 20,
    ts: Date.parse('2026-10-07T10:00:00.000Z')
  })
  assert.equal(ac.applyLeaf(cfg, 'vessel', { name: 'x' }), undefined)
})

test('moving the anchor without ts stamps the current time', () => {
  const { config } = ac.applyPatch(ac.defaultConfig(), { anchor: { lat: 1, lon: 1 } }, 12345)
  assert.equal(config.anchor.ts, 12345)
})

test('fromStored round-trips the canonical form', () => {
  const canonical = ac.toCanonical(ac.applyPatch(ac.defaultConfig(), appPayload).config)
  assert.deepEqual(ac.toCanonical(ac.fromStored(canonical)), canonical)
  assert.deepEqual(ac.fromStored(undefined), ac.defaultConfig())
})
