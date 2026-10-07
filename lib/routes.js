'use strict'

// REST API, mounted by the server under /plugins/signalk-sailorguard.
// See docs/api.md for the contract.

const { isValidHandle, mask } = require('./devices')
const { createPushApi } = require('./push-api')

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

  // Also available as Signal K PUTs on sailorguard.push.register/unregister,
  // which work with a readwrite token on every server version.
  access('readwrite').post(
    '/api/push/register',
    running((rt, req, res) => {
      const r = createPushApi(rt).register(req.body)
      res.status(r.statusCode).json(r.body)
    })
  )

  access('readwrite').post(
    '/api/push/unregister',
    running((rt, req, res) => {
      const r = createPushApi(rt).unregister(req.body)
      res.status(r.statusCode).json(r.body)
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
