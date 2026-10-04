/**
 * Core data model for the trip query library.
 *
 * All times are absolute integer minutes. Day boundaries are irrelevant:
 * 23:50 is 1430, 00:30 the next day is 1470, so trips crossing midnight
 * need no special handling as long as stop times are non-decreasing.
 */

export interface StopTime {
  station: string;
  /** Absolute minutes when the trip arrives at the station. */
  arrival: number;
  /** Absolute minutes when the trip leaves the station (>= arrival). */
  departure: number;
}

export interface Trip {
  id: string;
  /** Ordered stops; arrival/departure minutes are non-decreasing along the trip. */
  stops: StopTime[];
}

export interface Network {
  readonly trips: readonly Trip[];
  /** Minimum in-station transfer time in minutes (stations absent default to 0). */
  readonly minTransfer: ReadonlyMap<string, number>;
  /** Ids of cancelled trips; cancelled trips are invisible to queries. */
  readonly cancelled: ReadonlySet<string>;
}

export interface Leg {
  tripId: string;
  from: string;
  to: string;
  depart: number;
  arrive: number;
}

export interface Itinerary {
  legs: Leg[];
  /** Absolute arrival minutes at the destination. */
  arrival: number;
  /** Number of transfers, i.e. legs.length - 1. */
  transfers: number;
}

export interface NetworkSpec {
  trips: Trip[];
  minTransfer?: Record<string, number>;
}

function assertIntegerMinutes(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${what} must be a non-negative integer number of minutes, got ${value}`);
  }
}

export function validateTrip(trip: Trip): void {
  if (trip.id.length === 0) throw new Error("trip id must not be empty");
  if (trip.stops.length < 2) throw new Error(`trip ${trip.id} needs at least 2 stops`);
  let previousDeparture = -1;
  for (const stop of trip.stops) {
    assertIntegerMinutes(stop.arrival, `trip ${trip.id} arrival at ${stop.station}`);
    assertIntegerMinutes(stop.departure, `trip ${trip.id} departure at ${stop.station}`);
    if (stop.departure < stop.arrival) {
      throw new Error(`trip ${trip.id} departs ${stop.station} before it arrives`);
    }
    if (stop.arrival < previousDeparture) {
      throw new Error(`trip ${trip.id} stop times must be non-decreasing`);
    }
    previousDeparture = stop.departure;
  }
}

export function createNetwork(spec: NetworkSpec): Network {
  const seen = new Set<string>();
  for (const trip of spec.trips) {
    validateTrip(trip);
    if (seen.has(trip.id)) throw new Error(`duplicate trip id ${trip.id}`);
    seen.add(trip.id);
  }
  const minTransfer = new Map<string, number>();
  for (const [station, minutes] of Object.entries(spec.minTransfer ?? {})) {
    assertIntegerMinutes(minutes, `min transfer at ${station}`);
    minTransfer.set(station, minutes);
  }
  return { trips: spec.trips, minTransfer, cancelled: new Set() };
}

/** Minimum minutes needed to change trips at a station (0 when unspecified). */
export function minTransferAt(network: Network, station: string): number {
  return network.minTransfer.get(station) ?? 0;
}

/** Returns a new network with the given trip cancelled. */
export function cancelTrip(network: Network, tripId: string): Network {
  if (!network.trips.some((t) => t.id === tripId)) {
    throw new Error(`unknown trip id ${tripId}`);
  }
  const cancelled = new Set(network.cancelled);
  cancelled.add(tripId);
  return { ...network, cancelled };
}

/** Returns a new network with the given trip reinstated. */
export function restoreTrip(network: Network, tripId: string): Network {
  const cancelled = new Set(network.cancelled);
  cancelled.delete(tripId);
  return { ...network, cancelled };
}

/** Trips that are not cancelled. */
export function activeTrips(network: Network): Trip[] {
  return network.trips.filter((t) => !network.cancelled.has(t.id));
}
