import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Import your API functions
import { fetchFlights, resolveAirportWithLogic } from './src/api/flightApi.js';
import { getDefaultDate, sortFlights, attachShortLinks, formatFlightsForWidget } from './src/utils/flightUtils.js';

// Read the widget HTML
const flightHtml = readFileSync("public/flight-widget.html", "utf8");

// In-memory session cache for airport resolution
const sessions = new Map();

// Helper to format response with widget
const replyWithFlights = (message, flights, searchParams = null) => ({
  content: message ? [{ type: "text", text: message }] : [],
  structuredContent: flights ? { 
    flights,
    searchParams 
  } : { flights: [] },
  _meta: {
    ui: {
      resourceUri: "ui://widget/flight.html"
    }
  }
});

// Create MCP server
function createFlightServer() {
  const server = new McpServer({ 
    name: "flight-search-app", 
    version: "1.0.0" 
  });

  // Register the widget resource
  registerAppResource(
    server,
    "flight-widget",
    "ui://widget/flight.html",
    {},
    async () => ({
      contents: [{
        uri: "ui://widget/flight.html",
        mimeType: RESOURCE_MIME_TYPE,
        text: flightHtml,
      }],
    })
  );

  // Register the search_flights tool
  registerAppTool(
    server,
    "search_flights",
    {
      title: "Search Flights",
      description: "Search for flights between two cities. Pass city names or IATA codes. If ambiguous, you'll get options to choose from.",
      inputSchema: {
        from: z.string().min(1).describe("Origin city name or IATA code (e.g., 'Goa' or 'GOI')"),
        to: z.string().min(1).describe("Destination city name or IATA code (e.g., 'New York' or 'JFK')"),
        date: z.string().optional().describe("Travel date in YYYY-MM-DD format"),
        adults: z.number().optional().default(1).describe("Number of adults"),
        children: z.number().optional().default(0).describe("Number of children"),
        cabinClass: z.enum(["CABIN_CLASS_ECONOMY", "CABIN_CLASS_PREMIUM_ECONOMY", "CABIN_CLASS_BUSINESS", "CABIN_CLASS_FIRST"])
          .optional().default("CABIN_CLASS_ECONOMY").describe("Cabin class"),
        selectedFromIata: z.string().optional().describe("IATA code for origin if from ambiguous list"),
        selectedToIata: z.string().optional().describe("IATA code for destination if from ambiguous list"),
        userCountry: z.string().optional().default("US").describe("User's country code for currency")
      },
      _meta: {
        ui: { resourceUri: "ui://widget/flight.html" }
      }
    },
    async (args) => {
      const { 
        from, 
        to, 
        date = getDefaultDate(), 
        adults = 1, 
        children = 0, 
        cabinClass = "CABIN_CLASS_ECONOMY",
        selectedFromIata,
        selectedToIata,
        userCountry = "US"
      } = args;

      // Create a session ID based on the conversation (simplified)
      const sessionId = `${from}-${to}-${date}`;
      
      try {
        console.log(`Searching flights: ${from} → ${to} on ${date}`);

        // Check if we have a session with airport candidates
        let session = sessions.get(sessionId);
        
        // Handle airport resolution
        let fromIata = selectedFromIata || from;
        let toIata = selectedToIata || to;
        let fromEntityId = null;
        let toEntityId = null;

        // If we have selected IATAs, resolve them
        if (selectedFromIata) {
          const resolution = await resolveAirportWithLogic(selectedFromIata);
          if (resolution.status === "resolved") {
            fromEntityId = resolution.airport.entityId;
            fromIata = resolution.airport.iataCode;
          }
        }

        if (selectedToIata) {
          const resolution = await resolveAirportWithLogic(selectedToIata);
          if (resolution.status === "resolved") {
            toEntityId = resolution.airport.entityId;
            toIata = resolution.airport.iataCode;
          }
        }

        // If no selected IATAs, try to resolve normally
        if (!selectedFromIata && !selectedToIata) {
          const [fromResolution, toResolution] = await Promise.all([
            resolveAirportWithLogic(from),
            resolveAirportWithLogic(to)
          ]);

          // Handle ambiguous cases
          if (fromResolution.status === "ambiguous") {
            sessions.set(sessionId, { fromCandidates: fromResolution.airports });
            const airportsList = fromResolution.airports
              .map(a => `• ${a.name} (${a.iataCode}) — ${a.cityName}, ${a.countryName}`)
              .join('\n');
            
            return replyWithFlights(
              `Multiple airports found for "${from}". Please choose one:\n\n${airportsList}\n\nUse selectedFromIata parameter with the IATA code.`,
              null
            );
          }

          if (toResolution.status === "ambiguous") {
            sessions.set(sessionId, { toCandidates: toResolution.airports });
            const airportsList = toResolution.airports
              .map(a => `• ${a.name} (${a.iataCode}) — ${a.cityName}, ${a.countryName}`)
              .join('\n');
            
            return replyWithFlights(
              `Multiple airports found for "${to}". Please choose one:\n\n${airportsList}\n\nUse selectedToIata parameter with the IATA code.`,
              null
            );
          }

          if (fromResolution.status === "resolved") {
            fromEntityId = fromResolution.airport.entityId;
            fromIata = fromResolution.airport.iataCode;
          }

          if (toResolution.status === "resolved") {
            toEntityId = toResolution.airport.entityId;
            toIata = toResolution.airport.iataCode;
          }

          if (fromResolution.status === "not_found" || toResolution.status === "not_found") {
            return replyWithFlights(
              `Could not find airport for "${fromResolution.status === 'not_found' ? from : to}". Please try a different name or IATA code.`,
              null
            );
          }
        }

        // Validate same airport
        if (fromIata === toIata) {
          return replyWithFlights(
            "Origin and destination airports cannot be the same. Please select different airports.",
            null
          );
        }

        // Fetch real flights
        const result = await fetchFlights(
          fromIata,
          toIata,
          date,
          adults,
          children,
          cabinClass,
          fromEntityId,
          toEntityId,
          userCountry
        );

        // Sort flights
        const sortedFlights = sortFlights(result.flights);
        
        // Attach short links
        const flightsWithLinks = await attachShortLinks(sortedFlights);

        // Format for widget
        const widgetData = formatFlightsForWidget(
          flightsWithLinks,
          fromIata,
          toIata,
          date,
          adults,
          children,
          userCountry
        );

        // Clear session
        sessions.delete(sessionId);

        const message = flightsWithLinks.length > 0 
          ? `Found ${flightsWithLinks.length} flights from ${fromIata} to ${toIata}`
          : `No flights found from ${fromIata} to ${toIata}`;

        return replyWithFlights(message, widgetData.flights, widgetData.searchParams);

      } catch (error) {
        console.error("Flight search error:", error);
        return replyWithFlights(
          `Error searching flights: ${error.message}`,
          null
        );
      }
    }
  );

  return server;
}

// Set up HTTP server
const port = process.env.PORT || 8787;
const MCP_PATH = "/mcp";

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // Handle CORS preflight
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

  // Health check
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" })
      .end("Flight MCP server is running");
    return;
  }

  // Handle MCP requests
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
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(port, () => {
  console.log(`✅ Flight MCP server running at http://localhost:${port}${MCP_PATH}`);
  console.log(`📋 Widget available at http://localhost:${port}/public/flight-widget.html (for testing)`);
  console.log(`🔍 Environment: ${process.env.NODE_ENV || 'development'}`);
});