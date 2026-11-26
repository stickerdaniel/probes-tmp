import { dlopen, FFIType, ptr } from "bun:ffi";

const temporal = globalThis.Temporal;
const formatters = new Map<string, Intl.DateTimeFormat>();
const zoneOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "longOffset",
};

function formatter(timeZone: string) {
  const existing = formatters.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-CA", { ...zoneOptions, timeZone });
  formatters.set(timeZone, created);
  return created;
}

function intl(timeZone: string, instant: number) {
  const fields = Object.fromEntries(
    formatter(timeZone).formatToParts(instant).map(({ type, value }) => [type, value])
  );
  return {
    wall: `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}`,
    offset: fields.timeZoneName.slice(3) || "+00:00",
  };
}

function zoned(timeZone: string, instant: string) {
  return {
    instant,
    intl: intl(timeZone, Date.parse(instant)),
    temporal: temporal ? temporalReading(temporal.Instant.from(instant).toZonedDateTimeISO(timeZone)) : null,
  };
}

function temporalReading(date: Temporal.ZonedDateTime) {
  return {
    wall: date.toPlainDateTime().toString({ smallestUnit: "second" }),
    offset: date.offset,
  };
}

function toUtc(instant: number) {
  return new Date(instant).toISOString().replace(".000Z", "Z");
}

const sundayRule = { weekdays: [0], start: "02:00:00", end: "03:00:00" };

function membership(timeZone: string, center: number) {
  const edges: { instant: string; local: ReturnType<typeof intl>; open: boolean }[] = [];
  const matches: Record<string, string[]> = { "01:30:00": [], "02:30:00": [] };
  let wasOpen = false;
  for (let instant = center - 2 * 3600000; instant <= center + 3 * 3600000; instant += 60000) {
    const local = intl(timeZone, instant);
    const date = local.wall.slice(0, 10);
    const time = local.wall.slice(11);
    if (time === "01:30:00" || time === "02:30:00") matches[time].push(toUtc(instant));
    const weekday = new Date(date).getUTCDay();
    const open = sundayRule.weekdays.includes(weekday) && time >= sundayRule.start && time < sundayRule.end;
    if (open !== wasOpen) edges.push({ instant: toUtc(instant), local, open });
    wasOpen = open;
  }
  return { matches, edges };
}

function errorOr<A>(measure: () => A) {
  try {
    return measure();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.name, message: error.message };
  }
}

function gap(timeZone: string, transition: string) {
  const center = Date.parse(transition);
  const before = zoned(timeZone, toUtc(center - 1000));
  const after = zoned(timeZone, transition);
  const wall = `${after.intl.wall.slice(0, 10)}T02:30:00`;
  const assumptions = [before.intl.offset, after.intl.offset].map((offset) => ({
    offset,
    observed: zoned(timeZone, toUtc(Date.parse(wall + offset))),
  }));
  return {
    timeZone,
    before,
    after,
    ...membership(timeZone, center),
    assumptions,
    temporalDisambiguation: temporal
      ? Object.fromEntries(
          (["compatible", "earlier", "later", "reject"] as const).map((disambiguation) => [
            disambiguation,
            errorOr(() => {
              const value = temporal.PlainDateTime.from(wall).toZonedDateTime(timeZone, { disambiguation });
              return { instant: value.toInstant().toString(), ...temporalReading(value) };
            }),
          ])
        )
      : null,
  };
}

function overlap(timeZone: string, transition: string) {
  const schedule = membership(timeZone, Date.parse(transition));
  return {
    timeZone,
    before: zoned(timeZone, toUtc(Date.parse(transition) - 1000)),
    after: zoned(timeZone, transition),
    matches: Object.fromEntries(
      Object.entries(schedule.matches).map(([time, instants]) => [
        time, instants.map((instant) => zoned(timeZone, instant)),
      ])
    ),
    edges: schedule.edges,
  };
}

function systemTzVersion() {
  if (process.platform !== "darwin") return null;
  return errorOr(() => {
    const status = new Int32Array(1);
    const lib = dlopen("/usr/lib/libicucore.A.dylib", {
      ucal_getTZDataVersion: { args: [FFIType.ptr], returns: FFIType.cstring },
    });
    try {
      const version = String(lib.symbols.ucal_getTZDataVersion(ptr(status)));
      return status[0] > 0 ? { status: status[0] } : version;
    } finally {
      lib.close();
    }
  });
}

const winter = "2027-01-15T12:00:00Z";
const summer = "2027-07-15T12:00:00Z";
const zones = ["Europe/Berlin", "America/New_York", "Asia/Taipei", "Australia/Lord_Howe", "America/Sao_Paulo"];
const aliases = ["Probe/Unknown", "US/Eastern", "Asia/Calcutta"];

const rows = {
  row1: zones.map((timeZone) => ({
    timeZone,
    readings: [zoned(timeZone, winter), zoned(timeZone, summer)],
  })),
  row2: [
    gap("Europe/Berlin", "2027-03-28T01:00:00Z"),
    gap("America/New_York", "2027-03-14T07:00:00Z"),
  ],
  row3: [
    overlap("Europe/Berlin", "2027-10-31T01:00:00Z"),
    overlap("America/New_York", "2027-11-07T06:00:00Z"),
  ],
  row4: aliases.map((timeZone) => ({
    timeZone,
    intl: errorOr(() => ({
      resolved: formatter(timeZone).resolvedOptions().timeZone,
      ...intl(timeZone, Date.parse(winter)),
    })),
    temporal: temporal ? errorOr(() => {
      const value = temporal.Instant.from(winter).toZonedDateTimeISO(timeZone);
      return { resolved: value.timeZoneId, ...temporalReading(value) };
    }) : null,
  })),
  row6: { zone: "America/Vancouver", ...zoned("America/Vancouver", winter) },
};
const requested = process.argv[2];
if (requested === "rows") {
  console.log(JSON.stringify(rows));
} else {
  console.log(JSON.stringify({
    bun: Bun.version,
    revision: Bun.revision,
    webkit: process.versions.webkit,
    icu: process.versions.icu ?? null,
    tz: process.versions.tz ?? null,
    systemIcuTz: systemTzVersion(),
    temporal: typeof temporal?.Instant === "function",
    environmentTZ: process.env.TZ ?? null,
    defaultZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localOffsetMinutes: new Date(winter).getTimezoneOffset(),
  }));
}
