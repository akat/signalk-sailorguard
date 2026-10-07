'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AlarmManager } = require('../lib/alarm-manager')

function fakeMonitor(title) {
  return { active: false, title, message: () => `${title} message`, data: () => ({ value: 1, missing: null }) }
}

function setup(policy, t) {
  let now = 0
  const notifications = []
  const pushes = []
  const monitors = { geofence: fakeMonitor('Anchor alarm'), depth: fakeMonitor('Depth alarm') }
  const manager = new AlarmManager({
    monitors,
    policy,
    emitNotification: (path, value) => notifications.push({ path, ...value }),
    push: (type, alarm) => pushes.push({ ...alarm, at: now }),
    now: () => now
  })
  const advance = (ms) => {
    now += ms
    t.mock.timers.tick(ms)
  }
  return { manager, monitors, notifications, pushes, advance }
}

test('raise emits a notification and a push; clear emits normal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, monitors, notifications, pushes } = setup({ geofence: { cooldownSeconds: 10, repeatSeconds: 0, pushOnClear: true } }, t)
  monitors.geofence.active = true
  manager.evaluate('geofence')
  assert.deepEqual(notifications[0], {
    path: 'notifications.geofence.exit',
    state: 'alarm',
    method: ['visual', 'sound'],
    message: 'Anchor alarm message'
  })
  assert.equal(pushes.length, 1)
  // Only type, state and numbers go to the gateway; it renders the text.
  assert.deepEqual(pushes[0], { type: 'geofence', state: 'alarm', data: { value: 1 }, at: 0 })

  monitors.geofence.active = false
  manager.evaluate('geofence')
  assert.equal(notifications[1].state, 'normal')
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].state, 'normal')
})

test('repeats while active and stops after clear', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, monitors, pushes, advance } = setup({ geofence: { cooldownSeconds: 10, repeatSeconds: 30 } }, t)
  monitors.geofence.active = true
  manager.evaluate('geofence')
  advance(30000)
  advance(30000)
  assert.equal(pushes.length, 3)
  monitors.geofence.active = false
  manager.evaluate('geofence')
  advance(120000)
  assert.equal(pushes.length, 3)
})

test('a re-raise inside the cooldown is queued, not dropped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, monitors, pushes, advance } = setup({ depth: { cooldownSeconds: 10, repeatSeconds: 0 } }, t)
  monitors.depth.active = true
  manager.evaluate('depth')
  advance(2000)
  monitors.depth.active = false
  manager.evaluate('depth')
  advance(1000)
  monitors.depth.active = true
  manager.evaluate('depth')
  assert.equal(pushes.length, 1)
  advance(7000)
  assert.equal(pushes.length, 2)
  assert.equal(pushes[1].at, 10000)
})

test('alarm types do not share a cooldown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const policy = { geofence: { cooldownSeconds: 10 }, depth: { cooldownSeconds: 10 } }
  const { manager, monitors, pushes } = setup(policy, t)
  monitors.geofence.active = true
  manager.evaluate('geofence')
  monitors.depth.active = true
  manager.evaluate('depth')
  assert.deepEqual(pushes.map((p) => p.type), ['geofence', 'depth'])
})

test('silent clear (alarm disabled by the user) sends no push', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, monitors, notifications, pushes } = setup({ geofence: { pushOnClear: true } }, t)
  monitors.geofence.active = true
  manager.evaluate('geofence')
  monitors.geofence.active = false
  manager.evaluate('geofence', { silent: true })
  assert.equal(pushes.length, 1)
  assert.equal(notifications.at(-1).state, 'normal')
})
