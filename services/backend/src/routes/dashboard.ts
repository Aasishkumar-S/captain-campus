import { Router, Request, Response } from 'express';
import { db, rtdb } from '../config/firebase';
import { verifyFirebaseToken } from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { asyncHandler } from '../middleware/errorHandler';
import { successResponse } from '../utils/responseHelpers';
import {
  COLLECTIONS,
  RTDB_PATHS,
  GPS_STALE_THRESHOLD_MS,
  AuditLog,
  Announcement,
  Bus,
  Driver,
  Route,
  Trip,
  LiveLocation,
} from '@captain-campus/shared_types';

export interface DashboardStats {
  totalBuses: number;
  activeBuses: number;
  inactiveBuses: number;
  maintenanceBuses: number;
  totalDrivers: number;
  activeDrivers: number;
  totalRoutes: number;
  activeRoutes: number;
  activeTrips: number;
  scheduledTrips: number;
  delayedTrips: number;
  gpsDevicesTotal: number;
  gpsDevicesOnline: number;
  gpsDevicesStale: number;
  totalStops: number;
  recentAuditLogs: AuditLog[];
  recentAnnouncements: Announcement[];
  generatedAt: string;
}

const router = Router();

/**
 * GET /api/v1/admin/dashboard
 * Aggregates core system metrics for the administrative dashboard.
 */
router.get(
  '/',
  verifyFirebaseToken,
  requireAdmin,
  asyncHandler(async (req: Request, res: Response) => {
    const now = Date.now();

    // Fetch all collections and RTDB snapshot concurrently
    const [
      busesSnap,
      driversSnap,
      routesSnap,
      tripsSnap,
      gpsDevicesSnap,
      stopsSnap,
      rtdbLocationsSnap,
      auditLogsSnap,
      announcementsSnap,
    ] = await Promise.all([
      db.collection(COLLECTIONS.BUSES).get(),
      db.collection(COLLECTIONS.DRIVERS).get(),
      db.collection(COLLECTIONS.ROUTES).get(),
      db.collection(COLLECTIONS.TRIPS).get(),
      db.collection(COLLECTIONS.GPS_DEVICES).get(),
      db.collection(COLLECTIONS.STOPS).get(),
      rtdb.ref(RTDB_PATHS.LIVE_LOCATIONS).once('value').catch(() => null),
      db.collection(COLLECTIONS.AUDIT_LOGS).orderBy('timestamp', 'desc').limit(10).get(),
      db.collection(COLLECTIONS.ANNOUNCEMENTS).where('status', '==', 'published').limit(20).get(),
    ]);

    // Buses counts
    let totalBuses = 0;
    let activeBuses = 0;
    let inactiveBuses = 0;
    let maintenanceBuses = 0;

    busesSnap.forEach((doc) => {
      totalBuses++;
      const bus = doc.data() as Bus;
      if (bus.status === 'active') activeBuses++;
      else if (bus.status === 'maintenance') maintenanceBuses++;
      else inactiveBuses++;
    });

    // Drivers counts
    let totalDrivers = 0;
    let activeDrivers = 0;

    driversSnap.forEach((doc) => {
      totalDrivers++;
      const driver = doc.data() as Driver;
      if (driver.status === 'active') activeDrivers++;
    });

    // Routes counts
    let totalRoutes = 0;
    let activeRoutes = 0;

    routesSnap.forEach((doc) => {
      totalRoutes++;
      const route = doc.data() as Route;
      if (route.status === 'active') activeRoutes++;
    });

    // Trips counts
    let activeTrips = 0;
    let scheduledTrips = 0;
    let delayedTrips = 0;

    tripsSnap.forEach((doc) => {
      const trip = doc.data() as Trip;
      if (trip.status === 'in_progress') activeTrips++;
      else if (trip.status === 'scheduled') scheduledTrips++;
      else if (trip.status === 'delayed') delayedTrips++;
    });

    // Stops count
    const totalStops = stopsSnap.size;

    // GPS Devices
    const gpsDevicesTotal = gpsDevicesSnap.size;

    // RTDB live locations online vs stale
    let liveLocationsMap: Record<string, LiveLocation> = {};
    if (rtdbLocationsSnap && rtdbLocationsSnap.exists()) {
      liveLocationsMap = rtdbLocationsSnap.val() || {};
    }

    let gpsDevicesOnline = 0;
    let gpsDevicesStale = 0;

    Object.values(liveLocationsMap).forEach((loc) => {
      if (loc && loc.timestamp) {
        if (now - loc.timestamp <= GPS_STALE_THRESHOLD_MS) {
          gpsDevicesOnline++;
        } else {
          gpsDevicesStale++;
        }
      }
    });

    // Recent Audit Logs
    const recentAuditLogs: AuditLog[] = [];
    auditLogsSnap.forEach((doc) => {
      recentAuditLogs.push(doc.data() as AuditLog);
    });

    // Recent Announcements (sort createdAt desc, take 5)
    const announcementsList: Announcement[] = [];
    announcementsSnap.forEach((doc) => {
      announcementsList.push(doc.data() as Announcement);
    });
    announcementsList.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    const recentAnnouncements = announcementsList.slice(0, 5);

    const dashboardStats: DashboardStats = {
      totalBuses,
      activeBuses,
      inactiveBuses,
      maintenanceBuses,
      totalDrivers,
      activeDrivers,
      totalRoutes,
      activeRoutes,
      activeTrips,
      scheduledTrips,
      delayedTrips,
      gpsDevicesTotal,
      gpsDevicesOnline,
      gpsDevicesStale,
      totalStops,
      recentAuditLogs,
      recentAnnouncements,
      generatedAt: new Date().toISOString(),
    };

    res.json(successResponse(dashboardStats));
  })
);

export default router;
