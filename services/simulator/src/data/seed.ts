import dotenv from 'dotenv';
dotenv.config();

import { db } from '../config/firebase';
import { ALL_SIM_ROUTES, ALL_SIM_STOPS } from './routeData';
import { Stop } from '@captain-campus/shared_types';
import { Route } from '@captain-campus/shared_types';
import { Bus } from '@captain-campus/shared_types';
import { Driver } from '@captain-campus/shared_types';
import { GpsDevice } from '@captain-campus/shared_types';
import { Trip } from '@captain-campus/shared_types';
import { Announcement } from '@captain-campus/shared_types';

const COLLECTIONS = [
  'buses',
  'stops',
  'routes',
  'trips',
  'drivers',
  'gpsDevices',
  'announcements',
] as const;

/**
 * Helper to delete all documents in a collection in batches
 */
async function clearCollection(collectionName: string): Promise<number> {
  const collectionRef = db.collection(collectionName);
  const snapshot = await collectionRef.get();
  if (snapshot.empty) return 0;

  let batch = db.batch();
  let count = 0;
  let deleted = 0;

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    count++;
    deleted++;

    if (count === 400) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }

  if (count > 0) {
    await batch.commit();
  }

  return deleted;
}

/**
 * Main seed function
 */
async function seed(): Promise<void> {
  const isClearOnly = process.argv.includes('--clear');
  const now = new Date().toISOString();

  console.log('===========================================================');
  console.log('  Captain Campus Database Seeder');
  console.log(`  Target Project: ${process.env.FIREBASE_PROJECT_ID || 'captain-campus-dev'}`);
  console.log(`  Mode: ${isClearOnly ? 'CLEAR ONLY' : 'SEED (with reset)'}`);
  console.log('===========================================================\n');

  // Step 1: Clear existing collections
  console.log('Clearing existing collections...');
  for (const coll of COLLECTIONS) {
    const deletedCount = await clearCollection(coll);
    console.log(`  - Cleaned [${coll}]: ${deletedCount} document(s) deleted.`);
  }

  if (isClearOnly) {
    console.log('\n[SUCCESS] Collections cleared successfully. Exiting (--clear flag specified).');
    process.exit(0);
  }

  console.log('\nBeginning database seed...');

  let batch = db.batch();
  let operationCount = 0;

  const commitIfBatchFull = async () => {
    operationCount++;
    if (operationCount >= 400) {
      await batch.commit();
      batch = db.batch();
      operationCount = 0;
    }
  };

  // 1. Seed Stops
  console.log(`Seeding ${ALL_SIM_STOPS.length} stops...`);
  const seededStops: Stop[] = ALL_SIM_STOPS.map((simStop) => ({
    stopId: simStop.stopId,
    name: simStop.name,
    latitude: simStop.latitude,
    longitude: simStop.longitude,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }));

  for (const stop of seededStops) {
    const ref = db.collection('stops').doc(stop.stopId);
    batch.set(ref, stop);
    await commitIfBatchFull();
  }

  // 2. Seed Routes
  console.log(`Seeding ${ALL_SIM_ROUTES.length} routes...`);
  const seededRoutes: Route[] = ALL_SIM_ROUTES.map((simRoute) => ({
    routeId: simRoute.routeId,
    routeCode: simRoute.routeCode,
    routeName: simRoute.routeName,
    direction: simRoute.direction,
    originStopId: simRoute.stops[0].stopId,
    destinationStopId: simRoute.stops[simRoute.stops.length - 1].stopId,
    stopSequence: simRoute.stops.map((stop, idx) => ({
      stopId: stop.stopId,
      sequence: idx + 1,
      scheduledOffset: idx * 3, // ~3 min per stop
      isPickup: true,
      isDropoff: true,
    })),
    operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
    firstDeparture: '07:30',
    lastDeparture: '21:30',
    estimatedDuration: simRoute.estimatedDuration,
    color: simRoute.color,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }));

  for (const route of seededRoutes) {
    const ref = db.collection('routes').doc(route.routeId);
    batch.set(ref, route);
    await commitIfBatchFull();
  }

  // 3. Seed GPS Devices
  console.log('Seeding 4 GPS devices...');
  const seededGpsDevices: GpsDevice[] = [
    {
      deviceId: 'SIM-DEVICE-01',
      deviceType: 'simulator',
      assignedBusId: 'bus-cc-01',
      status: 'active',
      description: 'Simulator GPS unit for CC-01',
      createdAt: now,
      updatedAt: now,
    },
    {
      deviceId: 'SIM-DEVICE-02',
      deviceType: 'simulator',
      assignedBusId: 'bus-cc-02',
      status: 'active',
      description: 'Simulator GPS unit for CC-02',
      createdAt: now,
      updatedAt: now,
    },
    {
      deviceId: 'SIM-DEVICE-03',
      deviceType: 'simulator',
      assignedBusId: 'bus-cc-03',
      status: 'active',
      description: 'Simulator GPS unit for CC-03',
      createdAt: now,
      updatedAt: now,
    },
    {
      deviceId: 'SIM-DEVICE-04',
      deviceType: 'simulator',
      assignedBusId: 'bus-cc-04',
      status: 'active',
      description: 'Simulator GPS unit for CC-04',
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const dev of seededGpsDevices) {
    const ref = db.collection('gpsDevices').doc(dev.deviceId);
    batch.set(ref, dev);
    await commitIfBatchFull();
  }

  // 4. Seed Drivers
  console.log('Seeding 3 drivers...');
  const seededDrivers: Driver[] = [
    {
      driverId: 'driver-001',
      name: 'Rajesh Kumar',
      phone: '9876543210',
      licenceNumber: 'DL-1234567890',
      licenceExpiry: '2027-01-01',
      status: 'active',
      currentBusId: 'bus-cc-01',
      currentTripId: 'trip-001',
      createdAt: now,
      updatedAt: now,
    },
    {
      driverId: 'driver-002',
      name: 'Suresh Patel',
      phone: '9876543211',
      licenceNumber: 'DL-0987654321',
      licenceExpiry: '2026-06-01',
      status: 'active',
      currentBusId: 'bus-cc-02',
      createdAt: now,
      updatedAt: now,
    },
    {
      driverId: 'driver-003',
      name: 'Mohan Das',
      phone: '9876543212',
      licenceNumber: 'DL-1122334455',
      licenceExpiry: '2028-03-15',
      status: 'active',
      currentBusId: 'bus-cc-03',
      currentTripId: 'trip-002',
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const driver of seededDrivers) {
    const ref = db.collection('drivers').doc(driver.driverId);
    batch.set(ref, driver);
    await commitIfBatchFull();
  }

  // 5. Seed Buses
  console.log('Seeding 4 buses...');
  const seededBuses: Bus[] = [
    {
      busId: 'bus-cc-01',
      busNumber: 'CC-01',
      registrationNumber: 'KA01AA0001',
      capacity: 45,
      driverId: 'driver-001',
      gpsDeviceId: 'SIM-DEVICE-01',
      currentRouteId: 'route-r1',
      currentTripId: 'trip-001',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      busId: 'bus-cc-02',
      busNumber: 'CC-02',
      registrationNumber: 'KA01AA0002',
      capacity: 45,
      driverId: 'driver-002',
      gpsDeviceId: 'SIM-DEVICE-02',
      currentRouteId: 'route-r1',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      busId: 'bus-cc-03',
      busNumber: 'CC-03',
      registrationNumber: 'KA01AA0003',
      capacity: 40,
      driverId: 'driver-003',
      gpsDeviceId: 'SIM-DEVICE-03',
      currentRouteId: 'route-r2',
      currentTripId: 'trip-002',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
    {
      busId: 'bus-cc-04',
      busNumber: 'CC-04',
      registrationNumber: 'KA01AA0004',
      capacity: 35,
      gpsDeviceId: 'SIM-DEVICE-04',
      currentRouteId: 'route-r3',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const bus of seededBuses) {
    const ref = db.collection('buses').doc(bus.busId);
    batch.set(ref, bus);
    await commitIfBatchFull();
  }

  // 6. Seed Active Trips
  console.log('Seeding 2 active trips...');
  const seededTrips: Trip[] = [
    {
      tripId: 'trip-001',
      busId: 'bus-cc-01',
      driverId: 'driver-001',
      routeId: 'route-r1',
      scheduledStart: now,
      actualStart: now,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    },
    {
      tripId: 'trip-002',
      busId: 'bus-cc-03',
      driverId: 'driver-003',
      routeId: 'route-r2',
      scheduledStart: now,
      actualStart: now,
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    },
  ];

  for (const trip of seededTrips) {
    const ref = db.collection('trips').doc(trip.tripId);
    batch.set(ref, trip);
    await commitIfBatchFull();
  }

  // 7. Seed Sample Announcement
  console.log('Seeding 1 sample announcement...');
  const sampleAnnouncement: Announcement = {
    announcementId: 'announcement-001',
    title: 'Route R3 Running Late Today',
    message: 'Express Route R3 is currently experiencing moderate campus traffic delays. Expect an additional 5-10 minute wait.',
    severity: 'warning',
    affectedRouteIds: ['route-r3'],
    createdBy: 'admin-seed',
    status: 'published',
    fcmSent: false,
    createdAt: now,
  };

  const announcementRef = db.collection('announcements').doc(sampleAnnouncement.announcementId);
  batch.set(announcementRef, sampleAnnouncement);
  await commitIfBatchFull();

  // Commit remaining writes
  if (operationCount > 0) {
    await batch.commit();
  }

  console.log('\n===========================================================');
  console.log('  Database Seeding Summary');
  console.log('===========================================================');
  console.table([
    { Collection: 'stops', Count: seededStops.length, Details: '20 deduplicated stops across campus' },
    { Collection: 'routes', Count: seededRoutes.length, Details: 'R1 (Inbound), R2 (Circular), R3 (Outbound)' },
    { Collection: 'buses', Count: seededBuses.length, Details: 'CC-01, CC-02, CC-03, CC-04' },
    { Collection: 'drivers', Count: seededDrivers.length, Details: 'Rajesh Kumar, Suresh Patel, Mohan Das' },
    { Collection: 'gpsDevices', Count: seededGpsDevices.length, Details: 'SIM-DEVICE-01 through SIM-DEVICE-04' },
    { Collection: 'trips', Count: seededTrips.length, Details: 'trip-001 (CC-01/R1), trip-002 (CC-03/R2)' },
    { Collection: 'announcements', Count: 1, Details: 'Route R3 Delay Warning' },
  ]);
  console.log('===========================================================');
  console.log('  Seed completed successfully!');
  console.log('===========================================================\n');
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error during database seeding:', err);
    process.exit(1);
  });
