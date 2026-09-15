/**
 * Domain error types.
 *
 * Both extend Crawlee's NonRetryableError so a terminal failure (unsupported URL,
 * delisted Hotels.com listing) fails fast — Crawlee will not waste retries — and
 * lands in the single failedRequestHandler that emits the one error row
 * (PRD user story #9, ADR-0003).
 */
import { NonRetryableError } from 'crawlee';

/** Raised when a URL cannot be parsed / its platform is unsupported. */
export class URLParseError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'URLParseError';
    }
}

/**
 * Raised when a Hotels.com URL redirects away from its property page.
 * Hotels.com 301-redirects delisted/unknown IDs to the homepage, so there is no
 * property page to read the Expedia ID from — a dead input ID, not a scraper bug.
 */
export class HotelsComDelistedError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'HotelsComDelistedError';
    }
}

/**
 * Raised when the API says the property does not exist — a "Failed to retrieve
 * Property" GraphQL error, or a 200 whose summary carries no name. The signal is
 * deterministic, so a retry would spend proxy traffic to get the same answer.
 */
export class PropertyNotFoundError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'PropertyNotFoundError';
    }
}

/**
 * Raised when the endpoint soft-blocks with an empty / non-JSON body. RETRYABLE:
 * the crawler retires the session so the retry lands a fresh residential IP
 * (ADR-0003). Plain Error → Crawlee retries it (unlike NonRetryableError).
 */
export class BlockedResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BlockedResponseError';
    }
}
