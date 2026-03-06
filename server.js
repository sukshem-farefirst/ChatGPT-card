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
//
// KEY RULES:
//   replyText       → ALWAYS plain text. NO _meta.ui, NO structuredContent.
//                     ChatGPT will NOT render the widget for these responses.
//
//   replyWithCard   → ONLY called when flights.length > 3.
//                     MUST include content[] (MCP requires it).
//                     Includes structuredContent + _meta so widget renders.
// ─────────────────────────────────────────────────────────────────────────────

// Pure text — widget will NEVER render for this response
const replyText = (message) => ({
  content: [{ type: "text", text: message }],
  // ⛔ NO structuredContent
  // ⛔ NO _meta
});

// Card UI — widget renders ONLY for this response (flights > 3)
const replyWithCard = (message, flights, searchParams) => ({
  // content[] is REQUIRED by MCP spec — without it some hosts break
  content: [{ type: "text", text: message }],
  structuredContent: { flights, searchParams },
  _meta: {
    ui: { resourceUri: "ui://widget/flight.html" },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP Server factory
// ─────────────────────────────────────────────────────────────────────────────
function createFlightServer() {
  const server = new McpServer({
    name: "flight-search-app",
    version: "2.0.0",
  });

  // Register widget resource
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
    })
  );

  // ── search_flights tool ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "search_flights",
    {
      title: "Search Flights",
      description: [
        "Search one-way flights between two airports on a given date.",
        "STEP 1: Collect from, to, and date from the user before calling this tool.",
        "STEP 2: Call autosuggest server-side — do not call the tool without all 3 fields.",
        "STEP 3: If airport is ambiguous, tool returns a list. Ask the user to pick, then call again with selectedFromEntityId or selectedToEntityId.",
        "STEP 4: Flight card UI is shown ONLY when more than 3 flights are found.",
        "For all other responses (validation, ambiguity, errors) only plain text is returned — do NOT render the widget.",
      ].join(" "),

      // z.object() required — registerAppTool calls .safeParseAsync() internally
      inputSchema: z.object({
        from: z.string().min(1).optional().describe("Origin city name or IATA code"),
        to: z.string().min(1).optional().describe("Destination city name or IATA code"),
        date: z.string().optional().describe("Travel date YYYY-MM-DD"),
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
        selectedFromEntityId: z
          .string()
          .optional()
          .describe("entityId chosen by user when origin was ambiguous"),
        selectedToEntityId: z
          .string()
          .optional()
          .describe("entityId chosen by user when destination was ambiguous"),
        sessionId: z.string().optional(),
      }),

      // _meta.ui tells ChatGPT this tool CAN show a widget
      // The widget only actually renders when the response includes structuredContent
      _meta: { ui: { resourceUri: "ui://widget/flight.html" } },
    },

    async (args, extra) => {
      const {
        from,
        to,
        date,
        adults = 1,
        children = 0,
        cabinClass = "CABIN_CLASS_ECONOMY",
        selectedFromEntityId,
        selectedToEntityId,
        sessionId: providedSessionId,
      } = args;

      // Detect user country
      const userCountry =
        extra?._meta?.["openai/userLocation"]?.country ||
        extra?.meta?.["openai/userLocation"]?.country ||
        "US";

      try {
        // ── STEP 1: Require all 3 fields before doing anything ──────────────
        // Return plain text — no widget
        if (!from && !to && !date && !selectedFromEntityId && !selectedToEntityId) {
          return replyText(
            "Hi! I can help you search for flights. Please tell me:\n" +
              "• Where are you flying from?\n" +
              "• Where are you flying to?\n" +
              "• What date? (YYYY-MM-DD)"
          );
        }

        const sessionId =
          providedSessionId ||
          `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        let session = sessions.get(sessionId) || {
          from: null,
          to: null,
          date: null,
          fromCandidates: null,
          toCandidates: null,
          fromResolved: null,
          toResolved: null,
          adults,
          children,
          cabinClass,
          userCountry,
        };

        if (from) session.from = from;
        if (to) session.to = to;
        if (date) session.date = date;
        session.adults = adults;
        session.children = children;
        session.cabinClass = cabinClass;
        session.userCountry = userCountry;

        // Missing fields → plain text, no widget
        if (!session.from || !session.to || !session.date) {
          const missing = [];
          if (!session.from) missing.push("origin city or airport");
          if (!session.to) missing.push("destination city or airport");
          if (!session.date) missing.push("travel date (YYYY-MM-DD)");
          return replyText(
            `Please provide:\n` + missing.map((m) => `• ${m}`).join("\n")
          );
        }

        // Date validation → plain text, no widget
        if (!/^\d{4}-\d{2}-\d{2}$/.test(session.date)) {
          return replyText(
            `Invalid date format "${session.date}". Please use YYYY-MM-DD (e.g. 2026-03-15).`
          );
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(session.date) < today) {
          return replyText(
            `Travel date ${session.date} is in the past. Please choose a future date.`
          );
        }

        // Passenger cap → plain text, no widget
        if (adults + children > 9) {
          return replyText(
            `Maximum 9 passengers. You entered ${adults + children}. Please reduce the count.`
          );
        }

        // ── STEP 2: Resolve FROM airport ─────────────────────────────────────
        // Autosuggest only called now that all 3 fields are present & valid
        if (selectedFromEntityId && !session.fromResolved) {
          const match = session.fromCandidates?.find(
            (a) => a.entityId === selectedFromEntityId
          );
          if (match) {
            session.fromResolved = match;
            session.fromCandidates = null;
          } else {
            return replyText("Invalid origin selection. Please choose from the list provided.");
          }
        }

        if (!session.fromResolved) {
          const resolution = await resolveAirport(session.from, userCountry, true);

          if (resolution.status === "ambiguous" || resolution.status === "city_found") {
            // Multiple airports → ask user → plain text, no widget
            session.fromCandidates = resolution.airports;
            sessions.set(sessionId, session);
            return replyText(
              resolution.formattedMessage ||
                `Multiple airports found for "${session.from}":\n\n` +
                resolution.airports
                  .map((a) => `• **${a.iataCode}** — ${a.name}, ${a.cityName}`)
                  .join("\n") +
                "\n\nPlease reply with the IATA code you'd like to depart from."
            );
          }

          if (resolution.status === "not_found") {
            return replyText(
              `Could not find airport for "${session.from}". Please try a more specific name or IATA code.`
            );
          }

          if (resolution.status === "resolved") {
            session.fromResolved = resolution.airport;
          }
        }

        // ── STEP 3: Resolve TO airport ────────────────────────────────────────
        if (selectedToEntityId && !session.toResolved) {
          const match = session.toCandidates?.find(
            (a) => a.entityId === selectedToEntityId
          );
          if (match) {
            session.toResolved = match;
            session.toCandidates = null;
          } else {
            return replyText("Invalid destination selection. Please choose from the list provided.");
          }
        }

        if (!session.toResolved) {
          const resolution = await resolveAirport(session.to, userCountry, false);

          if (resolution.status === "ambiguous" || resolution.status === "city_found") {
            // Multiple airports → ask user → plain text, no widget
            session.toCandidates = resolution.airports;
            sessions.set(sessionId, session);
            return replyText(
              resolution.formattedMessage ||
                `Multiple airports found for "${session.to}":\n\n` +
                resolution.airports
                  .map((a) => `• **${a.iataCode}** — ${a.name}, ${a.cityName}`)
                  .join("\n") +
                "\n\nPlease reply with the IATA code you'd like to fly to."
            );
          }

          if (resolution.status === "not_found") {
            return replyText(
              `Could not find airport for "${session.to}". Please try a more specific name or IATA code.`
            );
          }

          if (resolution.status === "resolved") {
            session.toResolved = resolution.airport;
          }
        }

        // Both airports must be resolved before API call
        if (!session.fromResolved || !session.toResolved) {
          sessions.set(sessionId, session);
          return replyText("Still resolving airports. Please continue with your selections.");
        }

        // Same airport guard → plain text, no widget
        if (session.fromResolved.iataCode === session.toResolved.iataCode) {
          return replyText(
            "Origin and destination cannot be the same airport. Please choose different airports."
          );
        }

        // ── STEP 4 & 5: Both resolved → call flights create API ───────────────
        const result = await fetchFlights(
          session.fromResolved.iataCode,
          session.toResolved.iataCode,
          session.date,
          session.adults,
          session.children,
          session.cabinClass,
          session.fromResolved.entityId,
          session.toResolved.entityId,
          session.userCountry
        );

        sessions.delete(sessionId);

        if (result.error) {
          return replyText(`Error searching flights: ${result.error}`);
        }

        if (!result.flights || result.flights.length === 0) {
          return replyText(
            `No flights found from ${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}.\n\n` +
              `Try:\n• Nearby airports\n• A different travel date`
          );
        }

        const sortedFlights = sortFlights(result.flights);
        const flightsWithLinks = await attachShortLinks(sortedFlights);
        const count = flightsWithLinks.length;

        // ── STEP 6: Card UI ONLY when > 3 flights ─────────────────────────────
        if (count <= 3) {
          // Few results → plain text only, NO widget
          const lines = flightsWithLinks
            .map(
              (f, i) =>
                `${i + 1}. ${f.airline || "Airline"} · ` +
                `${f.departureTime || ""}–${f.arrivalTime || ""} · ` +
                `${f.durationFormatted || ""} · ` +
                `${f.price?.formatted || f.price?.amount || "N/A"}`
            )
            .join("\n");
          return replyText(
            `Found ${count} flight${count > 1 ? "s" : ""} from ` +
              `${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}:\n\n` +
              lines
          );
        }

        // More than 3 → format and return card UI
        const widgetData = formatFlightsForWidget(
          flightsWithLinks,
          session.fromResolved.iataCode,
          session.toResolved.iataCode,
          session.date,
          session.adults,
          session.children,
          session.userCountry
        );

        return replyWithCard(
          `Found ${count} flights from ${session.fromResolved.iataCode} to ${session.toResolved.iataCode} on ${session.date}.`,
          widgetData.flights,
          widgetData.searchParams
        );

      } catch (error) {
        console.error("[search_flights] Error:", error);
        return replyText(`Something went wrong: ${error.message}. Please try again.`);
      }
    }
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