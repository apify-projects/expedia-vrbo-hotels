# Expedia Scraper - Vrbo & Hotels.com Property Data

Scrape hotel and vacation-rental listings from Expedia, Vrbo, and Hotels.com without a login or API keys, for travel market research, competitor tracking, and building property datasets.

## What does this actor do?

Paste property URLs from any of the three sites, mixed in one list, and get one structured dataset item per URL. All three belong to Expedia Group and share a backend, so you don't sort your URLs by site or run three different scrapers.

- 🏨 **Full listing detail** - name, description, address, coordinates, rating, review count
- 🖼️ **Every photo** with its caption, plus the thumbnail
- 🛏️ **Room and unit breakdown** - each with its own photos, bed types, and amenities
- 📋 **Amenities, policies, house rules** - check-in times, pets, smoking, events
- 🔀 **Any mix of the three sites** in a single run, platform detected per URL
- 🔁 **Residential proxy rotation** and retries built in, nothing to configure

## ⬇️ Input

### Example

```json
{
    "urls": [
        "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information",
        "https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/",
        "https://www.vrbo.com/en-gb/p11348801"
    ]
}
```

### Which URLs work

| Site | Paste this |
| --- | --- |
| Expedia | a hotel page - `expedia.com/....h525006.Hotel-Information`, and the international domains (`.co.uk`, `.de`, `.it`, ...) |
| Hotels.com | a property page - `hotels.com/ho136900/...`, including `uk.hotels.com` and locale paths like `/de/ho136900/` |
| Vrbo | a listing page - `vrbo.com/en-gb/p11348801`, or a bare id like `vrbo.com/117898910` |
| any of them | a search page with one property open, which puts `selected=<id>` in the URL - that property is the one scraped |

A search page with nothing selected names no property, so it is rejected with a message saying so.

Duplicate URLs pointing at the same property are scraped once. A URL that can't be used gets its own item explaining why, and the rest of the run carries on.

## ⬆️ Output

One item per URL, the same shape whichever site it came from.

### Example

```json
{
    "platform": "expedia",
    "url": "https://www.expedia.com/Prague-Hotels-Pentahotel-Prague.h525006.Hotel-Information",
    "id": "525006",
    "name": "Hotel PULSE8",
    "city": "Prague",
    "country": "CZE",
    "latitude": 50.09477,
    "longitude": 14.45477,
    "rating": 9,
    "reviewCount": 867,
    "images": [{ "url": "https://images.trvl-media.com/lodging/...", "description": "Serves breakfast, lunch, and dinner" }],
    "amenities": [{ "title": "Internet", "items": ["Available in all rooms: Free WiFi"] }],
    "houseRules": { "checkInTime": null, "checkOutTime": null, "petsAllowed": true },
    "units": [{ "name": "Double Balcony", "bedTypes": [{ "type": "King", "count": 1 }] }],
    "scrapedAt": "2026-09-15T18:22:41.106Z"
}
```

A URL that fails gets an error item instead, with `platform`, `url`, `id`, and `error`.

Anything the site doesn't publish is `null`, never a zero or an empty string, so "no rating yet" is distinguishable from "rated 0".

## FAQ

### Can I scrape a whole city, or a search page?

No. Give it the property URLs you want and it returns one item each.

### Do I need an account on any of the sites?

No. Only public listing data is read, the same as any visitor sees.

### Does it collect personal data?

No. Reviews, reviewer names, and host details are not part of the output.

### Can I use it with integrations like Zapier, Make, or n8n?

Yes. Every Apify Actor supports Schedules, webhooks, and the Apify integrations catalogue: Zapier, Make, n8n, Slack, Google Sheets, LangChain.

### Can I use it through an MCP server?

Yes. Every Apify Actor is reachable through the Apify MCP server, so an MCP-capable agent can run it as a tool.

### Is it legal to scrape this data?

Scraping publicly available data is generally legal, and this Actor reads only public listing pages and collects no personal data. You are responsible for what you do with the output. See our post on [the legality of web scraping](https://blog.apify.com/is-web-scraping-legal/), and consult a lawyer if unsure.

## Your feedback

Missing a field or hitting a bug? Open the Issues tab. Custom work is available through [Apify's custom solutions](https://apify.com/custom-solutions) team.

### Disclaimer

This Actor is an independent tool and is not affiliated with, endorsed by, or sponsored by Expedia Group, Inc. or any of its subsidiaries, including Expedia, Vrbo, and Hotels.com.
