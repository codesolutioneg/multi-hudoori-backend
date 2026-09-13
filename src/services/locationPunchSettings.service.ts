/**
 * Helpers for Location GPS punch fields (HR settings).
 */

export type LocationPunchPatch = {
  locationPunchEnabled?: boolean;
  latitude?: number | null;
  longitude?: number | null;
  geofenceRadiusMeters?: number;
};

export function parseOptionalFloat(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function parseLocationPunchFields(params: Record<string, unknown>): {
  patch: LocationPunchPatch;
  error?: string;
} {
  const patch: LocationPunchPatch = {};

  if (params.locationPunchEnabled !== undefined) {
    patch.locationPunchEnabled =
      params.locationPunchEnabled === true || params.locationPunchEnabled === 'true';
  }

  if (params.latitude !== undefined) {
    const lat = parseOptionalFloat(params.latitude);
    if (params.latitude !== null && params.latitude !== '' && lat === null) {
      return { patch, error: 'خط عرض غير صالح' };
    }
    if (lat != null && (lat < -90 || lat > 90)) {
      return { patch, error: 'خط العرض يجب أن يكون بين -90 و 90' };
    }
    patch.latitude = lat ?? null;
  }

  if (params.longitude !== undefined) {
    const lng = parseOptionalFloat(params.longitude);
    if (params.longitude !== null && params.longitude !== '' && lng === null) {
      return { patch, error: 'خط طول غير صالح' };
    }
    if (lng != null && (lng < -180 || lng > 180)) {
      return { patch, error: 'خط الطول يجب أن يكون بين -180 و 180' };
    }
    patch.longitude = lng ?? null;
  }

  if (params.geofenceRadiusMeters !== undefined) {
    const r = Number(params.geofenceRadiusMeters);
    if (!Number.isFinite(r) || r <= 0) {
      return { patch, error: 'نصف القطر يجب أن يكون أكبر من صفر' };
    }
    patch.geofenceRadiusMeters = Math.round(r);
  }

  return { patch };
}

/** When enabling location punch, lat/long must be present (from patch or existing row). */
export function assertLocationPunchReady(opts: {
  enabled: boolean;
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  radius: number;
}): string | null {
  if (!opts.enabled) return null;
  if (opts.latitude == null || opts.longitude == null) {
    return 'تفعيل بصمة الموقع يتطلب خط العرض وخط الطول';
  }
  if (!Number.isFinite(opts.radius) || opts.radius <= 0) {
    return 'نصف القطر يجب أن يكون أكبر من صفر';
  }
  return null;
}
