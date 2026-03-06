import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { createServer } from "http";
import { readFileSync } from "fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from "dotenv";

dotenv.config();

import { fetchFlights, resolveAirport } from "./src/api/flightApi.js";
import {
  sortFlights,
  attachShortLinks,
  formatFlightsForWidget,
} from "./src/utils/flightUtils.js";

const flightHtml = readFileSync("public/flight-widget.html", "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// In-memory sessions
// ─────────────────────────────────────────────────────────────────────────────
const sessions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Reply helpers
// ─────────────────────────────────────────────────────────────────────────────
const replyText = (message) => ({
  content: [{ type: "text", text: message }],
  _meta: {},
});

const replyWithCard = (message, flights, searchParams) => ({
  content: [{ type: "text", text: message }],
  structuredContent: {
    flights,
    searchParams,
    sessionToken: true,
  },
  _meta: { 
    ui: { resourceUri: "ui://widget/flight.html" }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Build the combined ambiguity message for BOTH airports in one response
// ─────────────────────────────────────────────────────────────────────────────
function buildAmbiguityMessage(fromAmbiguous, toAmbiguous, fromTerm, toTerm) {
  let msg = `✈️ I found multiple airports. Please confirm which ones you'd like:\n\n`;

  if (fromAmbiguous && fromAmbiguous.length > 0) {
    msg += `**From "${fromTerm}":**\n`;
    fromAmbiguous.forEach((a) => {
      const name =
        a.name
          .replace(a.cityName || "", "")
          .replace(/\s*\(.*?\)\s*/g, "")
          .trim() || a.name;
      msg += `👉 **${a.iataCode}** — ${name}, ${a.cityName}\n`;
    });
  }

  if (toAmbiguous && toAmbiguous.length > 0) {
    if (fromAmbiguous) msg += `\n`;
    msg += `**To "${toTerm}":**\n`;
    toAmbiguous.forEach((a) => {
      const name =
        a.name
          .replace(a.cityName || "", "")
          .replace(/\s*\(.*?\)\s*/g, "")
          .trim() || a.name;
      msg += `👉 **${a.iataCode}** — ${name}, ${a.cityName}\n`;
    });
  }

  msg += `\nReply with the IATA code(s) you'd like`;

  if (fromAmbiguous && toAmbiguous && fromAmbiguous.length > 0 && toAmbiguous.length > 0) {
    msg += ` for both, e.g. **${fromAmbiguous[0].iataCode}** to **${toAmbiguous[0].iataCode}**.`;
  } else if (fromAmbiguous && fromAmbiguous.length > 0) {
    msg += `, e.g. **${fromAmbiguous[0].iataCode}**.`;
  } else if (toAmbiguous && toAmbiguous.length > 0) {
    msg += `, e.g. **${toAmbiguous[0].iataCode}**.`;
  }

  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server factory
// ─────────────────────────────────────────────────────────────────────────────
function createFlightServer() {
  const server = new McpServer({
    name: "flight-search-app",
    version: "2.0.0",
  });

  registerAppResource(
    server,
    "flight-widget",
    "ui://widget/flight.html",
    {},
    async () => ({
      contents: [
        {
          uri: "ui://widget/flight.html",
          mimeType: RESOURCE_MIME_TYPE,
          text: flightHtml,
        },
      ],
    }),
  );

  // ── search_flights tool ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "search_flights",
    {
      title: "Search Flights",

     description: [
  "Search for one-way flights between two airports on a given date.",
  "",
  "=== WHEN TO CALL THIS TOOL ===",
  "ONLY call this tool when the user has explicitly provided ALL THREE of:",
  "  1. from  — origin city or airport name",
  "  2. to    — destination city or airport name",
  "  3. date  — travel date",
  "",
  "=== STRICT RULES — READ CAREFULLY ===",
  "RULE 1: DO NOT call this tool until you have from, to, AND date from the user.",
  "RULE 2: Collect all 3 in a SINGLE conversation turn if possible.",
  "RULE 3: DO NOT call the tool with only 1 or 2 fields filled.",
  "RULE 4: DO NOT guess or assume from, to, or date.",
  "RULE 5: DO NOT call this tool for greetings or vague travel statements.",
  "RULE 6: Once all 3 are provided, call this tool ONCE with all 3 fields.",
  "RULE 7: DO NOT call the tool again if from, to, and date have NOT changed since the last successful search.",
  "RULE 8: DO NOT render flight cards or send structuredContent in the widget until ALL of the following are true:",
  "        • airports are fully resolved (no ambiguity remaining),",
  "        • the flights create API call has successfully returned flight data,",
  "        • the returned JSON contains a 'flights' array with 3 or more items,",
  "        • and 'sessionToken' is true.",
  "        • Until that, respond only with plain text messages (e.g., airport ambiguity lists).",
  "",
  "RULE 9: Always use complete and accurate airport/city names. Avoid abbreviations unless they are standard IATA codes (e.g., JFK, LHR, DXB).",
  "RULE 10: Validate that the date is in YYYY-MM-DD format and is not in the past or more than 1 year in the future before calling the tool.",
  "RULE 11: Ensure passenger count (adults + children) does not exceed 9 before calling the tool.",
  "RULE 12: If the user provides ambiguous location names (e.g., 'New York' without specifying which airport), the server will return ambiguity options. Present these to the user and ask for IATA code selection before proceeding.",
  "RULE 13: When the user provides valid IATA codes (e.g., JFK, DXB), use them directly without ambiguity resolution.",
  "RULE 14: Once all validations pass and airports are resolved, the tool will automatically fetch flights and display results.",
  "RULE 15: The origin and destination CANNOT be the same. If the user tries to search for flights from and to the same city/airport, ask them to choose different locations.",
  "RULE 16: The travel date MUST be today's date or a future date. Never allow dates in the past. If the user provides a past date, ask them to select a current or future date.",
  "",
  "=== DATE VALIDATION ===",
  "• Today's date is the reference point. Any date before today is invalid.",
  "• Dates must be in YYYY-MM-DD format.",
  "• Maximum allowed date is 1 year from today.",
  "",
  "=== LOCATION VALIDATION ===",
  "• Origin and destination must be different.",
  "• If user tries to book a flight from and to the same place, politely inform them that's not possible and ask for different destinations.",
  "",
  "=== DISAMBIGUATION FLOW ===",
  "After you call with from+to+date, the server may return an ambiguity message",
  "listing multiple airports for from and/or to — both ambiguities are returned",
  "in a SINGLE response. Show that message to the user and ask them to pick.",
  "Then call again with selectedFromIata and/or selectedToIata set.",
  "",
  "=== EXAMPLES ===",
  "CORRECT: User says 'fly from Mumbai to Dubai on March 15'",
  "         → call tool with from='Mumbai', to='Dubai', date='2026-03-15'",
  "",
  "CORRECT: User says 'JFK to DXB on 2026-03-17'",
  "         → call tool with from='JFK', to='DXB', date='2026-03-17'",
  "",
  "CORRECT: User says 'from New York to London on 2026-05-10 with 2 adults'",
  "         → call tool with from='New York', to='London', date='2026-05-10', adults=2",
  "",
  "WRONG: User says 'I want to travel'",
  "       → DO NOT call tool. Ask for from, to, and date first.",
  "",
  "WRONG: User says 'from New York to Dubai'",
  "       → DO NOT call tool yet. Date is missing. Ask for date.",
  "",
  "WRONG: User says 'NYC to DXB tomorrow'",
  "       → Convert 'tomorrow' to proper YYYY-MM-DD format first, then call tool.",
  "",
  "WRONG: User says 'fly from New York to New York on 2026-03-17'",
  "       → DO NOT call tool. Origin and destination are the same. Ask for different locations.",
  "",
  "WRONG: User says 'fly from Mumbai to Dubai on 2025-01-01'",
  "       → DO NOT call tool if 2025-01-01 is in the past. Ask for a current or future date.",
].join("\n"),
      inputSchema: z.object({
        from: z
          .string()
          .min(1)
          .describe("Origin — provided by user. Can be city name (e.g., 'Mumbai') or IATA code (e.g., 'JFK')."),

        to: z
          .string()
          .min(1)
          .describe("Destination — provided by user. Can be city name (e.g., 'Dubai') or IATA code (e.g., 'DXB')."),

        date: z
          .string()
          .describe(
            "Travel date in YYYY-MM-DD format (e.g., 2026-03-15). Must be today or in the future, and not more than 1 year ahead.",
          ),

        adults: z.number().int().min(1).max(9).optional().default(1),
        children: z.number().int().min(0).max(8).optional().default(0),
        cabinClass: z
          .enum([
            "CABIN_CLASS_ECONOMY",
            "CABIN_CLASS_PREMIUM_ECONOMY",
            "CABIN_CLASS_BUSINESS",
            "CABIN_CLASS_FIRST",
          ])
          .optional()
          .default("CABIN_CLASS_ECONOMY"),

        selectedFromIata: z
          .string()
          .optional()
          .describe(
            "IATA code chosen by user for origin after ambiguity. e.g. 'JFK'",
          ),

        selectedToIata: z
          .string()
          .optional()
          .describe(
            "IATA code chosen by user for destination after ambiguity. e.g. 'DXB'",
          ),

        sessionId: z.string().optional(),
      }),

      // This tells the system this tool CAN render a widget
      _meta: { 
        ui: { resourceUri: "ui://widget/flight.html" }
      },
    },

    async (args, extra) => {
      const {
        from,
        to,
        date,
        adults = 1,
        children = 0,
        cabinClass = "CABIN_CLASS_ECONOMY",
        selectedFromIata,
        selectedToIata,
        sessionId: providedSessionId,
      } = args;

      const userCountry =
        extra?._meta?.["openai/userLocation"]?.country ||
        extra?.meta?.["openai/userLocation"]?.country ||
        "US";

      try {
        // ── Session management ────────────────────────────────────────────────
        const sessionId =
          providedSessionId ||
          `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        let session = sessions.get(sessionId) || {
          from,
          to,
          date,
          fromResolved: null,
          toResolved: null,
          fromCandidates: null,
          toCandidates: null,
          adults,
          children,
          cabinClass,
          userCountry,
        };

        session.from = from;
        session.to = to;
        session.date = date;
        session.adults = adults;
        session.children = children;
        session.cabinClass = cabinClass;
        session.userCountry = userCountry;

        // ── Handle user's IATA selections from previous ambiguity response ────
        if (selectedFromIata && !session.fromResolved) {
          const match = session.fromCandidates?.find(
            (a) => a.iataCode.toUpperCase() === selectedFromIata.toUpperCase(),
          );
          if (match) {
            session.fromResolved = match;
            session.fromCandidates = null;
          } else {
            const res = await resolveAirport(
              selectedFromIata,
              userCountry,
              true,
            );
            if (res.status === "resolved") {
              session.fromResolved = res.airport;
            } else {
              return replyText(
                `"${selectedFromIata}" is not a valid origin airport code. Please pick from the list shown.`,
              );
            }
          }
        }

        if (selectedToIata && !session.toResolved) {
          const match = session.toCandidates?.find(
            (a) => a.iataCode.toUpperCase() === selectedToIata.toUpperCase(),
          );
          if (match) {
            session.toResolved = match;
            session.toCandidates = null;
          } else {
            const res = await resolveAirport(
              selectedToIata,
              userCountry,
              false,
            );
            if (res.status === "resolved") {
              session.toResolved = res.airport;
            } else {
              return replyText(
                `"${selectedToIata}" is not a valid destination airport code. Please pick from the list shown.`,
              );
            }
          }
        }

        // ── Resolve airports if not already resolved ──
        if (!session.fromResolved || !session.toResolved) {
          const [fromRes, toRes] = await Promise.all([
            session.fromResolved
              ? Promise.resolve(null)
              : resolveAirport(session.from, userCountry, true),
            session.toResolved
              ? Promise.resolve(null)
              : resolveAirport(session.to, userCountry, false),
          ]);

          if (fromRes !== null) {
            if (fromRes.status === "resolved") {
              session.fromResolved = fromRes.airport;
            } else if (
              fromRes.status === "ambiguous" ||
              fromRes.status === "city_found"
            ) {
              session.fromCandidates = fromRes.airports;
            } else {
              return replyText(
                `Could not find an airport for "${session.from}". Please try a different city name or IATA code.`,
              );
            }
          }

          if (toRes !== null) {
            if (toRes.status === "resolved") {
              session.toResolved = toRes.airport;
            } else if (
              toRes.status === "ambiguous" ||
              toRes.status === "city_found"
            ) {
              session.toCandidates = toRes.airports;
            } else {
              return replyText(
                `Could not find an airport for "${session.to}". Please try a different city name or IATA code.`,
              );
            }
          }

          // If ambiguity exists, return options to user
          if (session.fromCandidates || session.toCandidates) {
            sessions.set(sessionId, session);
            return replyText(
              buildAmbiguityMessage(
                session.fromCandidates,
                session.toCandidates,
                session.from,
                session.to,
              ),
            );
          }
        }

        // Ensure both airports are resolved
        if (!session.fromResolved || !session.toResolved) {
          sessions.set(sessionId, session);
          return replyText(
            "Unable to resolve airports. Please provide valid city names or IATA codes.",
          );
        }

        // ── Fetch flights ────────────────────────────────────────────────────
        const result = await fetchFlights(
          session.fromResolved.iataCode,
          session.toResolved.iataCode,
          session.date,
          session.adults,
          session.children,
          session.cabinClass,
          session.fromResolved.entityId,
          session.toResolved.entityId,
          session.userCountry,
        );

        sessions.delete(sessionId);

        if (result.error) {
          return replyText(`Error searching flights: ${result.error}`);
        }

        if (!result.flights || result.flights.length === 0) {
          return replyText(
            `No flights found from ${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}.\n\nTry:\n• Nearby airports\n• A different travel date`,
          );
        }

        const sorted = sortFlights(result.flights);
        const withLinks = await attachShortLinks(sorted);
        const count = withLinks.length;

        // Show text results for ≤3 flights
        if (count <= 3) {
          const lines = withLinks
            .map(
              (f, i) =>
                `${i + 1}. ${f.airline || "Airline"} · ` +
                `${f.departureTime || ""}–${f.arrivalTime || ""} · ` +
                `${f.durationFormatted || ""} · ` +
                `${f.price?.formatted || f.price?.amount || "N/A"}`,
            )
            .join("\n");

          return replyText(
            `Found ${count} flight${count > 1 ? "s" : ""} from ` +
              `${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}:\n\n` +
              lines,
          );
        }

        // Show widget for 4+ flights
        const widgetData = formatFlightsForWidget(
          withLinks,
          session.fromResolved.iataCode,
          session.toResolved.iataCode,
          session.date,
          session.adults,
          session.children,
          session.userCountry,
        );

        return replyWithCard(
          `Found ${count} flights from ${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}.`,
          widgetData.flights,
          widgetData.searchParams,
        );
      } catch (error) {
        console.error("[search_flights] Error:", error);
        return replyText(
          `Something went wrong: ${error.message}. Please try again.`,
        );
      }
    },
  );

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 8787;
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS" && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, mcp-session-id",
      "Access-Control-Expose-Headers": "Mcp-Session-Id",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("✅ Flight MCP server is running");
    return;
  }

  if (url.pathname === MCP_PATH && req.method === "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createFlightServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP] Request error:", err);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`✅ Flight MCP server → http://localhost:${port}${MCP_PATH}`);
});