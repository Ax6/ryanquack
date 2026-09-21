/**
 * The account behind issue #20, rebuilt from the reporter's diagnostic report of
 * 2026-09-21: 128 active bookings served in pages of 25, 11 of them with a
 * return leg, groups of up to 13 passengers, most of them with travel documents
 * added and not checked in, one booking checked in with two passes, and one leg
 * already flown. Seven bookings share one flight the next morning, six with
 * documents added and one without — the "7 bookings, shows 1" of the thread.
 *
 * Shapes follow the report's schema skeleton key for key. Values are invented;
 * dates are relative to now so the check-in windows mean something.
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const AIRPORTS = [
  ["STN", "London Stansted"], ["DUB", "Dublin"], ["BGY", "Milan Bergamo"], ["KRK", "Krakow"],
  ["WAW", "Warsaw Modlin"], ["BCN", "Barcelona"], ["MAD", "Madrid"], ["PMI", "Palma"],
  ["ALC", "Alicante"], ["FAO", "Faro"], ["OPO", "Porto"], ["CIA", "Rome Ciampino"],
];
const FIRST_NAMES = ["Anna", "Piotr", "Marta", "Jakub", "Zofia", "Tomasz", "Ewa", "Marek", "Kasia", "Adam", "Ola", "Paweł", "Julia"];
const LAST_NAMES = ["Kowalski", "Nowak", "Wiśniewska", "Wójcik", "Kamiński", "Lewandowska", "Zieliński", "Szymańska"];

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
 * The plan: which bookings are ready, how many passengers, how many legs, and
 * when. Counts are chosen so the check-in tally matches the report exactly:
 * checkin 2, documentsadded 34, flown 1, nocheckin 590.
 */
function planBookings(now) {
  const random = rng(20);
  const plan = [];
  const tomorrow06 = Math.floor(now / DAY) * DAY + DAY + 6 * HOUR;

  // A: the checked-in booking, two passengers, two passes. Departs in six hours.
  plan.push({ key: "A", pax: 2, legs: [{ depart: now + 6 * HOUR, statuses: ["checkin", "checkin"] }] });
  // B: one passenger, outbound flown yesterday, return in three days with documents added.
  plan.push({ key: "B", pax: 1, legs: [
    { depart: now - 1 * DAY, statuses: ["flown"] },
    { depart: now + 3 * DAY, statuses: ["documentsadded"] },
  ] });
  // Seven bookings on the same flight tomorrow morning: six with documents added, one without.
  const sameFlight = [13, 9, 2, 1, 1, 1];
  sameFlight.forEach((pax, i) => plan.push({
    key: `S${i}`, pax, sameFlight: true,
    legs: [{ depart: tomorrow06, statuses: Array(pax).fill("documentsadded") }],
  }));
  plan.push({ key: "S6", pax: 4, sameFlight: true, legs: [{ depart: tomorrow06, statuses: Array(4).fill("nocheckin") }] });
  // Five more single travellers with documents added over the coming days.
  for (let i = 0; i < 5; i++) {
    plan.push({ key: `D${i}`, pax: 1, legs: [{ depart: now + (2 + i) * DAY + 8 * HOUR, statuses: ["documentsadded"] }] });
  }
  // One mixed group: the organiser added their own documents, the other has not.
  plan.push({ key: "M", pax: 2, legs: [{ depart: now + 4 * DAY + 10 * HOUR, statuses: ["nocheckin", "documentsadded"] }] });
  // documentsadded so far: 1 + (13+9+2+1+1+1) + 5 + 1 = 34. checkin 2, flown 1.

  // The rest: nocheckin only. 128 - 15 = 113 bookings, 10 of them with a return leg,
  // passenger-leg records summing to 590 - 4 (S6) - 1 (M) = 585.
  const rest = 128 - plan.length;
  const twoLeg = 10;
  let remaining = 585;
  for (let i = 0; i < rest; i++) {
    const legsCount = i < twoLeg ? 2 : 1;
    const left = rest - i - 1;
    // Keep enough for one passenger per remaining leg, then spread the rest.
    const minLater = left <= twoLeg - 1 - i ? 0 : 0;
    const reserve = Array.from({ length: left }, (_, j) => (i + 1 + j < twoLeg ? 2 : 1)).reduce((a, b) => a + b, 0);
    const maxPax = Math.min(13, Math.floor((remaining - reserve) / legsCount));
    const pax = i === rest - 1 ? Math.floor(remaining / legsCount) : Math.max(1, Math.min(maxPax, 1 + Math.floor(random() * 6)));
    remaining -= pax * legsCount;
    const departOut = now + (1 + Math.floor(random() * 75)) * DAY + (5 + Math.floor(random() * 14)) * HOUR;
    const legs = [{ depart: departOut, statuses: Array(pax).fill("nocheckin") }];
    if (legsCount === 2) legs.push({ depart: departOut + (2 + Math.floor(random() * 10)) * DAY, statuses: Array(pax).fill("nocheckin") });
    plan.push({ key: `N${i}`, pax, legs });
    void minLater;
  }
  if (remaining !== 0) throw new Error(`reporter plan off by ${remaining} nocheckin records`);

  return plan;
}

function buildBooking(spec, index, now, random) {
  const bookingId = 200_000_000 + index * 37;
  const pnr = pnrAt(index);
  const [o, d] = spec.sameFlight ? [AIRPORTS[0], AIRPORTS[3]] : [AIRPORTS[index % AIRPORTS.length], AIRPORTS[(index * 5 + 3) % AIRPORTS.length]];
  const origin = o[0];
  const destination = d[0];
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
    const flightNumber = spec.sameFlight ? "FR2372" : `FR${1000 + ((index * 13 + journeyNum * 7) % 8000)}`;
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

  // Three seats bought across the first page, as the report showed.
  const seats = [];
  if (index === 4) seats.push({ code: "01A", journeyNum: 0, paxNum: 0, qty: 1, segmentNum: 0, type: "SEAT" }, { code: "01B", journeyNum: 0, paxNum: 1, qty: 1, segmentNum: 0, type: "SEAT" });
  if (index === 9) seats.push({ code: "12F", journeyNum: 0, paxNum: 0, qty: 1, segmentNum: 0, type: "SEAT" });

  const ssrs = passengers.flatMap((pax) => flights.map((flight) => ({
    code: "CBAG", journeyNum: flight.journeyNum, paxNum: pax.paxNum, qty: 1, segmentNum: 0, type: "BAG",
  })));

  const total = Math.round((49.99 + random() * 120) * spec.pax * flights.length * 100) / 100;
  const firstDepart = flights[0].times.departUTC;

  return {
    bookingId, pnr, origin, destination, flights, checkins, passengers,
    item: {
      correlationId: null,
      customerIds: ["<cid>"],
      expirationDate: iso(spec.legs[spec.legs.length - 1].depart + 2 * DAY),
      linkedBookings: null,
      payload: {
        __typename: "FlightOrderPayload",
        booking: {
          addOns: [],
          amount: total,
          bookingDate: iso(createdMs),
          bookingId,
          currency: "EUR",
          departureDate: firstDepart,
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
        email: "reporter@example.com",
        expiredDate: iso(spec.legs[spec.legs.length - 1].depart + 2 * DAY),
        flightTotalAmount: total,
        flights,
        isInTadRefundQueue: false,
        modifiedDate: iso(createdMs + DAY),
        organizationInfo: null,
        passengers,
        pos: { locationCode: "PL", locationCodeGroup: "PL" },
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

/**
 * An item Ryanair failed to load the booking for: `payload` only. Not in the
 * reporter's account, so it is opt-in; it exercises the fallback path.
 */
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
export function reporterAccount({ now = Date.now(), withFailure = false } = {}) {
  const random = rng(7);
  const bookings = planBookings(now).map((spec, index) => buildBooking(spec, index, now, random));
  bookings.sort((a, b) => Date.parse(a.flights[0].times.departUTC) - Date.parse(b.flights[0].times.departUTC));

  let items = bookings.map((booking) => booking.item);
  if (withFailure) {
    // A booking with two future legs, so the fallback has something to read.
    const source = bookings.find((booking) => booking.flights.length === 2 && booking.checkins.every((c) => c.status === "nocheckin"));
    const failed = failedItem(source);
    items = items.map((item) => (item.productId === failed.productId ? failed : item));
  }

  return { bookings, items };
}

/**
 * A plain account with a chosen number of checked-in and upcoming bookings, one
 * passenger each, in the same shape as the reporter's. The knobs on the mock
 * dashboard, for looking at the popup with two passes or twenty.
 */
export function customAccount({ passes = 1, upcoming = 1, now = Date.now() } = {}) {
  const random = rng(3);
  const plan = [];
  for (let i = 0; i < passes; i++) {
    plan.push({ key: `P${i}`, pax: 1, legs: [{ depart: now + (i + 1) * 6 * HOUR, statuses: ["checkin"] }] });
  }
  for (let i = 0; i < upcoming; i++) {
    plan.push({ key: `U${i}`, pax: 1, legs: [{ depart: now + (i + 2) * DAY + 9 * HOUR, statuses: ["nocheckin"] }] });
  }
  const bookings = plan.map((spec, index) => buildBooking(spec, index, now, random));
  return { bookings, items: bookings.map((booking) => booking.item) };
}

/** Passes for the requested ids: one per passenger who has checked in, nothing for the rest. */
export function reporterPasses(account, requestedIds) {
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
          docCountryOfIssue: "PL",
          docNationality: "PL",
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

/** The numbers the report carried, so the mock can be checked against it. */
export function reporterTally(account) {
  const checkins = {};
  for (const booking of account.bookings) for (const c of booking.checkins) checkins[c.status] = (checkins[c.status] ?? 0) + 1;
  return {
    bookings: account.bookings.length,
    legs: account.bookings.reduce((sum, b) => sum + b.flights.length, 0),
    twoLeg: account.bookings.filter((b) => b.flights.length === 2).length,
    checkins,
  };
}
