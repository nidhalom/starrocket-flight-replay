# Data format

Flight Replay imports a CSV (or JSON) of altimeter / flight-computer samples. Only **time** and
**altitude** are required; everything else is optional.

## CSV rules

- Delimiter is detected automatically: comma, semicolon, tab or whitespace.
- Lines starting with `#` or `//` are comments and are ignored. A UTF-8 BOM is stripped.
- A header row is detected when the first row contains non-numeric cells. Without a header the
  first two numeric columns are taken as time and altitude.
- Decimal commas (`12,5`) are accepted in non-comma-delimited files.
- Rows with a non-numeric time or altitude are skipped (the count is reported). Duplicate or
  out-of-order timestamps are dropped. At least 5 valid rows are needed.
- Time may start anywhere (for example milliseconds since boot); it is re-zeroed to the first sample.

## Column detection

Headers are matched case-insensitively, ignoring punctuation. You can always override the guess in
the *Data* tab.

| Quantity | Required | Header patterns recognised (examples) |
|---|---|---|
| Time | yes | `time`, `flight_time`, `t`, `timestamp`, `millis`, `elapsed`, `seconds`, `time_ms`, `Time (s)` |
| Altitude | yes | `altitude`, `alt`, `baro_alt`, `height`, `agl`, `altitude_ft`, `Altitude (m)` (barometric preferred over a `gps_alt` column) |
| Vertical velocity | no | `velocity`, `vel`, `vspeed`, `vertical_speed`, `speed` |
| Acceleration | no | `accel`, `acc`, `acceleration`, `az`, `accel_g` |
| Latitude / longitude | no | `lat`, `latitude`, `lon`, `lng`, `long`, `longitude` (decimal degrees) |
| Events | no | `event`, `events`, `state`, `phase`, `flight_state`, `status`, `stage` (text) |

## Units

The unit of each column is guessed from the header (`ft`, `feet`, `ms`, `millis`, `g`, `km/h`, ...).
Without a hint, a time column whose median step is 5 or more is assumed to be milliseconds. The unit
selectors in the *Data* tab override the guess.

| Quantity | Supported units |
|---|---|
| Time | `s`, `ms`, `min` |
| Altitude | `m`, `ft`, `km` |
| Velocity | `m/s`, `ft/s`, `km/h`, `mph` |
| Acceleration | `m/s2`, `ft/s2`, `g` |

Acceleration is displayed as reported (for an accelerometer that includes gravity, that means about
1 g at rest). It is not corrected for sensor orientation.

## Processing

1. **Zero altitude at pad**: the pad baseline (median of the first 10 samples when they are flat,
   otherwise the first sample) is subtracted. Switch off if the file is already AGL.
2. **Smoothing**: centred moving average (window in samples, 1 = off) applied to altitude, and to
   velocity / acceleration when they come from the file.
3. **Derived values**: if there is no velocity column it is derived from altitude by central
   differences over a window of at least about 0.5 s; acceleration is derived from velocity if absent.
4. **Trim**: keeps liftoff minus 1 s to landing plus 2 s (optional).

## Event detection

Run on a roughly 0.8 s smoothed view of the data so sensor noise is not mistaken for events.
Events given in an `event`/`state` column override detected ones of the same name.

| Event | Rule |
|---|---|
| Liftoff | altitude first rises more than max(3 m, 0.5 % of apogee) above the pad baseline |
| Burnout | peak vertical velocity between liftoff and apogee |
| Apogee | maximum altitude |
| Drogue / Main deploy | after apogee, the descent speed drops by more than max(3 m/s, 30 %) within 2 s while falling faster than 5 m/s, ignoring the last 15 m (or 2 % of apogee) of the descent. Two such drops: drogue then main. One drop: main if it happens below half the apogee altitude, otherwise drogue. A drogue that deploys at apogee leaves no speed drop and is not detected unless the file labels it. |
| Landing | altitude returns within max(1.5 m, 0.3 % of apogee) of the baseline after apogee |

Labels in an event column are mapped by keyword: `drogue`, `main`, `apogee`/`peak`, `burnout`/`coast`,
`launch`/`liftoff`/`boost`, `land`/`touchdown`. Other labels are kept as custom markers; `pad`, `idle`,
`ready`, `armed` are ignored. These are heuristics: check the detected events against your data.

## Position

- **With lat/lon** (decimal degrees, at least 3 valid fixes): positions are projected to local east/north
  metres relative to the first fix with an equirectangular approximation. Rows without a fix should be
  left blank; the last valid fix is held.
- **Without lat/lon**: the path is vertical plus a **wind-drift estimate** from the wind speed and
  direction you enter (horizontal speed = 5 % of the wind during boost/coast, 30 % between apogee and the
  first chute, 100 % under canopy, 0 after landing). It is an illustration, not a measurement.

## JSON

- An array of sample objects: `[{"time": 0, "altitude": 0}, ...]` (the same column detection applies to the keys).
- An object of column arrays: `{"time": [...], "altitude": [...], "lat": [...]}`.
- `{"samples": [...]}` or `{"data": [...]}` wrapping either of the above.
- A `.starrocket.json` file exported by the app (below).

## `.starrocket.json`

Exported from the *Flights* tab. One flight is a single object; several flights are wrapped as
`{"format": "starrocket-flights", "version": 1, "flights": [...]}`.

```json
{
  "format": "starrocket-flight",
  "version": 1,
  "name": "...",
  "kind": "sim | data",
  "orient": "euler | velocity",
  "savedAt": "ISO timestamp",
  "meta": { "source": "...", "units": {}, "hasGps": false, "warnings": [] },
  "events": [{ "name": "apogee", "t": 12.8, "source": "detected" }],
  "series": { "t": [], "alt": [], "vAlt": [], "acc": [], "x": [], "y": [], "vx": [], "vy": [], "pitch": [], "roll": [], "yaw": [] }
}
```

All series are SI (seconds, metres, m/s, m/s2) and must have equal length with strictly increasing `t`.
Files with another `format` or a newer `version` are rejected with a message.
