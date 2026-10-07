'use strict'

// Client for the SailorGuard push gateway (push.sailorguard.com).
//
// The gateway holds the APNs/Expo credentials and the phones' push tokens. This
// plugin only ever holds:
//   - its own installation credential (issued on first start, kept in the data dir)
//   - opaque handles the app obtained from the gateway for this installation
// and sends alarm *types and numbers*; the gateway renders the text.

const { readJson, writeJson } = require('./json-file')

const RETRY_MIN_MS = 30 * 1000
const RETRY_MAX_MS = 10 * 60 * 1000

function createGatewayClient({ url, credentialsFile, pluginVersion, log = () => {}, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const base = url.replace(/\/+$/, '')
  let credential = readJson(credentialsFile, undefined)
  if (!credential?.installationId || !credential?.secret) credential = undefined
  let state = credential ? 'unverified' : 'unregistered'
  let lastError
  let retryTimer
  let retryDelay = RETRY_MIN_MS
  let stopped = false
  let registering

  async function request(method, path, body, auth = true) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && credential ? { Authorization: `Bearer ${credential.installationId}.${credential.secret}` } : {}),
        'X-Plugin-Version': pluginVersion
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    })
    let payload
    try {
      payload = await res.json()
    } catch {
      payload = {}
    }
    return { status: res.status, body: payload }
  }

  async function register() {
    const r = await request('POST', '/v1/installations', { pluginVersion }, false)
    if (r.status !== 201) throw new Error(`gateway registration failed (${r.status}): ${r.body.error || ''}`)
    credential = { installationId: r.body.installationId, secret: r.body.secret, createdAt: new Date().toISOString() }
    writeJson(credentialsFile, credential)
    log(`registered with push gateway as ${credential.installationId}`)
  }

  async function verifyOrRegister() {
    if (credential) {
      const r = await request('GET', '/v1/installations/me')
      if (r.status === 200) return
      if (r.status === 403) {
        state = 'revoked'
        throw new Error('this installation was revoked by the push gateway')
      }
      if (r.status !== 401) throw new Error(`gateway check failed (${r.status})`)
      // The gateway no longer knows us (e.g. its database was reset): start over.
      log('push gateway does not recognise this installation, registering again')
      credential = undefined
    }
    await register()
  }

  function scheduleRetry() {
    if (stopped || retryTimer || state === 'revoked') return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      ensureReady()
    }, retryDelay)
    retryTimer.unref?.()
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
  }

  /** Verify (or obtain) the credential; retries in the background on failure. */
  function ensureReady() {
    if (stopped) return Promise.resolve(false)
    if (!registering) {
      registering = verifyOrRegister()
        .then(() => {
          state = 'ready'
          lastError = undefined
          retryDelay = RETRY_MIN_MS
          return true
        })
        .catch((err) => {
          if (state !== 'revoked') state = credential ? 'unverified' : 'unregistered'
          lastError = err.message
          log(`push gateway: ${err.message}`)
          scheduleRetry()
          return false
        })
        .finally(() => {
          registering = undefined
        })
    }
    return registering
  }

  /**
   * @param {string[]} handles
   * @param {{type, state, data, vessel?}} alarm
   * @returns {Promise<{sent, results: {handle, status, error?}[], error?}>}
   */
  async function notify(handles, alarm) {
    if (!handles.length) return { sent: 0, results: [] }
    if (state !== 'ready' && !(await ensureReady())) {
      return { sent: 0, results: [], error: lastError || 'push gateway not available' }
    }
    try {
      const r = await request('POST', '/v1/notify', { handles, ...alarm })
      if (r.status === 200) return r.body
      if (r.status === 401 || r.status === 403) {
        state = 'unverified'
        ensureReady()
      }
      return { sent: 0, results: [], error: `gateway responded ${r.status}: ${r.body.error || ''}` }
    } catch (err) {
      return { sent: 0, results: [], error: err.message }
    }
  }

  async function deleteHandle(handle) {
    if (state !== 'ready') return
    try {
      await request('DELETE', `/v1/handles/${encodeURIComponent(handle)}`)
    } catch (err) {
      log(`could not remove handle from gateway: ${err.message}`)
    }
  }

  return {
    ensureReady,
    notify,
    deleteHandle,
    info: () => ({
      url: base,
      state,
      installationId: credential?.installationId ?? null,
      ...(lastError ? { error: lastError } : {})
    }),
    stop() {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }
}

module.exports = { createGatewayClient }
