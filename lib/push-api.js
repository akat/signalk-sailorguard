'use strict'

// Phone registration logic, shared by the REST routes (/plugins/...) and the
// Signal K PUT handlers (sailorguard.push.*).
//
// The PUT handlers exist because Signal K servers before router.access
// (e.g. 2.16) require *admin* for every /plugins route, while a PUT on
// /signalk/v1/api/vessels/self/... needs exactly readwrite on every version.

const { isValidHandle, mask, ALARM_TYPES } = require('./devices')

function createPushApi(rt) {
  function register(body = {}) {
    if (!isValidHandle(body.handle)) {
      const hint = typeof body.token === 'string' ? ' Raw push tokens are not accepted: get a handle from the push gateway first.' : ''
      return { statusCode: 400, body: { ok: false, error: `handle (sgh_...) required.${hint}` } }
    }
    if (body.alarms !== undefined && !Array.isArray(body.alarms)) {
      return { statusCode: 400, body: { ok: false, error: `alarms must be an array of ${ALARM_TYPES.join(', ')}` } }
    }
    const result = rt.devices.register(body)
    // Old handles of the same phone are withdrawn from the gateway as well.
    for (const old of [result.replacedHandle, ...(result.evicted || [])].filter(Boolean)) rt.gateway.deleteHandle(old)
    rt.log(`push device ${result.added ? 'registered' : 'refreshed'}: ${mask(body.handle)}`)
    rt.onDevicesChanged?.()
    return { statusCode: 200, body: { ok: true, added: result.added, totalDevices: rt.devices.list().length } }
  }

  function unregister(body = {}) {
    const { handle, installationId } = body
    if (!handle && !installationId) {
      return { statusCode: 400, body: { ok: false, error: 'handle or installationId required' } }
    }
    const removed = rt.devices.unregister({ handle, installationId })
    removed.forEach((h) => rt.gateway.deleteHandle(h))
    rt.onDevicesChanged?.()
    return { statusCode: 200, body: { ok: true, removed: removed.length, totalDevices: rt.devices.list().length } }
  }

  return { register, unregister }
}

module.exports = { createPushApi }
