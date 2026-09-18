/**
 * The input-level errors extend NonRetryableError, so a dead id or an
 * unsupported URL fails fast instead of burning retries. They also overwrite
 * `stack` with just the message, because Crawlee logs `error.stack` verbatim and
 * these report bad input rather than a crash.
 */
import { NonRetryableError } from 'crawlee';

/** Raised when a URL cannot be parsed / its platform is unsupported. */
export class URLParseError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'URLParseError';
        this.stack = `${this.name}: ${message}`;
    }
}

/**
 * Raised when a Hotels.com URL redirects away from its property page.
 * Hotels.com 301-redirects delisted/unknown IDs to the homepage, so there is no
 * property page to read the Expedia ID from - a dead input ID, not a scraper bug.
 */
export class HotelsComDelistedError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'HotelsComDelistedError';
        this.stack = `${this.name}: ${message}`;
    }
}

/**
 * Raised when the API says the property does not exist - a "Failed to retrieve
 * Property" GraphQL error, or a 200 whose summary carries no name. The signal is
 * deterministic, so a retry would spend proxy traffic to get the same answer.
 */
export class PropertyNotFoundError extends NonRetryableError {
    constructor(message: string) {
        super(message);
        this.name = 'PropertyNotFoundError';
        this.stack = `${this.name}: ${message}`;
    }
}

/**
 * Raised when the endpoint soft-blocks with an empty / non-JSON body. Retryable,
 * and the retry gets a fresh session
 */
export class BlockedResponseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BlockedResponseError';
    }
}
