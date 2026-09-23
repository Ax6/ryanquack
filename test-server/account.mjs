/**
 * A made-up Ryanair account in the shape `/orders/v2/orders/{cid}/details` and
 * `/v1/boardingpasses` answer with. Values are invented; dates are relative to
 * now so the check-in windows mean something.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const AIRPORTS = [
  ["STN", "London Stansted"], ["DUB", "Dublin"], ["BGY", "Milan Bergamo"], ["KRK", "Krakow"],
  ["WMI", "Warsaw Modlin"], ["BCN", "Barcelona"], ["MAD", "Madrid"], ["PMI", "Palma"],
  ["ALC", "Alicante"], ["FAO", "Faro"], ["OPO", "Porto"], ["CIA", "Rome Ciampino"],
];
const FIRST_NAMES = ["Alex", "Sam", "Maria", "Luca", "Emma", "Noah", "Sofia", "Leo", "Clara", "Hugo"];
const LAST_NAMES = ["Smith", "Rossi", "Garcia", "Murphy", "Novak", "Silva", "Martin", "Weber"];

/** Deterministic, so two refreshes see the same account. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function iso(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function pnrAt(index) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let n = index * 7919 + 12345;
  let out = "";
  for (let i = 0; i < 6; i++) { out = alphabet[n % alphabet.length] + out; n = Math.floor(n / alphabet.length); }
  return out;
}

/**
 * `passes` bookings checked in, departing within hours, one passenger each.
 * `upcoming` bookings not checked in, cycling through the shapes a real account
 * has: one-way and return, solo and groups, documents added or not, an outbound
 * already flown.
 */
function planBookings({ now, passes, upcoming, withMixed }) {
  const random = rng(20);
  const plan = [];

  for (let i = 0; i < passes; i++) {
    plan.push({ pax: 1, legs: [{ depart: now + (i + 1) * 6 * HOUR, statuses: ["checkin"] }] });
  }

  for (let i = 0; i < upcoming; i++) {
    const depart = now + (1 + Math.floor(random() * 60)) * DAY + (5 + Math.floor(random() * 14)) * HOUR;
    const back = depart + (2 + Math.floor(random() * 10)) * DAY;
    switch (i % 6) {
      case 0: // Solo, one way.
        plan.push({ pax: 1, legs: [{ depart, statuses: ["nocheckin"] }] });
        break;
      case 1: // Solo with documents added.
        plan.push({ pax: 1, legs: [{ depart, statuses: ["documentsadded"] }] });
        break;
      case 2: { // A group on a return trip.
        const pax = 2 + Math.floor(random() * 4);
        plan.push({ pax, legs: [
          { depart, statuses: Array(pax).fill("nocheckin") },
          { depart: back, statuses: Array(pax).fill("nocheckin") },
        ] });
        break;
      }
      case 3: // Outbound flown yesterday, return with documents added.
        plan.push({ pax: 1, legs: [
          { depart: now - DAY, statuses: ["flown"] },
          { depart: now + (2 + i) * DAY, statuses: ["documentsadded"] },
        ] });
        break;
      case 4: // A pair where only one of them has added documents.
        plan.push({ pax: 2, legs: [{ depart, statuses: ["documentsadded", "nocheckin"] }] });
        break;
      default: // Solo on a return trip.
        plan.push({ pax: 1, legs: [
          { depart, statuses: ["nocheckin"] },
          { depart: back, statuses: ["nocheckin"] },
        ] });
    }
  }

  if (withMixed) {
    // Outbound checked in, return with documents added: one pass comes back and
    // the return leg has to stay in the list next to it.
    plan.push({ pax: 1, legs: [
      { depart: now + 5 * HOUR, statuses: ["checkin"] },
      { depart: now + 3 * DAY + 7 * HOUR, statuses: ["documentsadded"] },
    ] });
  }

  return plan;
}

function buildBooking(spec, index, now, random) {
  const bookingId = 200_000_000 + index * 37;
  const pnr = pnrAt(index);
  const origin = AIRPORTS[index % AIRPORTS.length][0];
  const destination = AIRPORTS[(index * 5 + 3) % AIRPORTS.length][0];
  const createdMs = now - (10 + index) * DAY;

  const passengers = Array.from({ length: spec.pax }, (_, paxNum) => ({
    firstName: FIRST_NAMES[(index + paxNum) % FIRST_NAMES.length],
    lastName: LAST_NAMES[(index * 3 + paxNum) % LAST_NAMES.length],
    middleName: "",
    paxNum,
    paxType: paxNum === 0 || random() > 0.15 ? "ADT" : "CHD",
    title: "MR",
  }));

  const flights = spec.legs.map((leg, journeyNum) => {
    const [from, to] = journeyNum === 0 ? [origin, destination] : [destination, origin];
    const flightNumber = `FR${1000 + ((index * 13 + journeyNum * 7) % 8000)}`;
    const depart = leg.depart;
    const arrive = depart + 2 * HOUR + 15 * 60 * 1000;
    const times = { depart: iso(depart), departUTC: iso(depart), arrive: iso(arrive), arriveUTC: iso(arrive) };
    return {
      journeyNum,
      origin: from,
      destination: to,
      flightNumber,
      depart: times.depart,
      arrive: times.arrive,
      times,
      checkInOpenUTC: iso(depart - 60 * DAY),
      checkInFreeAllocateOpenUtcDate: iso(depart - 24 * HOUR),
      checkInCloseUTC: iso(depart - 2 * HOUR),
      segments: [{
        segmentNum: 0, origin: from, destination: to, flightNumber, isCancelled: false,
        depart: times.depart, arrive: times.arrive, times,
      }],
    };
  });

  const checkins = spec.legs.flatMap((leg, journeyNum) =>
    leg.statuses.map((status, paxNum) => ({ journeyNum, paxNum, segmentNum: 0, status })));

  // Every third booking has bought a seat for its first passenger.
  const seats = index % 3 === 1 ? [{ code: "12F", journeyNum: 0, paxNum: 0, qty: 1, segmentNum: 0, type: "SEAT" }] : [];

  const ssrs = passengers.flatMap((pax) => flights.map((flight) => ({
    code: "CBAG", journeyNum: flight.journeyNum, paxNum: pax.paxNum, qty: 1, segmentNum: 0, type: "BAG",
  })));

  const total = Math.round((49.99 + random() * 120) * spec.pax * flights.length * 100) / 100;
  const expires = iso(spec.legs[spec.legs.length - 1].depart + 2 * DAY);

  return {
    bookingId, pnr, flights, checkins, passengers,
    item: {
      correlationId: null,
      customerIds: ["<cid>"],
      expirationDate: expires,
      linkedBookings: null,
      payload: {
        __typename: "FlightOrderPayload",
        booking: {
          addOns: [],
          amount: total,
          bookingDate: iso(createdMs),
          bookingId,
          currency: "EUR",
          departureDate: flights[0].times.departUTC,
          destination,
          expiredDate: null,
          journeys: flights.map((flight) => ({ segments: flight.segments.map((segment) => ({
            arrivalTime: segment.times.arriveUTC, arrivalTimeLocal: segment.times.arrive,
            departureTime: segment.times.departUTC, departureTimeLocal: segment.times.depart,
            destination: segment.destination, origin: segment.origin, flightNumber: segment.flightNumber,
            paxSsrs: [],
          })) })),
          linkedBookings: null,
          origin,
          passengers: passengers.map((pax) => ({ name: `${pax.firstName} ${pax.lastName}`, type: pax.paxType })),
          paymentInfo: { paymentAttempt: 1, showDeclined: false },
          pnr,
          prime: { bookingMemberIds: null, ownerMemberId: null, primeBooking: false, primeDiscounts: null, resources: null },
          totalAmount: total,
        },
        customerId: "<cid>",
        hashVersion: "1",
        processingStatus: { code: "PROCESSED", reason: null },
        tripId: `trip-${bookingId}`,
      },
      processingStatus: { code: "PROCESSED", id: 1, reason: null },
      productId: String(bookingId),
      rawBooking: {
        addOns: [],
        balanceDue: 0,
        bookingId,
        checkins,
        createdDate: iso(createdMs),
        currency: "EUR",
        email: "traveller@example.com",
        expiredDate: expires,
        flightTotalAmount: total,
        flights,
        isInTadRefundQueue: false,
        modifiedDate: iso(createdMs + DAY),
        organizationInfo: null,
        passengers,
        pos: { locationCode: "IE", locationCodeGroup: "IE" },
        recordLocator: pnr,
        seats,
        ssrs,
        status: "Confirmed",
        totalAmount: total,
      },
      rawBookingFailure: null,
      tripId: `trip-${bookingId}`,
      type: "flight",
    },
  };
}

/** An item Ryanair failed to load the booking for: `payload` only, no `rawBooking`. */
function failedItem(booking) {
  const { rawBooking, ...item } = booking.item;
  void rawBooking;
  return {
    ...item,
    bookingId: booking.bookingId,
    processingStatus: { code: "FAILED", id: 2, reason: "Booking service unavailable" },
    rawBookingFailure: { message: "Booking service unavailable", code: 503 },
  };
}

/** Sorted soonest-first, the way the server answers `order=ASC`. */
export function buildAccount({ now = Date.now(), passes = 2, upcoming = 6, withFailure = false, withMixed = false } = {}) {
  const random = rng(7);
  const bookings = planBookings({ now, passes, upcoming, withMixed }).map((spec, index) => buildBooking(spec, index, now, random));
  bookings.sort((a, b) => Date.parse(a.flights[0].times.departUTC) - Date.parse(b.flights[0].times.departUTC));

  let items = bookings.map((booking) => booking.item);
  if (withFailure) {
    // A booking with two future legs, so the fallback has something to read.
    const source = bookings.find((booking) => booking.flights.length === 2 && booking.checkins.every((c) => c.status === "nocheckin"));
    if (source) {
      const failed = failedItem(source);
      items = items.map((item) => (item.productId === failed.productId ? failed : item));
    }
  }

  return { bookings, items };
}

/** Passes for the requested ids: one per passenger who has checked in, nothing for the rest. */
export function passesFor(account, requestedIds) {
  const wanted = new Set(requestedIds.map(Number));
  const passes = [];

  for (const booking of account.bookings) {
    if (!wanted.has(booking.bookingId)) continue;
    for (const flight of booking.flights) {
      for (const pax of booking.passengers) {
        const record = booking.checkins.find((c) => c.journeyNum === flight.journeyNum && c.paxNum === pax.paxNum);
        if (record?.status !== "checkin") continue;
        const depart = Date.parse(flight.times.departUTC);
        const arrive = Date.parse(flight.times.arriveUTC);
        const seat = `${10 + pax.paxNum}${"ABCDEF"[pax.paxNum % 6]}`;
        const sequence = 40 + pax.paxNum;
        passes.push({
          arrival: { code: flight.destination, date: flight.times.arrive.replace("Z", ""), dateUTC: flight.times.arriveUTC, dateUTCOffset: "UTC+0000", epoch: arrive, name: AIRPORTS.find((a) => a[0] === flight.destination)?.[1] ?? flight.destination },
          authorizationStatus: "Authorized",
          barcode: `M1${pax.lastName.toUpperCase()}/${pax.firstName.toUpperCase()} E${booking.pnr} ${flight.origin}${flight.destination}FR ${flight.flightNumber.slice(2).padStart(4, "0")} ${String(Math.floor(depart / DAY) % 365).padStart(3, "0")}Y0${seat.padStart(3, "0")}00${String(sequence).padStart(2, "0")} 100`,
          boardingTime: iso(depart - 40 * 60 * 1000).replace("Z", ""),
          boardingTimeEpoch: depart - 40 * 60 * 1000,
          businessPlus: false,
          departure: { code: flight.origin, date: flight.times.depart.replace("Z", ""), dateUTC: flight.times.departUTC, dateUTCOffset: "UTC+0000", epoch: depart, name: AIRPORTS.find((a) => a[0] === flight.origin)?.[1] ?? flight.origin },
          discount: "",
          docCountryOfIssue: "IE",
          docNationality: "IE",
          familyPlus: false,
          fast: false,
          flight: { carrierCode: "FR", label: `FR ${flight.flightNumber.slice(2)}`, number: flight.flightNumber.slice(2), operatedBy: "Ryanair" },
          hash: `${booking.pnr}${pax.paxNum}`.padEnd(32, "0"),
          isConnectingFlight: false,
          leisurePlus: false,
          name: { first: pax.firstName, last: pax.lastName, title: pax.title },
          passId: `${booking.pnr}_${flight.origin}${flight.destination}_${flight.flightNumber}_${sequence}_${pax.paxType}`,
          paxNumber: pax.paxNum,
          paxType: pax.paxType,
          pnr: booking.pnr,
          priority: pax.paxNum === 0,
          regular: pax.paxNum !== 0,
          seat: { designator: seat, door: 0, isPrime: false, location: pax.paxNum % 6 === 0 ? "Window" : "Middle", paid: false },
          sequence,
          ssrsDetails: [{ code: "CBAG", qty: 1, note: "[]" }],
          ticketType: "Regular",
          timeSaver: false,
        });
      }
    }
  }

  return passes;
}
