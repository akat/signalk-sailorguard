'use strict'

const path = require('path')
const { version } = require('./package.json')
const anchorConfig = require('./lib/anchor-config')
const { readJson, writeJson } = require('./lib/json-file')
const { parsePosition } = require('./lib/geo')
const { GeofenceMonitor, PositionLostMonitor, DepthMonitor, WindMonitor } = require('./lib/monitors')
const { AlarmManager } = require('./lib/alarm-manager')
const { DeviceStore, mask } = require('./lib/devices')
const { createGatewayClient } = require('./lib/gateway')
const { registerRoutes } = require('./lib/routes')
const { createPushApi } = require('./lib/push-api')
const { schema, withDefaults, WIND_PATHS } = require('./lib/options')

const PLUGIN_ID = 'signalk-sailorguard'
const CONFIG_PATH = 'navigation.anchor.akat'
// Discovery value for the app, readable with any token on any server version:
//   { apiVersion, installationId, state }  (installationId is not a secret)
const PUSH_PATH = 'sailorguard.push'
const TICK_MS = 5000
const CURRENT_RADIUS_INTERVAL_MS = 2000
const CURRENT_RADIUS_MIN_CHANGE_M = 5
const DAY_MS = 86400000

module.exports = function (app) {
  let runtime

  const plugin = {
    id: PLUGIN_ID,
    name: 'SailorGuard',
    description: 'Anchor (geofence), depth and wind alarms with push notifications for the SailorGuard / 6Pack app',
    schema: () => schema
  }

  const debug = (msg) => app.debug(msg)

  plugin.start = function (rawOptions) {
    const options = withDefaults(rawOptions)
    const dataDir = app.getDataDirPath()
    const configFile = path.join(dataDir, 'anchor-config.json')
    const unsubscribes = []
    const timers = []

    let config = anchorConfig.fromStored(readJson(configFile, undefined))
    const samples = { position: undefined, depth: undefined, wind: undefined }
    let lastCurrentRadius = { at: 0, value: undefined }

    const devices = new DeviceStore(path.join(dataDir, 'push-devices.json'))
    const gateway = createGatewayClient({
      url: options.push.gatewayUrl,
      credentialsFile: path.join(dataDir, 'gateway-credentials.json'),
      pluginVersion: version,
      log: (m) => app.error(m)
    })

    function vesselName() {
      if (!options.push.includeVesselName) return undefined
      const name = app.getSelfPath('name')
      const value = typeof name === 'object' && name !== null ? name.value : name
      return typeof value === 'string' && value.trim() ? value.trim() : undefined
    }

    /** Send an alarm ({type, state, data}) to the given handles via the gateway. */
    async function sendPush(handles, alarm) {
      if (!options.push.enabled) return { sent: 0, results: [], skipped: true }
      const result = await gateway.notify(handles, { ...alarm, vessel: vesselName() })
      const dead = (result.results || []).filter((r) => r.status === 'invalid' || r.status === 'unknown').map((r) => r.handle)
      if (dead.length && devices.remove(dead)) debug(`forgot ${dead.length} unregistered device(s): ${dead.map(mask).join(', ')}`)
      const errors = (result.results || []).filter((r) => r.status === 'error').map((r) => r.error)
      if (result.error || errors.length) app.error(`push ${alarm.type}: ${result.error || [...new Set(errors)].join('; ')}`)
      debug(`push ${alarm.type}/${alarm.state}: sent ${result.sent ?? 0}/${handles.length}`)
      return result
    }

    const monitors = {
      geofence: new GeofenceMonitor(options.geofence),
      position: new PositionLostMonitor({ timeoutSeconds: options.geofence.positionTimeoutSeconds }),
      depth: new DepthMonitor(options.depth),
      wind: new WindMonitor(options.wind)
    }
    const geofencePolicy = {
      cooldownSeconds: options.geofence.cooldownSeconds,
      repeatSeconds: options.geofence.repeatSeconds,
      pushOnClear: options.geofence.pushOnClear
    }
    const manager = new AlarmManager({
      monitors,
      policy: {
        geofence: geofencePolicy,
        position: geofencePolicy,
        depth: options.depth,
        wind: options.wind
      },
      emitNotification: (p, value) => publish([{ path: p, value }]),
      push: (type, alarm) => sendPush(devices.recipients(type), alarm),
      log: debug
    })

    function publish(values) {
      app.handleMessage(PLUGIN_ID, {
        context: 'vessels.self',
        updates: [{ timestamp: new Date().toISOString(), values }]
      })
    }

    function publishConfig() {
      const values = [{ path: CONFIG_PATH, value: anchorConfig.toCanonical(config) }]
      if (options.publishAnchorPaths) {
        const armed = config.anchor.enabled && anchorConfig.hasAnchorPosition(config)
        values.push(
          {
            path: 'navigation.anchor.position',
            value: armed ? { latitude: config.anchor.lat, longitude: config.anchor.lon } : null
          },
          { path: 'navigation.anchor.maxRadius', value: armed ? config.anchor.radius : null }
        )
        if (!armed) values.push({ path: 'navigation.anchor.currentRadius', value: null })
      }
      publish(values)
    }

    function updateStatus() {
      const parts = [
        config.anchor.enabled ? `Geofence ${config.anchor.radius} m` : 'Geofence off',
        config.depth.alarm ? `Depth < ${config.depth.min_depth} m` : 'Depth off',
        config.wind.alarm ? `Wind > ${config.wind.max_speed} kn` : 'Wind off',
        `${devices.list().length} phone(s)`
      ]
      if (!options.push.enabled) parts.push('push off')
      else {
        const gw = gateway.info()
        if (gw.state !== 'ready') parts.push(`push gateway ${gw.state}${gw.error ? `: ${gw.error}` : ''}`)
      }
      const active = Object.entries(manager.state).filter(([, s]) => s.active).map(([t]) => t)
      if (active.length) parts.unshift(`ALARM: ${active.join(', ')}`)
      app.setPluginStatus(parts.join(' · '))
    }

    function commitConfig(next, origin) {
      const prev = config
      config = next
      afterConfigChange(prev, origin)
    }

    function afterConfigChange(prev, origin) {
      try {
        writeJson(configFile, anchorConfig.toCanonical(config))
      } catch (err) {
        app.error(`could not save anchor config: ${err.message}`)
      }
      const a = prev.anchor
      const b = config.anchor
      if (!b.enabled) monitors.geofence.reset()
      else if (a.lat !== b.lat || a.lon !== b.lon || a.radius !== b.radius || !a.enabled) monitors.geofence.rearm()
      if (!config.depth.alarm) monitors.depth.reset()
      if (!config.wind.alarm) monitors.wind.reset()
      monitors.position.tick(Date.now(), config)
      manager.evaluateAll({ silent: true })
      publishConfig()
      updateStatus()
      debug(`anchor config from ${origin}: ${JSON.stringify(anchorConfig.toCanonical(config))}`)
    }

    // ---- config writes from the app -------------------------------------
    // The app writes `navigation.anchor.akat` (and sometimes leaf paths such as
    // `navigation.anchor.akat.anchor.lat`) as plain deltas. Intercept them,
    // merge into the stored config and republish the canonical object instead.
    const selfContexts = new Set(['vessels.self', app.selfContext, app.selfId && `vessels.${app.selfId}`].filter(Boolean))

    app.registerDeltaInputHandler((delta, next) => {
      if (!delta || !Array.isArray(delta.updates) || (delta.context && !selfContexts.has(delta.context))) {
        return next(delta)
      }
      let pending = config
      let touched = false
      const warnings = []
      let origin
      const updates = []
      for (const update of delta.updates) {
        if (update.$source === PLUGIN_ID || !Array.isArray(update.values)) {
          updates.push(update)
          continue
        }
        const keep = []
        for (const v of update.values) {
          let r
          if (v.path === CONFIG_PATH) r = anchorConfig.applyPatch(pending, v.value)
          else if (typeof v.path === 'string' && v.path.startsWith(`${CONFIG_PATH}.`)) {
            r = anchorConfig.applyLeaf(pending, v.path.slice(CONFIG_PATH.length + 1), v.value)
          }
          if (r) {
            pending = r.config
            touched = true
            origin = origin || update.$source || update.source?.label
            warnings.push(...r.warnings)
          } else {
            keep.push(v)
          }
        }
        if (keep.length || (Array.isArray(update.meta) && update.meta.length)) {
          updates.push({ ...update, values: keep })
        }
      }
      if (touched) {
        if (warnings.length) debug(`anchor config warnings: ${warnings.join('; ')}`)
        // Apply now so back-to-back deltas merge correctly, but publish
        // outside the delta chain to avoid re-entering it.
        const prev = config
        config = pending
        setImmediate(() => runtime && afterConfigChange(prev, origin || 'delta'))
      }
      if (updates.length) next({ ...delta, updates })
    })

    app.registerPutHandler('vessels.self', CONFIG_PATH, (context, p, value) => {
      const r = anchorConfig.applyPatch(config, value)
      commitConfig(r.config, 'PUT')
      return {
        state: 'COMPLETED',
        statusCode: 200,
        ...(r.warnings.length ? { message: r.warnings.join('; ') } : {})
      }
    }, PLUGIN_ID)

    // ---- sensor data ----------------------------------------------------
    const subscribe = (skPath, fn) => {
      unsubscribes.push(app.streambundle.getSelfBus(skPath).onValue((d) => {
        try {
          fn(d.value)
        } catch (err) {
          app.error(`${skPath}: ${err.message}`)
        }
      }))
    }

    subscribe('navigation.position', (value) => {
      const pos = parsePosition(value)
      if (!pos) return
      const now = Date.now()
      samples.position = { ...pos, t: now }
      monitors.position.onFix(now)
      manager.evaluate('position')
      if (monitors.geofence.update(pos, now, config)) {
        manager.evaluate('geofence')
        const distance = monitors.geofence.distance
        // Throttled, but a real move is published at once.
        if (options.publishAnchorPaths && distance !== undefined &&
            (now - lastCurrentRadius.at >= CURRENT_RADIUS_INTERVAL_MS ||
             Math.abs(distance - (lastCurrentRadius.value ?? Infinity)) >= CURRENT_RADIUS_MIN_CHANGE_M)) {
          lastCurrentRadius = { at: now, value: distance }
          publish([{ path: 'navigation.anchor.currentRadius', value: Math.round(distance) }])
        }
      }
    })

    subscribe(options.depth.path, (value) => {
      const now = Date.now()
      if (typeof value === 'number') samples.depth = { value, t: now }
      if (monitors.depth.update(value, now, config)) manager.evaluate('depth')
    })

    subscribe(WIND_PATHS[options.wind.source], (value) => {
      const now = Date.now()
      if (typeof value === 'number') samples.wind = { value, t: now }
      if (monitors.wind.update(value, now, config)) manager.evaluate('wind')
    })

    let lastPushInfo
    function publishPushInfo() {
      const gw = gateway.info()
      const value = {
        apiVersion: 2,
        enabled: options.push.enabled,
        installationId: options.push.enabled ? gw.installationId : null,
        state: options.push.enabled ? gw.state : 'disabled'
      }
      const key = JSON.stringify(value)
      if (key === lastPushInfo) return
      lastPushInfo = key
      publish([{ path: PUSH_PATH, value }])
    }

    timers.push(setInterval(() => {
      monitors.position.tick(Date.now(), config)
      manager.evaluate('position')
      updateStatus()
      publishPushInfo()
    }, TICK_MS))

    const prune = () => {
      const old = devices.prune(options.push.pruneAfterDays)
      old.forEach((h) => gateway.deleteHandle(h))
      if (old.length) debug(`pruned ${old.length} phone(s) not seen for ${options.push.pruneAfterDays} days`)
    }
    prune()
    timers.push(setInterval(prune, DAY_MS))

    runtime = {
      devices,
      gateway,
      pushEnabled: options.push.enabled,
      manager,
      sendPush,
      log: debug,
      getConfig: () => anchorConfig.toCanonical(config),
      lastSamples: () => ({
        position: samples.position ? { latitude: samples.position.lat, longitude: samples.position.lon, at: iso(samples.position.t) } : null,
        depth: samples.depth ? { meters: samples.depth.value, at: iso(samples.depth.t) } : null,
        wind: samples.wind ? { metersPerSecond: samples.wind.value, at: iso(samples.wind.t) } : null
      }),
      stop() {
        unsubscribes.forEach((u) => u())
        timers.forEach(clearInterval)
        manager.stop()
        gateway.stop()
      }
    }

    // Phone registration through Signal K PUT, which requires exactly a
    // readwrite token on every server version (unlike /plugins routes, which
    // need admin before Signal K added per-route permissions).
    const pushApi = createPushApi(runtime)
    const putResult = ({ statusCode, body }) => ({
      state: 'COMPLETED',
      statusCode,
      ...(statusCode >= 400 ? { message: body.error } : { message: JSON.stringify(body) })
    })
    app.registerPutHandler('vessels.self', `${PUSH_PATH}.register`, (ctx, p, value) => putResult(pushApi.register(value || {})), PLUGIN_ID)
    app.registerPutHandler('vessels.self', `${PUSH_PATH}.unregister`, (ctx, p, value) => putResult(pushApi.unregister(value || {})), PLUGIN_ID)

    publishConfig()
    publishPushInfo()
    updateStatus()
    if (options.push.enabled) {
      gateway.ensureReady().then(() => {
        if (!runtime) return
        updateStatus()
        publishPushInfo()
      })
    }
  }

  plugin.stop = function () {
    if (runtime) runtime.stop()
    runtime = undefined
  }

  plugin.registerWithRouter = function (router) {
    registerRoutes(router, { getRuntime: () => runtime, pluginId: PLUGIN_ID, version })
  }

  return plugin
}

function iso(t) {
  return new Date(t).toISOString()
}
