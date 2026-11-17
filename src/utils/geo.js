'use strict';
// Distance between two map points, and the check-in location label.

/** Great-circle distance in metres (haversine). */
function distanceM(a, b) {
  const R = 6_371_000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** A position the phone sent, or null when it is missing or makes no sense. */
function cleanPosition(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lng = Number(p.lng);
  const accuracy = Number(p.accuracy);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng, accuracy: Number.isFinite(accuracy) && accuracy > 0 ? Math.round(accuracy) : null };
}

// A phone that is unsure by more than this is treated as "location not shared".
const MAX_ACCURACY_M = 1000;
// How much of the phone's own uncertainty is forgiven on top of the building's radius.
const ACCURACY_ALLOWANCE_M = 100;

/**
 * Labels a check-in: near (at the building), far (with distance), unknown (no usable position)
 * or unchecked (the building has no map position yet). Never decides whether check-in works.
 */
function label(building, position) {
  const pos = cleanPosition(position);
  if (!pos || (pos.accuracy && pos.accuracy > MAX_ACCURACY_M)) return { state: 'unknown', distance: null, accuracy: pos?.accuracy ?? null };
  if (building.latitude == null || building.longitude == null) return { state: 'unchecked', distance: null, accuracy: pos.accuracy };
  const distance = distanceM(pos, { lat: building.latitude, lng: building.longitude });
  const allowed = building.radius_m + Math.min(pos.accuracy ?? 0, ACCURACY_ALLOWANCE_M);
  return { state: distance <= allowed ? 'near' : 'far', distance, accuracy: pos.accuracy };
}

// A building has its own point when the office set one; the campus-wide area (radius ≥ 2 km) is
// only the campus centre, so for those Google Maps is asked to find the building by name.
const PRECISE_RADIUS_M = 2000;

/**
 * Google Maps walking directions from wherever the person is to a building. Opens the Maps app on
 * phones. Needs no API key.
 */
function directionsUrl({ name, latitude, longitude, radius_m: radius }) {
  const params = new URLSearchParams({ api: '1', travelmode: 'walking' });
  const precise = latitude != null && longitude != null && radius < PRECISE_RADIUS_M;
  params.set('destination', precise ? `${latitude},${longitude}` : `${name}, University of Cape Coast, Ghana`);
  return `https://www.google.com/maps/dir/?${params}`;
}

module.exports = { distanceM, cleanPosition, label, directionsUrl, MAX_ACCURACY_M };
