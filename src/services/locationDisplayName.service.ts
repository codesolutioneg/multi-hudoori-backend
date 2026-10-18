/**
 * Resolve a short place label for a GPS punch:
 * 1) Snap to nearest company Location within its geofence
 * 2) Else Nominatim reverse geocode (best-effort, short timeout)
 * 3) Else lat,lng fallback
 */
import { prisma } from '../prisma/client';
import { distanceMeters } from './mobileLocationPunch.service';

const cache = new Map<string, { label: string; at: number }>();
const CACHE_TTL_MS = 24 * 3600_000;

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export async function resolveLocationDisplayName(opts: {
  companyId: string;
  latitude: number;
  longitude: number;
  homeBranchName?: string | null;
}): Promise<string> {
  const locations = await prisma.location.findMany({
    where: {
      companyId: opts.companyId,
      latitude: { not: null },
      longitude: { not: null },
    },
    select: {
      name: true,
      latitude: true,
      longitude: true,
      geofenceRadiusMeters: true,
    },
  });

  let best: { name: string; dist: number } | null = null;
  for (const loc of locations) {
    if (loc.latitude == null || loc.longitude == null) continue;
    const dist = distanceMeters(
      opts.latitude,
      opts.longitude,
      loc.latitude,
      loc.longitude,
    );
    const radius = loc.geofenceRadiusMeters ?? 200;
    if (dist <= radius && (!best || dist < best.dist)) {
      best = { name: loc.name, dist };
    }
  }
  if (best) return best.name;

  const key = cacheKey(opts.latitude, opts.longitude);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.label;

  const geocoded = await reverseGeocodeNominatim(opts.latitude, opts.longitude);
  if (geocoded) {
    cache.set(key, { label: geocoded, at: Date.now() });
    return geocoded;
  }

  const fallback =
    opts.homeBranchName?.trim() ||
    `${opts.latitude.toFixed(5)}, ${opts.longitude.toFixed(5)}`;
  return fallback;
}

async function reverseGeocodeNominatim(
  lat: number,
  lng: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(lat))}` +
      `&lon=${encodeURIComponent(String(lng))}&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HudooriMulti/1.0 (field-mission display)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      display_name?: string;
      name?: string;
      address?: Record<string, string>;
    };
    const addr = data.address ?? {};
    const short = [
      addr.road || addr.neighbourhood || addr.suburb || addr.village,
      addr.city || addr.town || addr.state_district || addr.state,
    ]
      .filter(Boolean)
      .join('، ');
    if (short.trim()) return short.trim();
    if (data.name?.trim()) return data.name.trim();
    if (data.display_name?.trim()) {
      return data.display_name.split(',').slice(0, 2).join('، ').trim();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
