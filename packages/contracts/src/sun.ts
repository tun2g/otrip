const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type SolarPosition = {
  /** Degrees above the horizon; negative when the sun is down. */
  elevation: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
};

/**
 * Low-precision solar position (NOAA's published approximation, good to about a
 * degree). Written out rather than pulled in: it is twenty lines of arithmetic,
 * and the scene's sun must land in the same place on the server and the client.
 */
export const solarPosition = (at: Date, latitude: number, longitude: number): SolarPosition => {
  const days = at.getTime() / 86400000 - 10957.5;

  const meanLongitude = (280.46 + 0.9856474 * days) * RAD;
  const meanAnomaly = (357.528 + 0.9856003 * days) * RAD;
  const eclipticLongitude = meanLongitude + (1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD;
  const obliquity = 23.439 * RAD;

  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));

  const siderealTime = (280.46061837 + 360.98564736629 * days) * RAD + longitude * RAD;
  const hourAngle = siderealTime - rightAscension;

  const lat = latitude * RAD;
  const elevation = Math.asin(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle)
  );
  const azimuth = Math.atan2(
    -Math.sin(hourAngle),
    Math.tan(declination) * Math.cos(lat) - Math.sin(lat) * Math.cos(hourAngle)
  );

  return { elevation: elevation * DEG, azimuth: (((azimuth * DEG) % 360) + 360) % 360 };
};
