// Straight-line (haversine) distance between two GPS points, in kilometers.
// Real riding distance is always somewhat longer than this (roads aren't
// straight lines), so the per-km rate below is tuned assuming that gap —
// same approach ride-hailing apps use before they have full road-routing.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Pricing knobs — all overridable via env vars so fees can be tuned without
// a code change/redeploy. Defaults are a reasonable starting point for
// Kampala-area boda delivery pricing; adjust once you have real cost data.
const BASE_FARE = Number(process.env.DELIVERY_BASE_FARE || 2000); // UGX, covers the first ~1km
const RATE_PER_KM = Number(process.env.DELIVERY_RATE_PER_KM || 700); // UGX per km beyond that
const MIN_FEE = Number(process.env.DELIVERY_MIN_FEE || 2000);
const MAX_FEE = Number(process.env.DELIVERY_MAX_FEE || 25000);
const FALLBACK_FEE = Number(process.env.DELIVERY_FALLBACK_FEE || 5000); // used when coordinates are missing

// Computes a delivery fee from origin/destination coordinates. Falls back to
// a flat fee if either point is missing — e.g. a seller who hasn't set their
// location yet, or a buyer whose browser/phone declined location access.
function computeDeliveryFee({ originLat, originLng, destLat, destLng }) {
  if (originLat == null || originLng == null || destLat == null || destLng == null) {
    return { fee: FALLBACK_FEE, distanceKm: null, estimated: false };
  }
  const distanceKm = haversineKm(Number(originLat), Number(originLng), Number(destLat), Number(destLng));
  const raw = BASE_FARE + distanceKm * RATE_PER_KM;
  const fee = Math.round(Math.min(MAX_FEE, Math.max(MIN_FEE, raw)));
  return { fee, distanceKm: Math.round(distanceKm * 100) / 100, estimated: true };
}

module.exports = { haversineKm, computeDeliveryFee };
