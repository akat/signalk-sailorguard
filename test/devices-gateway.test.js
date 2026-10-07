'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { DeviceStore, isValidHandle } = require('../lib/devices')
const { createGatewayClient } = require('../lib/gateway')

const H1 = 'sgh_AAAAAAAAAAAAAAAAAAAAAA'
const H2 = 'sgh_BBBBBBBBBBBBBBBBBBBBBB'
const H3 = 'sgh_CCCCCCCCCCCCCCCCCCCCCC'
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'))

test('handle validation rejects raw push tokens', () => {
  assert.equal(isValidHandle(H1), true)
  assert.equal(isValidHandle('ExponentPushToken[abc]'), false)
  assert.equal(isValidHandle('sgh_short'), false)
})

test('device store: a new handle from the same phone replaces the old one', () => {
  const file = path.join(tmpDir(), 'devices.json')
  const store = new DeviceStore(file)
  assert.equal(store.register({ handle: H1, installationId: 'phone-1' }).added, true)
  const r = store.register({ handle: H2, installationId: 'phone-1' })
  assert.equal(r.replacedHandle, H1)
  store.register({ handle: H3, alarms: ['geofence'] })
  assert.deepEqual(new DeviceStore(file).list().map((e) => e.handle), [H2, H3])
  assert.deepEqual(store.recipients('depth'), [H2])
  assert.deepEqual(store.recipients('test'), [H2, H3])
  assert.deepEqual(store.unregister({ installationId: 'phone-1' }), [H2])
  assert.equal(store.remove([H3]), 1)
})

test('device store prunes phones not seen for N days', () => {
  const store = new DeviceStore(path.join(tmpDir(), 'devices.json'))
  store.register({ handle: H1 }, Date.parse('2026-01-01'))
  store.register({ handle: H2 }, Date.parse('2026-03-01'))
  assert.deepEqual(store.prune(30, Date.parse('2026-03-10')), [H1])
})

function fakeGateway(handlers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url)
    const call = { method: init.method, path: pathname, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const [status, body] = handlers(call)
    return { status, json: async () => body }
  }
  return { calls, fetchImpl }
}

const CRED = { installationId: 'sgi_XXXXXXXXXXXXXXXXXXXXXX', secret: 's'.repeat(43) }

test('gateway client registers once, stores the credential and authenticates notify', async () => {
  const dir = tmpDir()
  const credentialsFile = path.join(dir, 'gateway.json')
  const gw = fakeGateway(({ method, path: p }) => {
    if (method === 'POST' && p === '/v1/installations') return [201, CRED]
    if (method === 'POST' && p === '/v1/notify') return [200, { sent: 1, results: [{ handle: H1, status: 'sent' }] }]
    return [404, {}]
  })
  const client = createGatewayClient({ url: 'https://gw.test/', credentialsFile, pluginVersion: '1.0.0', fetchImpl: gw.fetchImpl })
  assert.equal(await client.ensureReady(), true)
  assert.deepEqual(client.info(), { url: 'https://gw.test', state: 'ready', installationId: CRED.installationId })
  assert.equal(JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).secret, CRED.secret)

  const r = await client.notify([H1], { type: 'geofence', state: 'alarm', data: { distance: 70 } })
  assert.equal(r.sent, 1)
  const notify = gw.calls.at(-1)
  assert.equal(notify.auth, `Bearer ${CRED.installationId}.${CRED.secret}`)
  assert.deepEqual(notify.body, { handles: [H1], type: 'geofence', state: 'alarm', data: { distance: 70 } })
  client.stop()
})

test('gateway client re-registers when the gateway forgot it, and stops when revoked', async () => {
  const dir = tmpDir()
  const credentialsFile = path.join(dir, 'gateway.json')
  fs.writeFileSync(credentialsFile, JSON.stringify({ installationId: 'sgi_OLDOLDOLDOLDOLDOLDOLDO', secret: 'o'.repeat(43) }))
  let revoked = false
  const gw = fakeGateway(({ method, path: p }) => {
    if (p === '/v1/installations/me') return revoked ? [403, { error: 'Installation revoked' }] : [401, {}]
    if (method === 'POST' && p === '/v1/installations') return [201, CRED]
    return [404, {}]
  })
  const client = createGatewayClient({ url: 'https://gw.test', credentialsFile, pluginVersion: '1', fetchImpl: gw.fetchImpl })
  assert.equal(await client.ensureReady(), true)
  assert.equal(client.info().installationId, CRED.installationId)
  client.stop()

  revoked = true
  const again = createGatewayClient({ url: 'https://gw.test', credentialsFile, pluginVersion: '1', fetchImpl: gw.fetchImpl })
  assert.equal(await again.ensureReady(), false)
  assert.equal(again.info().state, 'revoked')
  again.stop()
})

test('gateway client reports an unreachable gateway without throwing', async () => {
  const client = createGatewayClient({
    url: 'https://gw.test',
    credentialsFile: path.join(tmpDir(), 'gateway.json'),
    pluginVersion: '1',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
  })
  const r = await client.notify([H1], { type: 'test', state: 'alarm', data: {} })
  assert.equal(r.sent, 0)
  assert.match(r.error, /ENOTFOUND/)
  assert.equal(client.info().state, 'unregistered')
  client.stop()
})
