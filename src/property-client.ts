/**
 * GraphQL client for the Expedia Group Mobile API, covering both the VRBO and
 * Expedia/Hotels.com app identities. Faithful port of `clients/vrbo_client.py`
 * and `clients/expedia_client.py` (which were near-identical apart from the app
 * identity headers/context). The two are unified here behind a `Profile`.
 *
 * The five fetchers (summary, content, gallery, offers, pageLayout) are the
 * exact set the per-URL pipeline runs in parallel.
 */
import { randomUUID } from 'node:crypto';

import { getSignedHeaders } from './auth.js';
import { BlockedResponseError } from './errors.js';
import type { HttpClient } from './http/http-client.js';
import {
    PRODUCT_GALLERY_QUERY,
    PROPERTY_CONTENT_QUERY,
    PROPERTY_OFFERS_WITH_UNITS_QUERY,
    PROPERTY_SUMMARY_QUERY,
    TEMPLATE_PAGE_LAYOUT_QUERY,
} from './queries.js';
import { validatePropertyResponse } from './response-validation.js';
import type { ExpediaSiteConfig, VrboSiteConfig } from './site-configs.js';

interface AbacusOverride { bucket: number; id: string }

/** App-identity constants that differ between the VRBO app and the Expedia app. */
export interface Profile {
    userAgent: string;
    clientInfoHeader: string;
    appVersion: string;
    appIdentifier: string;
    contextClientInfo: { name: string; version: string };
    abacusOverrides: AbacusOverride[];
    /** VRBO validates the summary response (reject wrong/blank); Expedia does not. */
    validateSummary: boolean;
}

export function makeVrboProfile(): Profile {
    const appVersion = '2025.47.0';
    return {
        userAgent: `HomeAway/${appVersion} Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)`,
        clientInfoHeader: `android.com.vacationrentals.homeaway,${appVersion},external`,
        appVersion,
        appIdentifier: 'com.vacationrentals.homeaway',
        contextClientInfo: { name: 'android.com.vacationrentals.homeaway', version: appVersion },
        abacusOverrides: [
            { bucket: 1, id: '25805' },
            { bucket: 1, id: '31491' },
            { bucket: 1, id: '31619' },
        ],
        validateSummary: true,
    };
}

export function makeExpediaProfile(site: ExpediaSiteConfig): Profile {
    const {appVersion} = site;
    return {
        userAgent: `Expedia/${appVersion} Dalvik/2.1.0 (Linux; U; Android 13; Generic Android-x86_64 Build/TQ3A.230901.001.C1)`,
        clientInfoHeader: `${site.appName},${appVersion},external`,
        appVersion,
        appIdentifier: site.appName.replace('android.', ''),
        contextClientInfo: { name: site.appName, version: appVersion },
        abacusOverrides: [],
        validateSummary: false,
    };
}

function numericOnly(id: string): string {
    return String(id).replace(/\D/g, '');
}

function parseDate(dateStr: string): { day: number; month: number; year: number } {
    const [year, month, day] = dateStr.split('-').map(Number);
    return { day, month, year };
}

function fmtUtc(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** Default check-in (tomorrow) and check-out (2 nights later), UTC. */
function getDefaultDates(): [string, string] {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const checkout = new Date(tomorrow.getTime() + 2 * 86_400_000);
    return [fmtUtc(tomorrow), fmtUtc(checkout)];
}

const ACCEPT = 'multipart/mixed;deferSpec=20220824, application/graphql-response+json, application/json';

const baseSecondary = () => ({
    booleans: [] as unknown[],
    dates: [] as unknown[],
    ranges: [] as unknown[],
    selections: [
        { id: 'useRewards', value: 'SHOP_WITHOUT_POINTS' },
        { id: 'productOffersId', value: randomUUID() },
    ],
});

export interface PropertyClientOptions {
    profile: Profile;
    site: VrboSiteConfig | ExpediaSiteConfig;
    http: HttpClient;
    deviceId?: string;
}

export class PropertyClient {
    private readonly profile: Profile;

    private readonly site: VrboSiteConfig | ExpediaSiteConfig;

    private readonly http: HttpClient;

    private readonly deviceId: string;

    private readonly endpoint: string;

    constructor(opts: PropertyClientOptions) {
        this.profile = opts.profile;
        this.site = opts.site;
        this.http = opts.http;
        this.deviceId = opts.deviceId ?? randomUUID();
        this.endpoint = `${opts.site.baseUrl}/graphql`;
    }

    private headers(operationName: string, operationId: string): Record<string, string> {
        const path = new URL(this.endpoint).pathname;
        const signed = getSignedHeaders('POST', path, null);
        const { locale } = this.site;
        return {
            accept: ACCEPT,
            'content-type': 'application/json',
            'user-agent': this.profile.userAgent,
            'client-info': this.profile.clientInfoHeader,
            'device-user-agent-id': this.deviceId,
            'x-eb-client':
                `PLATFORM:ANDROID;OS_VERSION:13;MANUFACTURER:unknown;MODEL:Generic Android-x86_64;`
                + `MODEL_NAME:Generic Android-x86_64;UPGRADE:false;APP_VERSION:${this.profile.appVersion};`
                + `LOCALE:${locale};APP_IDENTIFIER:${this.profile.appIdentifier};`,
            'x-apollo-operation-name': operationName,
            'x-apollo-operation-id': operationId,
            'x-mobvisid': randomUUID(),
            'ctx-view-id': randomUUID(),
            ...signed,
        };
    }

    private context(): Record<string, unknown> {
        return {
            clientInfo: this.profile.contextClientInfo,
            currency: this.site.currency,
            locale: this.site.locale,
            siteId: this.site.siteId,
            tpid: this.site.tpid,
            eapid: this.site.eapid,
            device: { type: 'APP_TABLET' },
            identity: { authState: 'ANONYMOUS', duaid: this.deviceId, tuid: '-1' },
            privacyTrackingState: 'CAN_TRACK',
            debugContext: { abacusOverrides: this.profile.abacusOverrides },
        };
    }

    private async postJson(payload: unknown, headers: Record<string, string>): Promise<any> {
        const resp = await this.http.fetch(this.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        const body = await resp.text();
        if (resp.status >= 400) {
            throw new Error(`HTTP ${resp.status}: ${body.slice(0, 500)}`);
        }
        const trimmed = (body ?? '').trim();
        if (!trimmed) {
            throw new BlockedResponseError(
                `Empty body from ${this.endpoint} (HTTP ${resp.status}) — soft-block`,
            );
        }
        let data: any;
        try {
            data = JSON.parse(trimmed);
        } catch {
            throw new BlockedResponseError(
                `Non-JSON body from ${this.endpoint} (HTTP ${resp.status}, ${body.length} bytes): ${trimmed.slice(0, 300)}`,
            );
        }
        if (Array.isArray(data.errors) && data.errors.length) {
            const msgs = data.errors.map((e: any) => e?.message ?? JSON.stringify(e)).join('; ');
            throw new Error(`GraphQL errors: ${msgs}`);
        }
        return data;
    }

    async fetchPropertySummary(propertyId: string): Promise<any> {
        const formatted = numericOnly(propertyId);
        const payload = {
            operationName: 'PropertySummary',
            variables: {
                context: this.context(),
                propertyId: formatted,
                searchCriteria: {
                    primary: { destination: { mapBounds: [], regionName: '' }, rooms: [{ adults: 2, children: [] }] },
                    secondary: baseSecondary(),
                },
            },
            query: PROPERTY_SUMMARY_QUERY,
        };
        const data = await this.postJson(payload, this.headers('PropertySummary', 'PropertySummary'));
        if (this.profile.validateSummary) {
            const { valid, reason } = validatePropertyResponse(data, formatted);
            if (!valid) throw new Error(`Property validation failed for ${formatted}: ${reason}`);
        }
        return data;
    }

    async fetchPropertyDetails(propertyId: string): Promise<any> {
        const formatted = numericOnly(propertyId);
        const payload = {
            operationName: 'PropertyContent',
            variables: {
                context: this.context(),
                propertyId: formatted,
                searchCriteria: {
                    primary: { destination: { mapBounds: [], regionName: '' }, rooms: [{ adults: 2, children: [] }] },
                    secondary: baseSecondary(),
                },
                useNewHostSection: false,
            },
            query: PROPERTY_CONTENT_QUERY,
        };
        return this.postJson(payload, this.headers('PropertyContent', 'PropertyContent'));
    }

    async fetchProductGallery(propertyId: string): Promise<any> {
        const formatted = numericOnly(propertyId);
        const payload = {
            operationName: 'ProductGallery',
            variables: {
                context: this.context(),
                productIdentifier: { id: formatted, type: 'PROPERTY_ID' },
            },
            query: PRODUCT_GALLERY_QUERY,
        };
        return this.postJson(payload, this.headers('ProductGallery', 'ProductGallery'));
    }

    async fetchPropertyOffers(propertyId: string): Promise<any> {
        const formatted = numericOnly(propertyId);
        const [checkIn, checkOut] = getDefaultDates();
        const payload = {
            operationName: 'PropertyOffers',
            variables: {
                context: this.context(),
                propertyId: formatted,
                searchCriteria: {
                    primary: {
                        dateRange: { checkInDate: parseDate(checkIn), checkOutDate: parseDate(checkOut) },
                        destination: { mapBounds: [], regionName: '' },
                        rooms: [{ adults: 2, children: [] }],
                    },
                    secondary: baseSecondary(),
                },
            },
            query: PROPERTY_OFFERS_WITH_UNITS_QUERY,
        };
        return this.postJson(payload, this.headers('PropertyOffers', 'PropertyOffers'));
    }

    async fetchPageLayout(propertyId: string): Promise<any> {
        const formatted = numericOnly(propertyId);
        const payload = {
            operationName: 'TemplatePageLayout',
            variables: {
                productIdentifier: {
                    id: formatted,
                    productLine: 'LODGING',
                    travelSearchCriteria: {
                        property: {
                            primary: { destination: { mapBounds: [], regionName: '' }, rooms: [{ adults: 2, children: [] }] },
                            secondary: baseSecondary(),
                        },
                    },
                    type: 'PROPERTY_ID',
                },
                context: this.context(),
            },
            query: TEMPLATE_PAGE_LAYOUT_QUERY,
        };
        return this.postJson(payload, this.headers('TemplatePageLayout', 'TemplatePageLayout'));
    }
}
