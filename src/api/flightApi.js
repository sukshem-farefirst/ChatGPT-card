import { BASE_URL, IS_LIVE } from "./types.js";
import {
  parseDateToAPIFormat,
  getDefaultDate,
  extractData,
} from "../utils/flightUtils.js";

const API_KEY = process.env.API_KEY || "SSZbsPSLJKxYqHCQDHvOG6EnhZZFG4TTSI";

const COUNTRY_CURRENCY = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  AE: "AED",
  AU: "AUD",
  CA: "CAD",
  SG: "SGD",
  EU: "EUR",
  DE: "EUR",
  FR: "EUR",
  IT: "EUR",
  ES: "EUR",
  NL: "EUR",
  JP: "JPY",
  CN: "CNY",
  HK: "HKD",
  MY: "MYR",
  TH: "THB",
  NZ: "NZD",
  ZA: "ZAR",
  CH: "CHF",
  SE: "SEK",
  NO: "NOK",
  DK: "DKK",
  PL: "PLN",
  MX: "MXN",
  BR: "BRL",
  AR: "ARS",
  NG: "NGN",
  KE: "KES",
  PH: "PHP",
  ID: "IDR",
  VN: "VND",
  PK: "PKR",
  BD: "BDT",
  LK: "LKR",
  NP: "NPR",
};

export function getCurrencyForCountry(userCountry) {
  return COUNTRY_CURRENCY[userCountry?.toUpperCase()] ?? "USD";
}

export async function fetchAirportSuggestions(searchTerm, suggestMarket = "IN") {
  try {
    console.log(`🔍 Fetching airport suggestions for: "${searchTerm}" in market: ${suggestMarket}`);
    
    const requestBody = {
      query: {
        market: suggestMarket,
        locale: "en-US",
        searchTerm,
        includedEntityTypes: ["PLACE_TYPE_CITY", "PLACE_TYPE_AIRPORT"],
      },
      limit: 7,
      isDestination: true,
    };

    console.log("📦 Request body:", JSON.stringify(requestBody, null, 2));

    const res = await fetch(
      `https://super.staging.net.in/api/v1/ss/v3/autosuggest/flights?live=true`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify(requestBody),
      }
    );

    console.log(`📡 Response status:`, res.status, res.statusText);
    console.log(`📡 Response headers:`, Object.fromEntries(res.headers.entries()));

    if (!res.ok) {
      console.error(`❌ Autosuggest API error: ${res.status} ${res.statusText}`);
      const errorText = await res.text().catch(() => "");
      console.error("Error response body:", errorText);
      return [];
    }

    const data = await res.json();
    console.log(`✅ Autosuggest success for "${searchTerm}":`, {
      placesCount: data?.places?.length || 0,
      firstFew: data?.places?.slice(0, 3).map(p => ({
        name: p.name,
        iata: p.iataCode,
        city: p.cityName,
        type: p.type
      }))
    });

    const places = (data?.places ?? []).map((place) => ({
      entityId: place.entityId,
      iataCode: place.iataCode,
      name: place.name,
      cityName: place.cityName || place.name,
      countryName: place.countryName,
      type: place.type,
    }));

    return places;
  } catch (err) {
    console.error("❌ Airport suggestion error:", err);
    return [];
  }
}

function deduplicateByEntityId(places) {
  const seen = new Set();
  return places.filter((p) => {
    if (seen.has(p.entityId)) return false;
    seen.add(p.entityId);
    return true;
  });
}

export async function resolveAirportWithLogic(searchTerm, suggestMarket = "IN") {
  console.log(`🔍 Resolving airport: "${searchTerm}"`);
  
  const allPlaces = await fetchAirportSuggestions(searchTerm, suggestMarket);

  if (allPlaces.length === 0) {
    console.log(`❌ No airports found for "${searchTerm}"`);
    return {
      status: "not_found",
      message: `Could not find any airport or city matching "${searchTerm}". Please try a more specific name or use the IATA code directly.`,
    };
  }

  if (allPlaces.length === 1) {
    console.log(`✅ Resolved unique airport:`, {
      name: allPlaces[0].name,
      iata: allPlaces[0].iataCode,
      city: allPlaces[0].cityName
    });
    return { status: "resolved", airport: allPlaces[0] };
  }

  const exactIataMatch = allPlaces.find(
    (p) =>
      p.iataCode?.toUpperCase() === searchTerm.trim().toUpperCase() &&
      p.type === "PLACE_TYPE_AIRPORT"
  );
  
  if (exactIataMatch) {
    console.log(`✅ Resolved exact IATA match:`, {
      name: exactIataMatch.name,
      iata: exactIataMatch.iataCode
    });
    return { status: "resolved", airport: exactIataMatch };
  }

  const airportOnlyPlaces = deduplicateByEntityId(
    allPlaces.filter((p) => p.type !== "PLACE_TYPE_CITY")
  );

  if (airportOnlyPlaces.length === 1) {
    console.log(`✅ Resolved single airport:`, {
      name: airportOnlyPlaces[0].name,
      iata: airportOnlyPlaces[0].iataCode
    });
    return { status: "resolved", airport: airportOnlyPlaces[0] };
  }

  if (airportOnlyPlaces.length > 1) {
    console.log(`⚠️ Ambiguous airports found:`, airportOnlyPlaces.map(a => ({
      name: a.name,
      iata: a.iataCode,
      city: a.cityName
    })));
    
    return {
      status: "ambiguous",
      airports: airportOnlyPlaces,
      message: `There are multiple airports for "${searchTerm}"`,
    };
  }

  console.log(`✅ Resolved using first result:`, {
    name: allPlaces[0].name,
    iata: allPlaces[0].iataCode
  });
  return { status: "resolved", airport: allPlaces[0] };
}

function createSearchPayload(
  from,
  to,
  date,
  adults,
  children,
  cabinClass,
  userCountry,
  currency,
  fromEntityId,
  toEntityId
) {
  const originPlaceId = fromEntityId
    ? { entityId: fromEntityId }
    : { iata: from };

  const destinationPlaceId = toEntityId
    ? { entityId: toEntityId }
    : { iata: to };

  return {
    query: {
      market: userCountry,
      locale: "en-US",
      currency,
      queryLegs: [
        {
          originPlaceId,
          destinationPlaceId,
          date: parseDateToAPIFormat(date),
        },
      ],
      adults,
      children,
      cabinClass: cabinClass || "CABIN_CLASS_ECONOMY",
    },
  };
}

export async function fetchFlights(
  from = "JFK",
  to = "DXB",
  date = getDefaultDate(),
  adults = 1,
  children = 0,
  cabinClass = "CABIN_CLASS_ECONOMY",
  fromEntityId,
  toEntityId,
  userCountry = "US"
) {
  const currency = getCurrencyForCountry(userCountry);

  try {
    console.log(`🛫 Fetching flights: ${from} → ${to} on ${date}`);
    
    const resolvedFromEntityId = fromEntityId;
    const resolvedToEntityId = toEntityId;

    const payload = createSearchPayload(
      from,
      to,
      date,
      adults,
      children,
      cabinClass,
      userCountry,
      currency,
      resolvedFromEntityId,
      resolvedToEntityId
    );
    
    console.log("📦 Flight search payload:", JSON.stringify(payload, null, 2));

    const searchRes = await fetch(
      `${BASE_URL}/live/search/create?live=${IS_LIVE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify(payload),
      }
    );

    console.log(`📡 Flight search response status:`, searchRes.status);

    if (!searchRes.ok) {
      const errorText = await searchRes.text().catch(() => "");
      console.error("❌ Flight search error response:", errorText);
      throw new Error(`Search failed: ${searchRes.status} ${errorText}`);
    }

    const searchData = await searchRes.json();
    console.log(`✅ Flight search successful, sessionToken:`, searchData.sessionToken ? "present" : "missing");

    if (!searchData?.content?.results) {
      console.error("❌ Invalid response: missing content.results");
      throw new Error("Invalid search response: missing content.results");
    }

    if (!searchData.sessionToken) {
      console.error("❌ Invalid response: missing sessionToken");
      throw new Error("Invalid search response: missing sessionToken");
    }

    const initialFlights = extractData(searchData, from, to);
    console.log(`📊 Extracted ${initialFlights.length} flights`);

    return {
      flights: initialFlights,
      fromEntityId: resolvedFromEntityId,
      toEntityId: resolvedToEntityId,
    };
  } catch (error) {
    console.error("❌ Flight fetch error:", error);
    return { flights: [] };
  }
}