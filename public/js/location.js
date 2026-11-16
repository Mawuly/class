// The phone's position for the location check at check-in. Never holds check-in up: if the person
// says no, the phone has no fix, or it takes too long, check-in goes ahead without it.
export function currentPosition({ timeout = 8000 } = {}) {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => done(null), timeout + 500);
    navigator.geolocation.getCurrentPosition(
      (p) => done({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => done(null),
      { enableHighAccuracy: true, timeout, maximumAge: 30_000 },
    );
  });
}

/** What to tell the person after check-in, when the location check flagged it. Empty when it didn't. */
export function locationNote(location) {
  if (!location) return '';
  if (location.state === 'unknown') {
    return 'Your location wasn’t shared, so the timetable office sees this check-in as unconfirmed.';
  }
  if (location.state === 'far') {
    const d = location.distance >= 1000 ? `${(location.distance / 1000).toFixed(1)} km` : `${location.distance} m`;
    return `Your phone seemed to be ${d} from the building, so the timetable office sees this check-in as away from the room.`;
  }
  return '';
}
