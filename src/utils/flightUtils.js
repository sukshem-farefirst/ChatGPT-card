import { shortenDeeplinks } from "../services/urlShortener.js";
import { RESULTS_URL } from "../api/types.js";

// Currency mappings
const CURRENCY_SYMBOL = {
  INR: "₹",
  USD: "$",
  GBP: "£",
  EUR: "€",
  AED: "AED",
  AUD: "A$",
  CAD: "C$",
  SGD: "S$",
  JPY: "¥",
  CNY: "¥",
};

const COUNTRY_TO_CURRENCY = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  AE: "AED",
  AU: "AUD",
  CA: "CAD",
  SG: "SGD",
  JP: "JPY",
  CN: "CNY",
};

export function getDefaultDate() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  return date.toISOString().split("T")[0];
}

export function parseDateToAPIFormat(dateStr) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

export function formatTime(datetime) {
  if (!datetime) return "N/A";
  const { hour, minute } = datetime;
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

function formatTime24to12(time) {
  if (!time || time === "N/A") return "N/A";
  const [hourStr, minute] = time.split(":");
  const hour = parseInt(hourStr, 10);
  const period = hour >= 12 ? "pm" : "am";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute} ${period}`;
}

export function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function getCurrencyFromCountry(userCountry) {
  if (!userCountry) return "USD";
  return COUNTRY_TO_CURRENCY[userCountry.toUpperCase()] ?? "USD";
}

export function formatPrice(milliAmount, currency) {
  const amount = milliAmount / 1000;
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `${symbol}${formatted}`;
}

export function extractData(searchData, from, to) {
  const flights = [];

  try {
    const { itineraries, legs, carriers, places, segments } =
      searchData.content?.results ?? {};

    if (!itineraries || !legs || !carriers) return [];

    const itineraryIds = Object.keys(itineraries).slice(0, 10);

    for (const itineraryId of itineraryIds) {
      const itinerary = itineraries[itineraryId];
      const legId = itinerary.legIds?.[0];
      if (!legId) continue;

      const leg = legs[legId];
      if (!leg) continue;

      const pricingOption = itinerary.pricingOptions?.[0];
      const priceAmount = pricingOption?.price?.amount;
      const priceUnit = pricingOption?.price?.unit;

      let priceRaw = 0;
      if (priceAmount && priceUnit === "PRICE_UNIT_MILLI") {
        priceRaw = parseInt(priceAmount);
      }

      const carrierId = leg.marketingCarrierIds?.[0];
      const carrier = carrierId ? carriers[carrierId] : null;
      const deeplink = pricingOption?.items?.[0]?.deepLink;

      const airlineName =
        carrier?.name?.trim() ||
        carrier?.displayCode?.trim() ||
        carrier?.iata?.trim() ||
        "Unknown Airline";

      const originPlace = leg.originPlaceId ? places?.[leg.originPlaceId] : null;
      const destPlace = leg.destinationPlaceId ? places?.[leg.destinationPlaceId] : null;

      const originCode = originPlace?.iata ?? from;
      const destCode = destPlace?.iata ?? to;

      const departureTime = formatTime(leg.departureDateTime);
      const arrivalTime = formatTime(leg.arrivalDateTime);
      const duration = formatDuration(leg.durationInMinutes ?? 0);
      const stopCount = leg.stopCount ?? 0;

      let layovers = [];

      if (stopCount > 0 && segments && leg.segmentIds?.length > 1) {
        for (let i = 0; i < leg.segmentIds.length - 1; i++) {
          const firstSeg = segments[leg.segmentIds[i]];
          const nextSeg = segments[leg.segmentIds[i + 1]];

          if (!firstSeg || !nextSeg) continue;

          const layoverPlace = firstSeg.destinationPlaceId
            ? places?.[firstSeg.destinationPlaceId]
            : null;

          const layoverCity = layoverPlace?.iata ?? "Unknown";

          const arr = firstSeg.arrivalDateTime;
          const dep = nextSeg.departureDateTime;

          if (!arr || !dep) {
            layovers.push(layoverCity);
            continue;
          }

          const arrival = new Date(
            arr.year,
            arr.month - 1,
            arr.day,
            arr.hour,
            arr.minute
          ).getTime();

          const departure = new Date(
            dep.year,
            dep.month - 1,
            dep.day,
            dep.hour,
            dep.minute
          ).getTime();

          const diff = Math.floor((departure - arrival) / 60000);

          if (diff <= 0 || isNaN(diff)) {
            layovers.push(layoverCity);
          } else {
            layovers.push(`${layoverCity} - ${formatDuration(diff)}`);
          }
        }
      }

      flights.push({
        tripType: stopCount === 0 ? "Nonstop" : "One Stop",
        airline: airlineName,
        duration,
        from: originCode,
        to: destCode,
        price: "",
        priceRaw,
        departureTime,
        arrivalTime,
        stops: stopCount === 0 ? "Direct" : `${stopCount} stop`,
        stopCount,
        layovers,
        deeplink: deeplink ? [deeplink] : [],
      });
    }

    return flights;
  } catch (error) {
    console.error("Error extracting flight data:", error);
    return [];
  }
}

export function sortFlights(flights) {
  const direct = flights.filter((f) => f.stopCount === 0);
  const oneStop = flights
    .filter((f) => f.stopCount > 0)
    .sort((a, b) => a.priceRaw - b.priceRaw);
  return [...direct, ...oneStop];
}

export function formatFlightObject(f, currency) {
  const layoverStr =
    f.layovers && f.layovers.length > 0 ? ` (${f.layovers.join(", ")})` : "";

  return {
    airline: f.airline,
    departure: formatTime24to12(f.departureTime),
    arrival: formatTime24to12(f.arrivalTime),
    duration: f.duration,
    stops: f.stopCount === 0 ? "Direct" : `${f.stopCount} stop${layoverStr}`,
    price: formatPrice(f.priceRaw, currency),
    book: Array.isArray(f.deeplink) ? f.deeplink[0] : f.deeplink || null,
  };
}

export async function attachShortLinks(flights) {
  const allUrls = [];

  flights.forEach((flight) => {
    const deeplinks = Array.isArray(flight.deeplink)
      ? flight.deeplink
      : typeof flight.deeplink === "string"
        ? [flight.deeplink]
        : [];
    allUrls.push(...deeplinks);
  });

  if (allUrls.length === 0) return flights;

  const shortUrls = await shortenDeeplinks(allUrls);
  let index = 0;

  return flights.map((flight) => {
    const deeplinks = Array.isArray(flight.deeplink)
      ? flight.deeplink
      : typeof flight.deeplink === "string"
        ? [flight.deeplink]
        : [];
    const updatedLinks = shortUrls.slice(index, index + deeplinks.length);
    index += deeplinks.length;
    return { ...flight, deeplink: updatedLinks };
  });
}

export function formatFlightsForWidget(flights, from, to, date, adults = 1, children = 0, userCountry) {
  const currency = getCurrencyFromCountry(userCountry);
  
  return {
    searchParams: {
      from,
      to,
      date,
      adults,
      children
    },
    flights: flights.map(flight => ({
      id: Math.random().toString(36).substr(2, 9),
      airline: flight.airline,
      from: flight.from,
      to: flight.to,
      departureTime: flight.departureTime,
      arrivalTime: flight.arrivalTime,
      duration: flight.duration,
      stops: flight.stops,
      stopCount: flight.stopCount,
      priceRaw: flight.priceRaw,
      deeplink: flight.deeplink,
      layovers: flight.layovers || [],
      // Additional fields for enhanced widget
      baggage: "20kg",
      meal: flight.stopCount === 0 ? "Included" : "Available",
      seats: "Auto-assigned",
      refundable: flight.stopCount === 0
    }))
  };
}