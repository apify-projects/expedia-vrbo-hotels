import type { CheerioCrawler } from '@crawlee/cheerio';
import type { Dictionary } from '@crawlee/core';
import { Actor, log } from 'apify';

import { PPE_EVENTS } from '../consts.js';
import type { PpeEvent } from '../types/common.js';

/** Push items to default dataset, charge for the event, and stop the crawler if the charge limit is reached. */
export const pushDataAndCharge = async (
    items: Dictionary | Dictionary[],
    eventName: PpeEvent,
    crawler: CheerioCrawler,
): Promise<void> => {
    const { eventChargeLimitReached } = await Actor.pushData(items, eventName);

    if (eventChargeLimitReached) {
        log.warningOnce('Reached the maximum charge limit, stopping the actor.');
        await crawler.autoscaledPool?.abort();
    }
};

/** Skipped when already charged, so a migrated run does not pay the start fee twice. */
export const chargeRunStart = async (): Promise<void> => {
    if (Actor.getChargingManager().getChargedEventCount(PPE_EVENTS.START) > 0) return;

    await Actor.charge({ eventName: PPE_EVENTS.START });
};

/** The run's paid-results cap, which pay-per-event runs still honour alongside their charge limit. */
export const getMaxPaidDatasetItems = (): number => Actor.getEnv().actorMaxPaidDatasetItems ?? Infinity;
