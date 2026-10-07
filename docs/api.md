# SailorGuard server API (v1)

This is the contract between the SailorGuard / 6Pack app and a boat server. It is
implemented by this plugin on a stock Signal K server. The ESP32 firmware
implements the older subset noted below.

## 1. Alarm configuration: `navigation.anchor.akat`

One object holds the configuration for all three alarms:

```json
{
  "anchor": { "enabled": true, "radius": 40, "lat": 37.9, "lon": 23.7, "ts": 1696690000000 },
  "depth":  { "alarm": true,  "min_depth": 3.0 },
  "wind":   { "alarm": false, "max_speed": 25.0 }
}
```

| Field | Unit | Notes |
|---|---|---|
| `anchor.radius` | metres | 1 to 10000 |
| `anchor.lat`, `anchor.lon` | degrees | |
| `anchor.ts` | epoch ms | ISO strings are accepted and converted |
| `anchor.enabled` | | Forced to `false` while there is no anchor position |
| `depth.min_depth` | metres | Compared with the configured depth path |
| `wind.max_speed` | knots | Apparent wind by default |

### Writing the configuration

Use any of these. All fields are optional, and a write only changes the fields it contains.

- **Delta** over the WebSocket on `navigation.anchor.akat`. This is what the app does today.
- **Leaf deltas**, for example `navigation.anchor.akat.anchor.lat`, `...anchor.enabled` or `...depth.min_depth`.
- **PUT** `/signalk/v1/api/vessels/self/navigation/anchor/akat` with body `{"value": {...}}`.

Accepted aliases:
- `radius`, `radiusMeters` (top level)
- `anchor.latitude`, `anchor.longitude`
- `depthConfig`, `minDepth`, `depth.enabled`
- `windConfig`, `maxSpeed`, `wind.enabled`

After each write the plugin republishes the full canonical object on
`navigation.anchor.akat`, with source `signalk-sailorguard`. The leaf writes are
consumed and are not stored as separate paths. The configuration is kept in the
plugin data directory and survives restarts.

Reading the configuration: `GET /signalk/v1/api/vessels/self/navigation/anchor/akat`.

The plugin also publishes the standard anchor paths. Turn this off with the
`publishAnchorPaths` option.
- `navigation.anchor.position` = `{latitude, longitude}`, or `null` when the anchor alarm is off
- `navigation.anchor.maxRadius` (m)
- `navigation.anchor.currentRadius` (m): the boat's current distance from the anchor

## 2. Notifications

| Alarm | Path | Push `data.type` | Android channel |
|---|---|---|---|
| Geofence breach | `notifications.geofence.exit` | `geofence-alarm` | `geofence-alarms` |
| GPS lost while anchored | `notifications.geofence.positionLost` | `position-lost` | `geofence-alarms` |
| Depth below limit | `notifications.depth.alarm` | `depth-alarm` | `depth-alarms` |
| Wind above limit | `notifications.wind.alarm` | `wind-alarm` | `wind-alarms` |

The notification value is `{ "state": "alarm" | "normal", "method": ["visual","sound"] | [], "message": "..." }`.

## 3. Push messages

Push notifications are sent through the SailorGuard push gateway. Its API is
documented in the `sailorguard-push` repo, in `docs/api.md`.

For each alarm, the plugin sends `POST https://push.sailorguard.com/v1/notify`,
authenticated with its own installation credential:

```json
{ "handles": ["sgh_…"], "type": "geofence", "state": "alarm", "vessel": "Thalassa",
  "data": { "distance": 72, "radius": 40, "bearing": 15 } }
```

| `type` | `data` |
|---|---|
| `geofence` | `distance`, `radius`, `bearing` |
| `position` | `secondsWithoutFix` |
| `depth` | `depth`, `threshold` |
| `wind` | `wind`, `threshold`, `source` |
| `test` | none |

`state` is `normal` for the "cleared" push. The gateway renders the title and body,
and handles the sounds and the Android channels.

When the gateway answers `invalid` or `unknown` for a handle, the plugin forgets that phone.

## 4. REST endpoints

All endpoints are under `/plugins/signalk-sailorguard`. Permissions apply only when Signal K security is enabled.

| Method and path | Permission | Purpose |
|---|---|---|
| `GET /api/info` | readonly | Capability discovery, including `push.gateway.installationId` |
| `GET /api/status` | readonly | Config, per-alarm state, last samples |
| `POST /api/push/register` | readwrite | Register a phone's gateway handle (see below) |
| `POST /api/push/unregister` | readwrite | `{handle}` or `{installationId}` |
| `POST /api/push/test` | readwrite | Send a test push to all phones, or to `{handle}` |
| `GET /api/push/devices` | admin | List phones (handles masked) |
| `DELETE /api/push/devices` | admin | Forget all devices |

On Signal K servers older than 2.x (without `router.access`), every endpoint requires admin while security is on.

### Registering a device

The app needs a gateway handle first:

1. Read `GET /plugins/signalk-sailorguard/api/info` and take `push.gateway.installationId` (`sgi_…`).
2. Call `POST https://push.sailorguard.com/v1/handles` with
   `{installationId, pushToken, platform, appInstallationId, appVersion, locale}`.
   The response is `{handle: "sgh_…"}`.
3. Send `POST /plugins/signalk-sailorguard/api/push/register` with this body:

```json
{
  "handle": "sgh_…",
  "installationId": "app-installation-uuid",
  "platform": "ios",
  "appVersion": "1.0.9",
  "deviceName": "Angelos' iPhone",
  "alarms": ["geofence", "position", "depth", "wind"]
}
```

- Only `handle` is required.
- Raw push tokens are rejected with `400`.
- `installationId` identifies the phone: a new handle from the same phone replaces
  the old one, and the old one is also withdrawn from the gateway.
- `alarms` limits which alarm types the phone receives. If it is omitted, the phone
  receives all of them.

The response is:

```json
{ "ok": true, "added": true, "totalDevices": 2 }
```

The app should register again on every connect. Phones that do not re-register
within `pruneAfterDays` (default 60) are forgotten.

`/api/info` also reports the gateway state (`ready`, `unregistered`, `unverified`
or `revoked`). While the state is anything other than `ready`, the app cannot get a handle.

## 5. Differences from the ESP32 firmware

| | Firmware | Plugin |
|---|---|---|
| Register path | `/plugins/signalk-node-red/redApi/register-expo-token` with a raw token | `/plugins/signalk-sailorguard/api/push/register` with a gateway handle |
| Discovery | none | `GET /api/info` |
| Wind source | apparent | apparent (configurable) |
| Push transport | Open HTTP relay (`pushit.digitalspot.gr`) | Authenticated HTTPS gateway (`push.sailorguard.com`); no secrets on the boat |
| Push cooldown | 10 s shared by all alarms; pushes inside it are dropped | per alarm; pushes inside it are queued |
| `anchor.ts` | dropped | kept |
| GPS-lost alarm | no | yes |

## 6. App registration order

`src/services/nodeRedService.ts` in the app:

1. `GET /plugins/signalk-sailorguard/api/info`. If the response is 2xx and contains a gateway
   `installationId`, get a handle from the gateway and register it with
   `POST /plugins/signalk-sailorguard/api/push/register`.
2. Otherwise (`401`, `403`, `404`, `405` or `501`): fall back to the legacy
   `POST /plugins/signalk-node-red/redApi/register-expo-token`, sending `{token}` only.
   This is the ESP32 firmware or Node-RED endpoint.
