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
});

const replyWithCard = (message, flights, searchParams) => ({
  content: [{ type: "text", text: message }],
  structuredContent: { flights, searchParams },
  _meta: { ui: { resourceUri: "ui://widget/flight.html" } },
});

// ─────────────────────────────────────────────────────────────────────────────
// Build the combined ambiguity message for BOTH airports in one response
// so the user sees everything they need to answer in a single message
// ─────────────────────────────────────────────────────────────────────────────
function buildAmbiguityMessage(fromAmbiguous, toAmbiguous, fromTerm, toTerm) {
  let msg = `✈️ I found multiple airports. Please confirm which ones you'd like:\n\n`;

  if (fromAmbiguous) {
    msg += `**From "${fromTerm}":**\n`;
    fromAmbiguous.forEach((a) => {
      const name = a.name.replace(a.cityName || "", "").replace(/\s*\(.*?\)\s*/g, "").trim() || a.name;
      msg += `👉 **${a.iataCode}** — ${name}, ${a.cityName}\n`;
    });
  }

  if (toAmbiguous) {
    if (fromAmbiguous) msg += `\n`;
    msg += `**To "${toTerm}":**\n`;
    toAmbiguous.forEach((a) => {
      const name = a.name.replace(a.cityName || "", "").replace(/\s*\(.*?\)\s*/g, "").trim() || a.name;
      msg += `👉 **${a.iataCode}** — ${name}, ${a.cityName}\n`;
    });
  }

  msg += `\nReply with the IATA code(s) you'd like`;

  if (fromAmbiguous && toAmbiguous) {
    msg += ` for both, e.g. **${fromAmbiguous[0].iataCode}** to **${toAmbiguous[0].iataCode}**.`;
  } else if (fromAmbiguous) {
    msg += `, e.g. **${fromAmbiguous[0].iataCode}**.`;
  } else {
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
    })
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
        "        Ask: 'Where are you flying from, to, and on what date?'",
        "        Wait for the user to provide all 3 before calling the tool.",
        "RULE 3: DO NOT call the tool with only 1 or 2 fields filled.",
        "RULE 4: DO NOT guess or assume from, to, or date.",
        "RULE 5: DO NOT call this tool for greetings or vague travel statements.",
        "RULE 6: Once all 3 are provided, call this tool ONCE with all 3 fields.",
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
        "WRONG: User says 'I want to travel'",
        "       → DO NOT call tool. Ask for from, to, and date first.",
        "",
        "WRONG: User says 'from New York to Dubai'",
        "       → DO NOT call tool yet. Date is missing. Ask for date.",
        "",
        "WRONG: Call tool with from='New York', to='Dubai', date='' or date=undefined",
        "       → NEVER do this.",
      ].join("\n"),

      inputSchema: z.object({
        from: z
          .string()
          .min(1)
          .describe("Origin — provided by user. NEVER call without this."),

        to: z
          .string()
          .min(1)
          .describe("Destination — provided by user. NEVER call without this."),

        date: z
          .string()
          .describe("Travel date YYYY-MM-DD — provided by user. NEVER call without this."),

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

        // Set ONLY after the server returned an ambiguity message
        selectedFromIata: z
          .string()
          .optional()
          .describe("IATA code chosen by user for origin after ambiguity. e.g. 'JFK'"),

        selectedToIata: z
          .string()
          .optional()
          .describe("IATA code chosen by user for destination after ambiguity. e.g. 'DXB'"),

        sessionId: z.string().optional(),
      }),

      // _meta is REQUIRED by registerAppTool from @modelcontextprotocol/ext-apps.
      // The SDK reads _meta.ui internally and crashes with 'Cannot read properties
      // of undefined (reading ui)' if _meta is missing.
      // The blank card space is prevented in the widget HTML via the
      // handleToolResult guard: only renders when structuredContent.flights exists.
      _meta: { ui: { resourceUri: 'ui://widget/flight.html' } },
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
        // ── HARD GATE: ALL 3 fields required before anything runs ─────────────
        // If the LLM breaks RULE 1-5 and calls without all 3, we reject here
        if (!from || !to || !date) {
          const missing = [];
          if (!from)  missing.push("• origin city or airport (from)");
          if (!to)    missing.push("• destination city or airport (to)");
          if (!date)  missing.push("• travel date in YYYY-MM-DD format");

          return replyText(
            `I cannot search flights yet. Please collect the following from the user first:\n\n` +
              missing.join("\n") +
              `\n\nDo NOT call this tool again until all three are provided by the user.`
          );
        }

        // ── Date validation ───────────────────────────────────────────────────
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return replyText(
            `Invalid date format "${date}". Ask the user for the date in YYYY-MM-DD format (e.g. 2026-05-10).`
          );
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (new Date(date) < today) {
          return replyText(`Travel date ${date} is in the past. Please ask for a future date.`);
        }

        const maxDate = new Date();
        maxDate.setFullYear(maxDate.getFullYear() + 1);
        if (new Date(date) > maxDate) {
          return replyText(`Travel date ${date} is more than 1 year away. Please choose a closer date.`);
        }

        if (adults + children > 9) {
          return replyText(`Maximum 9 passengers. You entered ${adults + children}. Please reduce.`);
        }

        // ── Session ───────────────────────────────────────────────────────────
        const sessionId =
          providedSessionId ||
          `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        let session = sessions.get(sessionId) || {
          from, to, date,
          fromResolved: null,
          toResolved: null,
          fromCandidates: null,
          toCandidates: null,
          adults, children, cabinClass, userCountry,
        };

        session.from  = from;
        session.to    = to;
        session.date  = date;
        session.adults     = adults;
        session.children   = children;
        session.cabinClass = cabinClass;
        session.userCountry = userCountry;

        // ── Handle user's IATA selections from previous ambiguity response ────
        if (selectedFromIata && !session.fromResolved) {
          const match = session.fromCandidates?.find(
            (a) => a.iataCode.toUpperCase() === selectedFromIata.toUpperCase()
          );
          if (match) {
            session.fromResolved = match;
            session.fromCandidates = null;
          } else {
            // IATA not in candidates — try resolving it directly
            const res = await resolveAirport(selectedFromIata, userCountry, true);
            if (res.status === "resolved") {
              session.fromResolved = res.airport;
            } else {
              return replyText(
                `"${selectedFromIata}" is not a valid origin airport code. Please pick from the list shown.`
              );
            }
          }
        }

        if (selectedToIata && !session.toResolved) {
          const match = session.toCandidates?.find(
            (a) => a.iataCode.toUpperCase() === selectedToIata.toUpperCase()
          );
          if (match) {
            session.toResolved = match;
            session.toCandidates = null;
          } else {
            const res = await resolveAirport(selectedToIata, userCountry, false);
            if (res.status === "resolved") {
              session.toResolved = res.airport;
            } else {
              return replyText(
                `"${selectedToIata}" is not a valid destination airport code. Please pick from the list shown.`
              );
            }
          }
        }

        // ── AUTOSUGGEST: Run BOTH airports in parallel, ONCE, after all 3 fields confirmed ──
        // Only called when not already resolved
        if (!session.fromResolved || !session.toResolved) {
          const [fromRes, toRes] = await Promise.all([
            session.fromResolved
              ? Promise.resolve(null)
              : resolveAirport(session.from, userCountry, true),
            session.toResolved
              ? Promise.resolve(null)
              : resolveAirport(session.to, userCountry, false),
          ]);

          // Process FROM result
          if (fromRes !== null) {
            if (fromRes.status === "resolved") {
              session.fromResolved = fromRes.airport;
            } else if (fromRes.status === "ambiguous" || fromRes.status === "city_found") {
              session.fromCandidates = fromRes.airports;
            } else {
              return replyText(
                `Could not find an airport for "${session.from}". Please try a different city name or IATA code.`
              );
            }
          }

          // Process TO result
          if (toRes !== null) {
            if (toRes.status === "resolved") {
              session.toResolved = toRes.airport;
            } else if (toRes.status === "ambiguous" || toRes.status === "city_found") {
              session.toCandidates = toRes.airports;
            } else {
              return replyText(
                `Could not find an airport for "${session.to}". Please try a different city name or IATA code.`
              );
            }
          }

          // ── If EITHER or BOTH are ambiguous → concatenate into ONE message ──
          // This is the key fix: both ambiguities shown together in one response
          if (session.fromCandidates || session.toCandidates) {
            sessions.set(sessionId, session);

            return replyText(
              buildAmbiguityMessage(
                session.fromCandidates,
                session.toCandidates,
                session.from,
                session.to
              )
            );
          }
        }

        // ── Both must be resolved to continue ─────────────────────────────────
        if (!session.fromResolved || !session.toResolved) {
          sessions.set(sessionId, session);
          return replyText(
            "Still waiting for airport selections. Please reply with the IATA codes from the list above."
          );
        }

        // Same airport guard
        if (session.fromResolved.iataCode === session.toResolved.iataCode) {
          return replyText(
            "Origin and destination cannot be the same airport. Please choose different airports."
          );
        }

        // ── STEP 5: Both resolved → call flights create API ───────────────────
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

        const sorted    = sortFlights(result.flights);
        const withLinks = await attachShortLinks(sorted);
        const count     = withLinks.length;

        // ── STEP 6: Card UI ONLY when > 3 flights ─────────────────────────────
        if (count <= 3) {
          const lines = withLinks
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

        const widgetData = formatFlightsForWidget(
          withLinks,
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
      "Access-Control-Allow-Origin":   "*",
      "Access-Control-Allow-Methods":  "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers":  "content-type, mcp-session-id",
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
    res.setHeader("Access-Control-Allow-Origin",   "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server    = createFlightServer();
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