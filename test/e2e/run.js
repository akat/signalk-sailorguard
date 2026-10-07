'use strict'

// End-to-end test of the whole push path:
//
//   app (simulated) ──handle──▶ sailorguard-push gateway ◀──alarm── plugin in a real Signal K server
//                                        │
//                                        ├──▶ fake Expo push service (Android)
//                                        └──▶ fake APNs over HTTP/2 + TLS (iOS)
//
//   npm install && npm run test:e2e
//
// Needs the gateway repo next to this one (or SAILORGUARD_PUSH_DIR) and openssl.

const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')
const bcrypt = require('bcryptjs')

const ROOT = path.resolve(__dirname, '../..')
const GATEWAY_DIR = process.env.SAILORGUARD_PUSH_DIR || path.resolve(ROOT, '../sailorguard-push')
const { startFakeApns } = require(path.join(GATEWAY_DIR, 'test/helpers/fake-apns'))
// SK_SERVER_DIR=/path/to/node_modules/signalk-server runs against another server version (e.g. 2.16).
const SERVER_DIR = process.env.SK_SERVER_DIR || path.dirname(require.resolve('signalk-server/package.json'))
const SERVER_BIN = path.join(SERVER_DIR, 'bin/signalk-server')
const SERVER_VERSION = require(path.join(SERVER_DIR, 'package.json')).version
const PUSH_INFO = '/signalk/v1/api/vessels/self/sailorguard/push'
const PUT_REGISTER = '/signalk/v1/api/vessels/self/sailorguard/push/register'
const PUT_UNREGISTER = '/signalk/v1/api/vessels/self/sailorguard/push/unregister'
const put = (value, headers = {}) => ({ method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ value }) })
const putBody = (r) => { try { return JSON.parse(r.body.message) } catch { return {} } }
const EXPO_PORT = 18090
const GATEWAY_PORT = 18600
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
const check = (cond, msg) => {
  console.log(cond ? 'PASS' : 'FAIL', msg)
  if (!cond) ok = false
}
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

async function request(url, init) {
  const r = await fetch(url, init)
  const t = await r.text()
  let b
  try { b = JSON.parse(t) } catch { b = t }
  return { status: r.status, body: b }
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(500)
  }
  throw new Error(`${url} did not come up`)
}

function startProcess(args, env) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env } })
  let out = ''
  p.stdout.on('data', (d) => (out += d))
  p.stderr.on('data', (d) => (out += d))
  return { kill: () => p.kill(), output: () => out }
}

function makeConfigDir({ security }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-sailorguard-'))
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.mkdirSync(path.join(dir, 'plugin-config-data'))
  fs.symlinkSync(ROOT, path.join(dir, 'node_modules/signalk-sailorguard'), 'dir')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sk-config', version: '0.0.1', dependencies: { 'signalk-sailorguard': `file:${ROOT}` } }))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    interfaces: {},
    ssl: false,
    pipedProviders: [],
    ...(security ? { security: { strategy: './tokensecurity' } } : {})
  }))
  fs.writeFileSync(path.join(dir, 'baseDeltas.json'), JSON.stringify([{ context: 'vessels.self', updates: [{ values: [{ path: '', value: { name: 'Thalassa', uuid: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d' } }] }] }]))
  if (security) {
    fs.writeFileSync(path.join(dir, 'security.json'), JSON.stringify({ allow_readonly: false, expiration: 'NEVER', secretKey: 'x'.repeat(64), users: [{ username: 'admin', type: 'admin', password: bcrypt.hashSync('pw', 10) }], devices: [], acls: [], allowDeviceAccessRequests: true }))
  }
  fs.writeFileSync(path.join(dir, 'plugin-config-data/signalk-sailorguard.json'), JSON.stringify({
    enabled: true,
    configuration: {
      push: { gatewayUrl: GATEWAY },
      geofence: { maxSpeedKnots: 5000, confirmFixes: 2, cooldownSeconds: 2, repeatSeconds: 4, positionTimeoutSeconds: 0 },
      depth: { confirmSamples: 2 }
    }
  }))
  return dir
}

async function startSignalK(port, opts) {
  const dir = makeConfigDir(opts)
  const p = startProcess([SERVER_BIN, '-c', dir], { PORT: String(port) })
  await waitFor(`http://127.0.0.1:${port}/signalk`)
  await sleep(1500)
  return { stop: () => { p.kill(); fs.rmSync(dir, { recursive: true, force: true }) }, output: p.output }
}

async function appFlow({ expoPushes, apns }) {
  const PORT = 13000
  const SK = `http://127.0.0.1:${PORT}`
  const sk = (p, init) => request(SK + p, init)
  const server = await startSignalK(PORT, { security: false })
  try {
    // 1. The plugin registers itself with the gateway on start and publishes
    //    sailorguard.push for the app (readable with any token).
    let info
    for (let i = 0; i < 40; i++) {
      info = await sk(PUSH_INFO)
      if (info.body?.value?.state === 'ready') break
      await sleep(250)
    }
    const gwInstallation = info.body?.value?.installationId
    check(info.body?.value?.state === 'ready' && /^sgi_/.test(gwInstallation), `plugin registered with gateway, discovery value: ${JSON.stringify(info.body?.value)}`)

    // 2. The app: push token -> gateway handle -> plugin (Android in Greek, iPhone in English).
    async function registerPhone(pushToken, locale, platform, appInstallationId) {
      const h = await request(`${GATEWAY}/v1/handles`, json({ installationId: gwInstallation, pushToken, locale, platform, appInstallationId }))
      const r = await sk(PUT_REGISTER, put({ handle: h.body.handle, installationId: appInstallationId, platform }))
      return { handle: h.body.handle, gw: h.status, plugin: r, result: putBody(r) }
    }
    const android = await registerPhone('ExponentPushToken[android1]', 'el-GR', 'android', 'phone-android')
    const iphone = await registerPhone(`ExponentPushToken[apns:${'ab'.repeat(32)}]`, 'en-US', 'ios', 'phone-ios')
    check(android.gw === 201 && android.plugin.status === 200 && iphone.result.totalDevices === 2, `phones registered via Signal K PUT: ${JSON.stringify(iphone.plugin.body)}`)
    const raw = await sk(PUT_REGISTER, put({ token: 'ExponentPushToken[android1]' }))
    check(raw.status === 400 && /Raw push tokens are not accepted/.test(raw.body.message), `raw push token refused by the plugin (${raw.status})`)

    // 3. Alarm config from the app, then the boat drifts out of the circle.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/signalk/v1/stream?subscribe=none`)
    await new Promise((r) => ws.on('open', r))
    const send = (values, label = 'signalk-node-red') => ws.send(JSON.stringify({ context: 'vessels.self', updates: [{ source: { label }, timestamp: new Date().toISOString(), values }] }))
    const A = { lat: 37.9, lon: 23.7 }
    send([{ path: 'navigation.anchor.akat', value: { anchor: { enabled: true, radius: 40, ...A, ts: 1696690000000 }, depth: { alarm: true, min_depth: 3.0 }, wind: { alarm: false, max_speed: 25.0 } } }])
    await sleep(500)
    const cfg = await sk('/signalk/v1/api/vessels/self/navigation/anchor/akat')
    check(cfg.body.value?.anchor?.enabled === true && cfg.body.value.anchor.radius === 40, `config applied: ${JSON.stringify(cfg.body.value)}`)

    const north = (m) => ({ latitude: A.lat + m / 111195, longitude: A.lon })
    send([{ path: 'navigation.position', value: north(10) }], 'gps'); await sleep(300)
    send([{ path: 'navigation.position', value: north(70) }], 'gps'); await sleep(300)
    check(expoPushes.length === 0 && apns.requests.length === 0, 'no push after a single outside fix')
    send([{ path: 'navigation.position', value: north(72) }], 'gps'); await sleep(1000)

    const a = expoPushes[0]
    check(a?.to === 'ExponentPushToken[android1]' && a.title === 'Thalassa: Συναγερμός άγκυρας' && /72 m από την άγκυρα \(ακτίνα 40 m\)/.test(a.body) &&
      a.channelId === 'geofence-alarms' && a.data.type === 'geofence-alarm' && a.authorization === 'Bearer expo-secret',
      `Android push rendered by the gateway (Greek): ${JSON.stringify(a)}`)
    const i = apns.requests[0]
    check(i?.jwtValid && i.topic === 'com.akat78.sixpack' && i.deviceToken === 'ab'.repeat(32) && i.payload.aps.alert.title === 'Thalassa: Anchor alarm' &&
      i.payload.aps.sound === 'geofence_alarm.caf' && i.payload.type === 'geofence-alarm',
      `iOS push via APNs (English): ${JSON.stringify(i?.payload)}`)
    const n = await sk('/signalk/v1/api/vessels/self/notifications/geofence/exit')
    check(n.body.value?.state === 'alarm', 'Signal K notification raised')

    await sleep(4500)
    check(expoPushes.filter((p) => p.data.type === 'geofence-alarm' && p.data.state === 'alarm').length >= 2, `repeat while active (${expoPushes.length})`)
    send([{ path: 'navigation.position', value: north(20) }], 'gps'); await sleep(800)
    check(expoPushes.at(-1).data.state === 'normal' && expoPushes.at(-1).title === 'Thalassa: Ο συναγερμός άγκυρας έληξε', `clear push: ${expoPushes.at(-1).title}`)

    // 4. Depth alarm.
    const before = expoPushes.length
    send([{ path: 'environment.depth.belowTransducer', value: 2.5 }], 'depth'); await sleep(200)
    send([{ path: 'environment.depth.belowTransducer', value: 2.4 }], 'depth'); await sleep(800)
    const d = expoPushes.slice(before)
    check(d.length === 1 && d[0].channelId === 'depth-alarms' && d[0].body === 'Βάθος 2.4 m (όριο 3 m).', `depth push: ${JSON.stringify(d[0])}`)

    // 5. A phone that uninstalled the app: Expo reports DeviceNotRegistered and both sides forget it.
    const gone = await registerPhone('ExponentPushToken[gone]', 'en', 'android', 'phone-gone')
    const test1 = await sk('/plugins/signalk-sailorguard/api/push/test', json({}))
    check(test1.status === 200 && test1.body.sent === 2, `test push: ${JSON.stringify(test1.body)}`)
    const info2 = await sk('/plugins/signalk-sailorguard/api/info')
    check(info2.body.push.devices === 2, `dead phone forgotten by the plugin (devices=${info2.body.push.devices}, handle ${gone.handle.slice(0, 8)}…)`)

    // 6. Another boat cannot push to these phones with its own credential.
    const intruder = await request(`${GATEWAY}/v1/installations`, json({}))
    const steal = await request(`${GATEWAY}/v1/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${intruder.body.credential}` },
      body: JSON.stringify({ handles: [android.handle, iphone.handle], type: 'geofence', data: { distance: 999 } })
    })
    check(steal.status === 200 && steal.body.sent === 0 && steal.body.results.every((r) => r.status === 'unknown'), `other installation cannot use these handles: ${JSON.stringify(steal.body)}`)

    // 7. Unregister a phone: the plugin also withdraws the handle from the gateway.
    const un = await sk(PUT_UNREGISTER, put({ installationId: 'phone-ios' }))
    await sleep(300)
    const reuse = await request(`${GATEWAY}/v1/handles/revoke`, json({ handle: iphone.handle, pushToken: `ExponentPushToken[apns:${'ab'.repeat(32)}]` }))
    check(putBody(un).removed === 1 && reuse.status === 404, `unregister removed the handle at the gateway too (${reuse.status})`)
    ws.close()
  } catch (e) {
    console.error(e)
    ok = false
  } finally {
    if (!ok) console.log(server.output().slice(-3000))
    server.stop()
  }
}

async function securityFlow() {
  const PORT = 13001
  const sk = (p, init) => request(`http://127.0.0.1:${PORT}${p}`, init)
  const server = await startSignalK(PORT, { security: true })
  try {
    const login = await sk('/signalk/v1/auth/login', json({ username: 'admin', password: 'pw' }))
    const admin = { Authorization: `Bearer ${login.body.token}`, 'Content-Type': 'application/json' }
    async function deviceToken(clientId, permissions) {
      const req = await sk('/signalk/v1/access/requests', json({ clientId, description: 'test', permissions }))
      await sk(`/skServer/security/access/requests/${clientId}/approved`, { method: 'PUT', headers: admin, body: JSON.stringify({ expiration: 'NEVER', permissions }) })
      return (await sk(req.body.href)).body.accessRequest?.token
    }
    const rw = await deviceToken('dev-rw-1', 'readwrite')
    const ro = await deviceToken('dev-ro-1', 'readonly')
    check(rw && ro, 'got device tokens')
    const reg = (tok) => sk(PUT_REGISTER, put({ handle: 'sgh_SSSSSSSSSSSSSSSSSSSSSS' }, tok ? { Authorization: `Bearer ${tok}` } : {}))
    const anon = await reg()
    check(anon.status === 401 || anon.status === 403, `anonymous register denied (${anon.status})`)
    const roReg = await reg(ro)
    check(roReg.status === 401 || roReg.status === 403, `readonly register denied (${roReg.status})`)
    const rwReg = await reg(rw)
    check(rwReg.status === 200, `readwrite register allowed via PUT (${rwReg.status} ${JSON.stringify(rwReg.body)})`)
    const roInfo = await sk(PUSH_INFO, { headers: { Authorization: `Bearer ${ro}` } })
    check(roInfo.status === 200 && roInfo.body?.value?.apiVersion === 2, `readonly can read the discovery value (${roInfo.status})`)
    check((await sk('/plugins/signalk-sailorguard/api/push/devices', { headers: { Authorization: `Bearer ${rw}` } })).status === 401, 'readwrite cannot list devices')
    check((await sk('/plugins/signalk-sailorguard/api/push/devices', { headers: admin })).status === 200, 'admin lists devices')
  } catch (e) {
    console.error(e)
    ok = false
  } finally {
    server.stop()
  }
}

;(async () => {
  const apns = await startFakeApns()
  const expoPushes = []
  const expo = http
    .createServer((req, res) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        const messages = JSON.parse(b)
        for (const m of messages) expoPushes.push({ ...m, authorization: req.headers.authorization })
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({
          data: messages.map((m, i) => m.to === 'ExponentPushToken[gone]'
            ? { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok', id: `t-${expoPushes.length}-${i}` })
        }))
      })
    })
    .listen(EXPO_PORT)

  const gwDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-push-')), 'push.db')
  const gateway = startProcess(['--disable-warning=ExperimentalWarning', path.join(GATEWAY_DIR, 'src/server.js')], {
    PORT: String(GATEWAY_PORT),
    DB_FILE: gwDb,
    TRUST_PROXY: '0',
    EXPO_ENDPOINT: `http://127.0.0.1:${EXPO_PORT}/--/api/v2/push/send`,
    EXPO_ACCESS_TOKEN: 'expo-secret',
    APNS_KEY: apns.keyPem,
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM456',
    APNS_HOST: apns.host,
    // The fake APNs uses a self-signed certificate; only this test gateway skips verification.
    NODE_TLS_REJECT_UNAUTHORIZED: '0'
  })
  await waitFor(`${GATEWAY}/health`)

  console.log(`# Signal K server ${SERVER_VERSION}`)
  console.log('# app flow (plugin + gateway)')
  await appFlow({ expoPushes, apns })
  console.log('# security')
  await securityFlow()

  if (!ok) console.log(gateway.output().slice(-2000))
  gateway.kill()
  expo.close()
  await apns.close()
  process.exit(ok ? 0 : 1)
})()
