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

    if (!res.ok) {
      console.error(`❌ Autosuggest API error: ${res.status} ${res.statusText}`);
      const errorText = await res.text().catch(() => "");
      console.error("Error response body:", errorText);
      return [];
    }

    const data = await res.json();
    console.log(`✅ Autosuggest success for "${searchTerm}":`, {
      placesCount: data?.places?.length || 0,
    });

    const places = (data?.places ?? []).map((place) => ({
      entityId: place.entityId,
      iataCode: place.iataCode,
      name: place.name,
      cityName: place.cityName || place.name,
      countryName: place.countryName,
      type: place.type,
      skyId: place.skyId || place.iataCode,
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

// Helper function to format multi-airport message exactly as requested
function formatMultiAirportMessage(cityName, fromAirports, toAirports = null, fromCityName = null, toCityName = null) {
  let message = `Sure ✈️ I can help with that.\n\n`;
  
  if (fromAirports && toAirports) {
    message += `${fromCityName || cityName} has multiple airports`;
    if (toCityName) {
      message += ` and ${toCityName} also has multiple airports`;
    }
    message += `. Please confirm:\n\n`;
    
    // From airports
    message += `**From ${fromCityName || cityName}:**\n`;
    fromAirports.forEach(airport => {
      // Extract just the airport name without the city prefix
      const airportName = airport.name.replace(airport.cityName, '').replace(/\([^)]+\)/, '').trim();
      message += `👉 **${airport.iataCode}** (${airportName || airport.name})\n`;
    });
    
    // To airports if provided
    if (toAirports && toCityName) {
      message += `\n**To ${toCityName}:**\n`;
      toAirports.forEach(airport => {
        const airportName = airport.name.replace(airport.cityName, '').replace(/\([^)]+\)/, '').trim();
        message += `👉 **${airport.iataCode}** (${airportName || airport.name})\n`;
      });
    }
  } else {
    message += `**${cityName}** has multiple airports. Please confirm which one you'd like to fly from/to:\n\n`;
    message += `**From ${cityName}:**\n`;
    fromAirports.forEach(airport => {
      const airportName = airport.name.replace(airport.cityName, '').replace(/\([^)]+\)/, '').trim();
      message += `👉 **${airport.iataCode}** (${airportName || airport.name})\n`;
    });
  }
  
  message += `\nAlso tell me your travel date.\n\n`;
  
  // Add example reply
  if (fromAirports && toAirports) {
    message += `Reply like: **${fromAirports[0].iataCode} to ${toAirports[0].iataCode} on 5 March** and I'll show the flights.`;
  } else if (fromAirports) {
    message += `Reply like: **${fromAirports[0].iataCode} to [destination] on [date]** and I'll show the flights.`;
  }
  
  return message;
}

export async function resolveAirport(searchTerm, suggestMarket = "IN", isOrigin = true, otherAirports = null, otherCityName = null) {
  console.log(`🔍 Resolving airport: "${searchTerm}" (${isOrigin ? 'origin' : 'destination'})`);
  
  if (!searchTerm || searchTerm.trim() === "") {
    return {
      status: "invalid",
      message: "Please provide a valid airport or city name",
    };
  }

  const allPlaces = await fetchAirportSuggestions(searchTerm, suggestMarket);

  if (allPlaces.length === 0) {
    console.log(`❌ No airports found for "${searchTerm}"`);
    return {
      status: "not_found",
      message: `Could not find any airport or city matching "${searchTerm}". Please try a more specific name or use the IATA code directly.`,
    };
  }

  // Check for exact IATA code match first (only for airports)
  const exactIataMatch = allPlaces.find(
    (p) => p.iataCode?.toUpperCase() === searchTerm.trim().toUpperCase() && 
           p.type === "PLACE_TYPE_AIRPORT"
  );
  
  if (exactIataMatch) {
    console.log(`✅ Resolved exact IATA match:`, {
      name: exactIataMatch.name,
      iata: exactIataMatch.iataCode
    });
    return { 
      status: "resolved", 
      airport: exactIataMatch 
    };
  }

  // Filter to ONLY airports (PLACE_TYPE_AIRPORT)
  const airportPlaces = deduplicateByEntityId(
    allPlaces.filter((p) => p.type === "PLACE_TYPE_AIRPORT")
  );

  // If only one airport found
  if (airportPlaces.length === 1) {
    console.log(`✅ Resolved single airport:`, {
      name: airportPlaces[0].name,
      iata: airportPlaces[0].iataCode
    });
    return { status: "resolved", airport: airportPlaces[0] };
  }

  // If multiple airports found, create the friendly message
  if (airportPlaces.length > 1) {
    console.log(`⚠️ Multiple airports found:`, airportPlaces.map(a => ({
      name: a.name,
      iata: a.iataCode,
      city: a.cityName
    })));
    
    // Get the city name from the first airport
    const cityName = airportPlaces[0].cityName || airportPlaces[0].name;
    
    // Create the response object
    const response = {
      status: "ambiguous",
      airports: airportPlaces,
      cityName: cityName,
      message: `Multiple airports found for "${searchTerm}"`,
    };

    // Format the message based on whether we have both origin and destination
    if (otherAirports) {
      // We have both origin and destination airports
      response.formattedMessage = formatMultiAirportMessage(
        cityName, 
        airportPlaces, 
        otherAirports,
        cityName,
        otherCityName
      );
    } else {
      // Only one side has multiple airports
      response.formattedMessage = formatMultiAirportMessage(cityName, airportPlaces);
    }
    
    return response;
  }

  // If only cities found (no airports directly) - but we still need airports
  const cityPlaces = deduplicateByEntityId(
    allPlaces.filter((p) => p.type === "PLACE_TYPE_CITY")
  );

  if (cityPlaces.length > 0) {
    // Try to fetch airports for this city using the city name
    const cityName = cityPlaces[0].name;
    console.log(`🏙️ City found: ${cityName}, fetching airports for this city...`);
    
    // Fetch airports specifically for this city
    const airportResults = await fetchAirportSuggestions(cityName, suggestMarket);
    const cityAirports = airportResults.filter(p => p.type === "PLACE_TYPE_AIRPORT");
    
    if (cityAirports.length > 0) {
      // We found airports for this city
      if (cityAirports.length === 1) {
        return { status: "resolved", airport: cityAirports[0] };
      } else {
        // Multiple airports for this city
        const response = {
          status: "ambiguous",
          airports: cityAirports,
          cityName: cityName,
          message: `${cityName} has multiple airports. Please select one:`,
          formattedMessage: formatMultiAirportMessage(cityName, cityAirports)
        };
        return response;
      }
    }
    
    return {
      status: "not_found",
      message: `"${searchTerm}" is a city but no airports found. Please try a specific airport name or IATA code.`,
    };
  }

  // Default to first result if nothing else matches (should rarely happen)
  console.log(`✅ Resolved using first result:`, {
    name: allPlaces[0].name,
    iata: allPlaces[0].iataCode
  });
  return { status: "resolved", airport: allPlaces[0] };
}

function createSearchPayload(
  fromEntityId,
  toEntityId,
  fromIata,
  toIata,
  date,
  adults,
  children,
  cabinClass,
  userCountry,
  currency
) {
  const originPlaceId = fromEntityId
    ? { entityId: fromEntityId }
    : { iata: fromIata };

  const destinationPlaceId = toEntityId
    ? { entityId: toEntityId }
    : { iata: toIata };

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
  fromIata,
  toIata,
  date,
  adults = 1,
  children = 0,
  cabinClass = "CABIN_CLASS_ECONOMY",
  fromEntityId = null,
  toEntityId = null,
  userCountry = "US"
) {
  const currency = getCurrencyForCountry(userCountry);

  try {
    console.log(`🛫 Fetching flights: ${fromIata} → ${toIata} on ${date}`);
    
    const payload = createSearchPayload(
      fromEntityId,
      toEntityId,
      fromIata,
      toIata,
      date,
      adults,
      children,
      cabinClass,
      userCountry,
      currency
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
      return { flights: [], sessionToken: null, error: `Search failed: ${searchRes.status}` };
    }

    const searchData = await searchRes.json();
    console.log(`✅ Flight search successful, sessionToken:`, searchData.sessionToken ? "present" : "missing");

    if (!searchData?.content?.results) {
      console.error("❌ Invalid response: missing content.results");
      return { flights: [], sessionToken: null, error: "Invalid search response" };
    }

    if (!searchData.sessionToken) {
      console.error("❌ Invalid response: missing sessionToken");
      return { flights: [], sessionToken: null, error: "Missing session token" };
    }

    const initialFlights = extractData(searchData, fromIata, toIata);
    console.log(`📊 Extracted ${initialFlights.length} flights`);

    return {
      flights: initialFlights,
      sessionToken: searchData.sessionToken,
      error: null
    };
  } catch (error) {
    console.error("❌ Flight fetch error:", error);
    return { flights: [], sessionToken: null, error: error.message };
  }
}