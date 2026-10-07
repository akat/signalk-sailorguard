'use strict'

// REST API, mounted by the server under /plugins/signalk-sailorguard.
// See docs/api.md for the contract.

const { isValidHandle, mask, ALARM_TYPES } = require('./devices')

function registerRoutes(router, { getRuntime, pluginId, version }) {
  // `router.access(level)` registers per-route permissions on servers that
  // support it. On older servers every plugin route requires admin when
  // security is enabled.
  const access = (level) => (typeof router.access === 'function' ? router.access(level) : router)
  // Routes without a registered permission require admin. Registering
  // 'admin' explicitly would be treated as readwrite by the server.
  const adminOnly = router

  const running = (handler) => (req, res) => {
    const rt = getRuntime()
    if (!rt) return res.status(503).json({ ok: false, error: 'plugin is not running' })
    const fail = (err) => {
      if (!res.headersSent) res.status(500).json({ ok: false, error: err.message })
    }
    try {
      return Promise.resolve(handler(rt, req, res)).catch(fail)
    } catch (err) {
      return fail(err)
    }
  }

  // Capability discovery. The app reads `push.gateway.installationId` here to
  // obtain a handle from the gateway before registering.
  access('readonly').get('/api/info', (req, res) => {
    const rt = getRuntime()
    const gateway = rt?.gateway.info()
    res.json({
      id: pluginId,
      version,
      running: Boolean(rt),
      apiVersion: 2,
      capabilities: ['anchor-config', 'geofence', 'depth-alarm', 'wind-alarm', 'position-lost', 'push-gateway'],
      configPath: 'navigation.anchor.akat',
      push: rt
        ? {
            enabled: rt.pushEnabled,
            devices: rt.devices.list().length,
            gateway: { url: gateway.url, installationId: gateway.installationId, state: gateway.state }
          }
        : null
    })
  })

  access('readonly').get(
    '/api/status',
    running((rt, req, res) => {
      res.json({
        config: rt.getConfig(),
        alarms: rt.manager.status(),
        lastSamples: rt.lastSamples(),
        gateway: rt.gateway.info()
      })
    })
  )

  access('readwrite').post(
    '/api/push/register',
    running((rt, req, res) => {
      const body = req.body || {}
      if (!isValidHandle(body.handle)) {
        const hint = typeof body.token === 'string' ? ' Raw push tokens are not accepted: get a handle from the push gateway first.' : ''
        return res.status(400).json({ ok: false, error: `handle (sgh_...) required.${hint}` })
      }
      if (body.alarms !== undefined && !Array.isArray(body.alarms)) {
        return res.status(400).json({ ok: false, error: `alarms must be an array of ${ALARM_TYPES.join(', ')}` })
      }
      const result = rt.devices.register(body)
      // Old handles of the same phone are withdrawn from the gateway as well.
      for (const old of [result.replacedHandle, ...(result.evicted || [])].filter(Boolean)) rt.gateway.deleteHandle(old)
      rt.log(`push device ${result.added ? 'registered' : 'refreshed'}: ${mask(body.handle)}`)
      res.json({ ok: true, added: result.added, totalDevices: rt.devices.list().length })
    })
  )

  access('readwrite').post(
    '/api/push/unregister',
    running((rt, req, res) => {
      const { handle, installationId } = req.body || {}
      if (!handle && !installationId) {
        return res.status(400).json({ ok: false, error: 'handle or installationId required' })
      }
      const removed = rt.devices.unregister({ handle, installationId })
      removed.forEach((h) => rt.gateway.deleteHandle(h))
      res.json({ ok: true, removed: removed.length, totalDevices: rt.devices.list().length })
    })
  )

  access('readwrite').post(
    '/api/push/test',
    running(async (rt, req, res) => {
      const { handle } = req.body || {}
      if (handle !== undefined && !isValidHandle(handle)) return res.status(400).json({ ok: false, error: 'Invalid handle' })
      const handles = handle ? [handle] : rt.devices.recipients('test')
      if (!handles.length) return res.status(404).json({ ok: false, error: 'No registered devices' })
      const result = await rt.sendPush(handles, { type: 'test', state: 'alarm', data: {} })
      res.status(result.sent > 0 ? 200 : 502).json({ ok: result.sent > 0, ...result })
    })
  )

  adminOnly.get(
    '/api/push/devices',
    running((rt, req, res) => {
      res.json({
        count: rt.devices.list().length,
        devices: rt.devices.list().map((e) => ({ ...e, handle: mask(e.handle) }))
      })
    })
  )

  adminOnly.delete(
    '/api/push/devices',
    running((rt, req, res) => {
      const removed = rt.devices.clear()
      removed.forEach((h) => rt.gateway.deleteHandle(h))
      res.json({ ok: true, deleted: removed.length })
    })
  )
}

module.exports = { registerRoutes }
