# Expedia / Hotels.com Reviews Scraper

Scrapes guest reviews from any hotel, apartment or other accommodation listed on Expedia, Hotels.com or Vrbo. Give it a property page URL and it returns every review on that property, not just the first page.

## Input

Paste the URL of a property detail page, for example:

```raw
https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information
https://www.hotels.com/ho136900/hilton-prague-old-town-prague-czech-republic/
https://www.expedia.it/en/Berchtesgaden-Hotels-Alpensport-Hotel-Seimler.h2692552.Hotel-Information
https://www.vrbo.com/2506673
```

Regional domains of the same brands work too, such as `expedia.it`, `expedia.com.tw`, `de.hotels.com` or `hoteis.com`. Extra query parameters are ignored, so you can paste a link straight from your browser.

A URL copied straight out of a search result carries an `expediaPropertyId` parameter, and the Actor reads the property from there instead of loading the listing page - one request less per property, and no rate limiting to wait out on Vrbo.

| Field                | Description                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `startUrls`          | Property page URLs. Anything in a URL's `userData` comes back on each of its reviews as `customData`.          |
| `maxReviewsPerHotel` | Cap on reviews per property. Leave empty to take all of them.                                                  |
| `sortBy`             | Most relevant, Most recent, Highest guest rating, or Lowest guest rating.                                      |
| `minDate`            | Skip reviews older than this date. Needs `sortBy` set to Most recent, since only that order runs newest-first. |
| `debugLog`           | Verbose logging, for working out why a run behaved unexpectedly.                                               |

### Tagging reviews with your own data

Open **Advanced** on a start URL and add any JSON under `userData`. It is copied onto every review from that property as `customData`, which makes reviews easy to attribute when one run covers many properties:

```json
{
    "url": "https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information",
    "userData": { "internalId": 4711, "city": "Prague" }
}
```

## Output

Each review is one dataset item:

```json
{
    "reviewId": "63f2848ddb4e6119d60c3d51",
    "hotelId": "10966026",
    "propertyUrl": "https://www.expedia.com/Prague-Hotels-Hotel-Krystal.h10966026.Hotel-Information",
    "reviewPosition": 26,
    "publishedDate": "2023-02-19",
    "rating": 8,
    "ratingText": "Good",
    "title": null,
    "text": "Nice hotel near the airport with a great restaurant. The wifi, however, was non-existent.",
    "locale": "fr_BE",
    "isTranslated": true,
    "authorName": "Diana",
    "authorCountryCode": "BE",
    "nightsStayed": 1,
    "stayedMonth": "2023-02",
    "helpfulVoteCount": 0,
    "likedThemes": ["Cleanliness", "Staff & service"],
    "dislikedThemes": ["Amenities"],
    "photoUrls": [],
    "managementResponses": [
        {
            "authorName": "Helena",
            "publishedDate": "2023-03-06",
            "text": "Dear Diana, thank you for your feedback! Hotel Krystal"
        }
    ],
    "customData": { "internalId": 4711, "city": "Prague" }
}
```

| Field                 | Notes                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| `reviewId`            | Expedia's own review id.                                                               |
| `hotelId`             | The property id the review belongs to, not the number in a Hotels.com URL.             |
| `propertyUrl`         | The property page the review came from, with any tracking parameters stripped.         |
| `reviewPosition`      | Rank in the chosen sort order, counted across all pages from 1.                        |
| `publishedDate`       | ISO date the review was submitted.                                                     |
| `rating`              | Score out of 10, as a number. Both brands use a 10-point scale.                        |
| `ratingText`          | Expedia's wording for that score, such as `Good` or `Exceptional`.                     |
| `title`, `text`       | `null` when the guest left only a rating, which is common.                             |
| `locale`              | Language the review was written in, such as `de_DE`.                                   |
| `isTranslated`        | Whether Expedia is showing a machine translation.                                      |
| `authorName`          | First name only; that is all Expedia publishes.                                        |
| `authorCountryCode`   | Two-letter country code, uppercased. `null` on Expedia, which does not publish it.     |
| `nightsStayed`        | Length of the stay.                                                                    |
| `stayedMonth`         | Month of the stay as `YYYY-MM`. `null` on Hotels.com, which does not publish it.       |
| `helpfulVoteCount`    | Guests who marked the review helpful. `null` on Hotels.com, which does not publish it. |
| `likedThemes`         | What the guest praised, split out of Expedia's single label.                           |
| `dislikedThemes`      | Same, for complaints.                                                                  |
| `photoUrls`           | Guest photos, usually empty.                                                           |
| `managementResponses` | The property's replies, with the author and date parsed out of the header.             |
| `customData`          | Your `userData` for that property, passed through unchanged.                           |

Every review comes from a verified stay - Expedia only publishes reviews from confirmed bookings, so there is no unverified flag to filter on. The API's analytics and UI payloads are dropped, along with fields it never populates (`brandType`, `propertyReviewSource`, `highlightedText`, `travelers`).

## Notes

**Review order.** Pages of a property are fetched in parallel, so items do not land in the dataset in sort order. Use `reviewPosition` to restore it. `sortBy` still decides which reviews you get when `maxReviewsPerHotel` is set.

**Limits.** `maxReviewsPerHotel` applies per property, and a run-wide limit on results stops the whole run once reached.

**Proxy.** The Actor uses Apify residential proxy. Expedia blocks datacenter IP ranges on the endpoint it reads, which costs whole pages of reviews rather than failing outright.

Actor icon attribution: [Condominium icons created by Uniconlabs - Flaticon](https://www.flaticon.com/free-icons/condominium)
