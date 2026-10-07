'use strict'

// Plugin options shown in the Signal K admin UI (Server -> Plugin Config).
// The alarm thresholds themselves (radius, min depth, max wind) come from the
// app through `navigation.anchor.akat`; these options only tune behaviour.

const WIND_PATHS = {
  apparent: 'environment.wind.speedApparent',
  true: 'environment.wind.speedTrue'
}

const DEFAULTS = {
  publishAnchorPaths: true,
  push: {
    enabled: true,
    gatewayUrl: 'https://push.sailorguard.com',
    includeVesselName: true,
    pruneAfterDays: 60
  },
  geofence: {
    triggerMargin: 10,
    confirmFixes: 2,
    maxSpeedKnots: 30,
    positionTimeoutSeconds: 60,
    cooldownSeconds: 10,
    repeatSeconds: 30,
    pushOnClear: true
  },
  depth: {
    path: 'environment.depth.belowTransducer',
    hysteresis: 0.3,
    confirmSamples: 2,
    ignoreZero: true,
    cooldownSeconds: 10,
    repeatSeconds: 0,
    pushOnClear: false
  },
  wind: {
    source: 'apparent',
    averageSeconds: 0,
    hysteresis: 1,
    cooldownSeconds: 10,
    repeatSeconds: 0,
    pushOnClear: false
  }
}

const policyProps = (d) => ({
  cooldownSeconds: { type: 'number', title: 'Minimum seconds between pushes', default: d.cooldownSeconds, minimum: 0 },
  repeatSeconds: { type: 'number', title: 'Repeat push every N seconds while active (0 = once)', default: d.repeatSeconds, minimum: 0 },
  pushOnClear: { type: 'boolean', title: 'Send a push when the alarm clears', default: d.pushOnClear }
})

const schema = {
  type: 'object',
  properties: {
    push: {
      type: 'object',
      title: 'Push notifications',
      description: 'Alarms are delivered to the SailorGuard app through the SailorGuard push gateway. No Apple or Google credentials are needed on this server.',
      properties: {
        enabled: { type: 'boolean', title: 'Send push notifications to registered phones', default: DEFAULTS.push.enabled },
        includeVesselName: { type: 'boolean', title: 'Show the vessel name in notification titles', default: DEFAULTS.push.includeVesselName },
        pruneAfterDays: {
          type: 'number',
          title: 'Forget phones that have not connected for N days (0 = never)',
          default: DEFAULTS.push.pruneAfterDays,
          minimum: 0
        }
      }
    },
    geofence: {
      type: 'object',
      title: 'Anchor alarm (geofence)',
      properties: {
        triggerMargin: { type: 'number', title: 'Extra metres beyond the radius before alarming', default: DEFAULTS.geofence.triggerMargin, minimum: 0 },
        confirmFixes: { type: 'number', title: 'Consecutive GPS fixes outside before alarming', default: DEFAULTS.geofence.confirmFixes, minimum: 1 },
        maxSpeedKnots: { type: 'number', title: 'Reject GPS jumps faster than (kn)', default: DEFAULTS.geofence.maxSpeedKnots, minimum: 1 },
        positionTimeoutSeconds: { type: 'number', title: 'GPS lost alarm after N seconds without position (0 = off)', default: DEFAULTS.geofence.positionTimeoutSeconds, minimum: 0 },
        ...policyProps(DEFAULTS.geofence)
      }
    },
    depth: {
      type: 'object',
      title: 'Depth alarm',
      properties: {
        path: {
          type: 'string',
          title: 'Depth source',
          enum: ['environment.depth.belowTransducer', 'environment.depth.belowKeel', 'environment.depth.belowSurface'],
          default: DEFAULTS.depth.path
        },
        hysteresis: { type: 'number', title: 'Clear when depth rises this many metres above the limit', default: DEFAULTS.depth.hysteresis, minimum: 0 },
        confirmSamples: { type: 'number', title: 'Consecutive readings below the limit before alarming', default: DEFAULTS.depth.confirmSamples, minimum: 1 },
        ignoreZero: { type: 'boolean', title: 'Ignore 0 m readings (usually a lost bottom)', default: DEFAULTS.depth.ignoreZero },
        ...policyProps(DEFAULTS.depth)
      }
    },
    wind: {
      type: 'object',
      title: 'Wind alarm',
      properties: {
        source: {
          type: 'string',
          title: 'Wind speed source',
          enum: ['apparent', 'true'],
          enumNames: ['Apparent (same as the app)', 'True'],
          default: DEFAULTS.wind.source
        },
        averageSeconds: { type: 'number', title: 'Average wind over N seconds (0 = instant, alarms on gusts)', default: DEFAULTS.wind.averageSeconds, minimum: 0 },
        hysteresis: { type: 'number', title: 'Clear when wind drops this many knots below the limit', default: DEFAULTS.wind.hysteresis, minimum: 0 },
        ...policyProps(DEFAULTS.wind)
      }
    },
    publishAnchorPaths: {
      type: 'boolean',
      title: 'Also publish standard navigation.anchor.* paths (disable if signalk-anchoralarm-plugin is installed)',
      default: DEFAULTS.publishAnchorPaths
    }
  }
}

function merge(defaults, value) {
  if (Array.isArray(defaults) || typeof defaults !== 'object' || defaults === null) {
    return value === undefined || value === null || value === '' ? defaults : value
  }
  const out = {}
  const src = value && typeof value === 'object' ? value : {}
  for (const key of Object.keys(defaults)) out[key] = merge(defaults[key], src[key])
  return out
}

function withDefaults(options) {
  const merged = merge(DEFAULTS, options)
  if (!WIND_PATHS[merged.wind.source]) merged.wind.source = 'apparent'
  return merged
}

module.exports = { schema, withDefaults, DEFAULTS, WIND_PATHS }
