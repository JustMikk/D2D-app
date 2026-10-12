// Automatic dusk theme (PRD REP-12): "dusk after local sunset". The sunrise equation with the solar position
// from NOAA's low-precision formulas, good to a couple of minutes, which is plenty for choosing a theme.
// Pure and framework-free, so it runs anywhere and tests are exact.

const J1970 = 2440587.5;
const J2000 = 2451545.0;
const DAY_MS = 86_400_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export type SunEvents = { sunrise: Date | null; sunset: Date | null; transit: Date; /** The sun never sets ("day") or never rises ("night") on this day. */ polar: "day" | "night" | null };

/** Sunrise, solar noon and sunset for the solar day nearest `date`. lng is positive east. Null at the poles when the sun does not rise or set. */
export function sunEvents(date: Date, lat: number, lng: number): SunEvents {
  const jd = date.getTime() / DAY_MS + J1970;
  // The solar day whose noon is nearest this instant. (The textbook ceil() form rolls over at noon UTC and
  // would give tomorrow's noon for any afternoon time west of Greenwich.)
  const n = Math.round(jd - J2000 + lng / 360);
  const jStar = n - lng / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 0.0003 * Math.sin(rad(3 * M));
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(rad(M)) - 0.0069 * Math.sin(rad(2 * lambda));
  const sinDelta = Math.sin(rad(lambda)) * Math.sin(rad(23.4397));
  const cosDelta = Math.cos(Math.asin(sinDelta));
  const cosOmega = (Math.sin(rad(-0.833)) - Math.sin(rad(lat)) * sinDelta) / (Math.cos(rad(lat)) * cosDelta);
  const toDate = (j: number) => new Date((j - J1970) * DAY_MS);
  if (cosOmega < -1) return { sunrise: null, sunset: null, transit: toDate(transit), polar: "day" };
  if (cosOmega > 1) return { sunrise: null, sunset: null, transit: toDate(transit), polar: "night" };
  const omega = deg(Math.acos(cosOmega));
  return { sunrise: toDate(transit - omega / 360), sunset: toDate(transit + omega / 360), transit: toDate(transit), polar: null };
}

/**
 * True from sunset until the next sunrise. Looks at the days around `now` and finds the latest event that has
 * already happened, so it is right at any hour in any time zone. Polar day is never dusk; polar night always is.
 */
export function isDusk(now: Date, lat: number, lng: number): boolean {
  const events: { at: number; kind: "rise" | "set" }[] = [];
  let polar: SunEvents["polar"] = null;
  for (const offset of [-1, 0, 1]) {
    const e = sunEvents(new Date(now.getTime() + offset * DAY_MS), lat, lng);
    if (e.sunrise && e.sunset) events.push({ at: e.sunrise.getTime(), kind: "rise" }, { at: e.sunset.getTime(), kind: "set" });
    else polar = e.polar;
  }
  if (events.length === 0) return polar === "night";
  const past = events.filter((e) => e.at <= now.getTime()).sort((a, b) => b.at - a.at)[0];
  return past ? past.kind === "set" : false;
}
