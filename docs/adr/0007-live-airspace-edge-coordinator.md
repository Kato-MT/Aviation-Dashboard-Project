# ADR 0007: Regional live airspace through an edge coordinator

- Status: Accepted for v3.0 implementation
- Date: 2026-08-27

## Context

Version 2.2 is a static browser workbench for synthetic telemetry diagnostics. Version 3.0 adds a separate live-airspace experience using public ADS-B surveillance observations. Browsers must not call a third-party provider directly because direct calls would duplicate provider load for every viewer, expose the provider contract throughout the UI, and make rate limiting and failure behavior inconsistent.

Public ADS-B observations are also a different data domain from the synthetic diagnostic lab. They describe received surveillance messages and feed freshness. They are not onboard maintenance, airworthiness, safety, or certified operational telemetry.

## Decision

Use one Cloudflare Worker deployment for the application assets and `/api/v1` routes. Route each fixed Georgia region to one SQLite-backed Durable Object. The Durable Object:

- accepts hibernatable WebSocket clients;
- performs one shared provider request at a time;
- polls only while regional viewers are connected;
- uses an on-demand poll for snapshot requests without creating an idle polling loop;
- enforces timeout, Retry-After, exponential backoff, and circuit-breaker state;
- retains the latest snapshot only in memory;
- persists control state and hourly aggregate feed metrics only;
- deletes aggregate metric hours older than 30 days.

The browser starts with a validated HTTP snapshot and then consumes versioned WebSocket snapshots and health messages. Browser trails are bounded and exist only for the current session. Changing regions starts a new session and clears all aircraft evidence.

Only the three checked-in region presets are accepted. The product does not proxy arbitrary coordinates, offer military-only endpoints, resolve owners, predict routes, or create persistent aircraft watchlists.

## Provider decision

ADSB.lol is the initial adapter because its public API and public data are documented under ODbL 1.0. The integration uses only the regional point endpoint. Its official API documentation says rate limits are dynamic and asks production users to contact the operator, so production enablement remains a release gate rather than an assumed service-level agreement.

The normalized contract and provider interface remain independent of ADSB.lol. A replacement provider must receive its own licensing, privacy, field-mapping, failure, and load review before activation.

## Consequences

### Positive

- One upstream poll can serve many viewers.
- Provider failures become explicit product states instead of browser-specific exceptions.
- Fixed regions and strict contracts reduce proxy abuse.
- The interface can preserve the last valid snapshot during recoverable degradation.
- No application database of aircraft movements is created.

### Costs and constraints

- Live Airspace requires the network and the edge service; the synthetic lab remains the offline capability.
- Durable Object alarms have at-least-once behavior, so polling and metrics must remain idempotent and guarded by one in-flight promise.
- The public provider has no project-owned availability guarantee.
- ODbL attribution and production-provider coordination must be checked again for every release.
- Deployment credentials and provider contact remain user-controlled external gates.

## Primary references

- [ADSB.lol public API](https://api.adsb.lol/)
- [ADSB.lol API and ODbL documentation](https://www.adsb.lol/docs/open-data/api/)
- [Cloudflare Durable Object WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
