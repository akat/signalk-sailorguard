# signalk-sailorguard

A Signal K server plugin for the **SailorGuard** app. It watches the boat
**on the server**, around the clock, so the alarms work even when the phone is
asleep or out of range:

- **Anchor alarm (geofence).** Checks each GPS fix against the anchor position and
  radius. Single GPS glitches are filtered out, a breach must be confirmed by
  consecutive fixes, and there is hysteresis before the alarm clears.
- **GPS lost.** Raises an alarm when no position arrives while the anchor alarm is armed.
- **Depth alarm.** Configurable depth source, confirmation samples and hysteresis.
  Bogus 0 m readings are ignored.
- **Wind alarm.** Apparent or true wind, optional averaging, and hysteresis.
- **Push notifications** to iOS and Android, with an alarm sound. Each alarm type has
  its own cooldown, and pushes repeat while the alarm is active.
- **Standard Signal K notifications** (`notifications.*`) and anchor paths, so other
  apps (WilhelmSK, KIP, Freeboard) see the alarms too.

The thresholds are set from the app. The plugin stores them on the server
(`navigation.anchor.akat`), so the alarms keep running after a restart.

## Installation

From the Signal K admin UI: **Appstore → Available → signalk-sailorguard → Install**.
Then restart the server and enable the plugin under **Server → Plugin Config → SailorGuard**.

For development:

```sh
cd ~/.signalk
npm install /path/to/signalk-sailorguard
```

## Push delivery

Push notifications go through the **SailorGuard push gateway**
(`https://push.sailorguard.com`). This plugin contains no Apple or Google
credentials, and it never sees the phones' push tokens.

```
App ──push token──▶ Gateway ──handle──▶ App ──handle──▶ this plugin
                       ▲                                    │
                       └──── alarm type + numbers ──────────┘
                       ──▶ APNs (iOS) / Expo (Android)
```

1. **First start.** The plugin registers with the gateway and gets its own
   installation credential. The credential is kept in the plugin data directory
   (`gateway-credentials.json`).
2. **Phone registration.** The app reads the plugin's installation ID from
   `GET /plugins/signalk-sailorguard/api/info` and trades its push token with the
   gateway for a handle. That handle only works for this boat. The app then
   registers the handle with the plugin.
3. **Alarm.** When an alarm fires, the plugin sends the gateway the alarm type and
   numbers, for example `geofence, 72 m, radius 40 m`. The gateway writes the
   notification text (in English or Greek), adds the boat's name, and delivers it.

Phones that uninstalled the app are reported by the gateway, and the plugin then
forgets them. The boat needs outbound HTTPS access to `push.sailorguard.com`.

## Configuration

All settings are in the admin UI and have safe defaults. The main ones:

| Setting | Default |
|---|---|
| Geofence: extra margin beyond the radius / consecutive fixes needed | 10 m / 2 |
| Geofence: repeat push while active | every 30 s |
| GPS-lost timeout | 60 s |
| Depth source / hysteresis / confirmation samples | `belowTransducer` / 0.3 m / 2 |
| Wind source / hysteresis | apparent / 1 kn |
| Forget devices not seen for | 60 days |

Turn off **Also publish standard navigation.anchor.\* paths** if
`signalk-anchoralarm-plugin` is also installed, so the two do not overwrite each other.

## Security

If Signal K security is enabled:
- The app's device token needs at least **readwrite** to register for push and to change the alarm configuration.
- Device lists and resets are admin-only.

## API

See [docs/api.md](docs/api.md).

## Development

```sh
npm test   # unit tests (node:test, no dependencies)
```

The plugin has no runtime dependencies and needs Node ≥ 18.
