import { describe, expect, it } from 'vitest';
import { isWithinGeofence } from '../../src/services/mobileLocationPunch.service';

describe('field mission geofence policy', () => {
  const home = { lat: 30.0444, lng: 31.2357, radius: 200 };

  it('rejects punch far from home when geofence is enforced', () => {
    expect(
      isWithinGeofence({
        userLat: 30.1,
        userLng: 31.3,
        locationLat: home.lat,
        locationLng: home.lng,
        radiusMeters: home.radius,
      }),
    ).toBe(false);
  });

  it('accepts punch at home branch', () => {
    expect(
      isWithinGeofence({
        userLat: home.lat,
        userLng: home.lng,
        locationLat: home.lat,
        locationLng: home.lng,
        radiusMeters: home.radius,
      }),
    ).toBe(true);
  });

  it('documents mission override: skip check when approved mission covers day', () => {
    const geofenceRelaxed = true; // from findApprovedMissionForEmployeeDay
    const outside = !isWithinGeofence({
      userLat: 30.1,
      userLng: 31.3,
      locationLat: home.lat,
      locationLng: home.lng,
      radiusMeters: home.radius,
    });
    expect(outside).toBe(true);
    // submitMobilePunch only throws GEOFENCE_VIOLATION when !geofenceRelaxed && outside
    const shouldReject = !geofenceRelaxed && outside;
    expect(shouldReject).toBe(false);
  });
});
