/**
 * Regional Site configurations for VRBO and Expedia/Hotels.com.
 *
 * Faithful port of the SITE_CONFIGS maps in `clients/vrbo_client.py` and
 * `clients/expedia_client.py`. Insertion order is preserved so substring
 * detection resolves the same key the Python code did.
 */

export interface VrboSiteConfig {
    baseUrl: string;
    siteId: number;
    tpid: number;
    eapid: number;
    locale: string;
    currency: string;
}

export interface ExpediaSiteConfig extends VrboSiteConfig {
    appName: string;
    appVersion: string;
}

// NOTE: always scrape VRBO via vrbo.com — regional endpoints can return wrong
// property data for some IDs (AGENT.md §7).
export const VRBO_SITE_CONFIGS: Record<string, VrboSiteConfig> = {
    'vrbo.com': { baseUrl: 'https://www.vrbo.com', siteId: 9001001, tpid: 9001, eapid: 1, locale: 'en_US', currency: 'USD' },
    'bookabach.co.nz': { baseUrl: 'https://www.bookabach.co.nz', siteId: 9006043, tpid: 9006, eapid: 43, locale: 'en_NZ', currency: 'NZD' },
    'stayz.com.au': { baseUrl: 'https://www.stayz.com.au', siteId: 9006044, tpid: 9006, eapid: 44, locale: 'en_AU', currency: 'AUD' },
    'abritel.fr': { baseUrl: 'https://www.abritel.fr', siteId: 9001020, tpid: 9001, eapid: 20, locale: 'en_US', currency: 'EUR' },
    'fewo-direkt.de': { baseUrl: 'https://www.fewo-direkt.de', siteId: 9001030, tpid: 9001, eapid: 30, locale: 'en_US', currency: 'EUR' },
};

export const EXPEDIA_SITE_CONFIGS: Record<string, ExpediaSiteConfig> = {
    'expedia.com': {
        baseUrl: 'https://www.expedia.com', siteId: 1, tpid: 1, eapid: 0, locale: 'en_US', currency: 'USD',
        appName: 'android.com.expedia.bookings', appVersion: '2024.47.0',
    },
    'expedia.co.uk': {
        baseUrl: 'https://www.expedia.co.uk', siteId: 70201, tpid: 70201, eapid: 0, locale: 'en_GB', currency: 'GBP',
        appName: 'android.com.expedia.bookings', appVersion: '2024.47.0',
    },
    'hotels.com': {
        baseUrl: 'https://www.hotels.com', siteId: 300000001, tpid: 3001, eapid: 0, locale: 'en_US', currency: 'USD',
        appName: 'android.com.hcom.android', appVersion: '2024.47.0',
    },
    'hotels.co.uk': {
        baseUrl: 'https://uk.hotels.com', siteId: 300000026, tpid: 3001, eapid: 26, locale: 'en_GB', currency: 'GBP',
        appName: 'android.com.hcom.android', appVersion: '2024.47.0',
    },
};

function hostOf(url: string): string | null {
    if (!url.startsWith('http')) return null;
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
}

/** Detect VRBO site key from URL domain (substring match, insertion order). */
export function detectVrboSite(url: string): string | null {
    const host = hostOf(url)?.replace('www.', '');
    if (host == null) return null;
    for (const key of Object.keys(VRBO_SITE_CONFIGS)) {
        if (host.includes(key)) return key;
    }
    return null;
}

/** Detect Expedia/Hotels.com site key from URL domain (substring match, insertion order). */
export function detectExpediaSite(url: string): string | null {
    const host = hostOf(url)?.replace('www.', '').replace('uk.', '');
    if (host == null) return null;
    for (const key of Object.keys(EXPEDIA_SITE_CONFIGS)) {
        if (host.includes(key)) return key;
    }
    return null;
}
