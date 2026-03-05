// Configuration constants
export const BASE_URL = process.env.BASE_URL || "https://super.staging.net.in/api/v1/ss/v3/flights";
export const IS_LIVE = true;
export const BOOKING_URL = process.env.BOOKING_URL || "https://farefirst.com";
export const RESULTS_URL = process.env.RESULTS_URL || "https://farefirst.com/flight-results/";

// No need for interfaces in JS, using JSDoc comments instead

/**
 * @typedef {Object} FlightSummary
 * @property {string} tripType
 * @property {string} airline
 * @property {string} duration
 * @property {string} from
 * @property {string} to
 * @property {string} price
 * @property {string} departureTime
 * @property {string} arrivalTime
 * @property {string} stops
 * @property {number} stopCount
 * @property {number} priceRaw
 * @property {string[]} deeplink
 * @property {string[]} layovers
 */

/**
 * @typedef {Object} AirportSuggestion
 * @property {string} entityId
 * @property {string} iataCode
 * @property {string} name
 * @property {string} cityName
 * @property {string} countryName
 * @property {string} type
 */

/**
 * @typedef {Object} DateObj
 * @property {number} year
 * @property {number} month
 * @property {number} day
 */