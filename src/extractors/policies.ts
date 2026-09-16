import type { HouseRules, PolicySection, PolicySubSection } from '../types.js';
import { asArray, extractTextItems, isDict, pyTruthy, safeGet } from './common.js';

/** Extract policies from PropertyContent. */
export function extractPolicies(contentData: any): PolicySection[] {
    const policiesList: PolicySection[] = [];

    const policies = safeGet(contentData, ['data', 'propertyInfo', 'propertyContentSectionGroups', 'policies'], {});
    const sections = policies.sections || [];

    for (const section of asArray(sections)) {
        const sectionHeader = section.header || {};
        const sectionTitle = sectionHeader.text ?? null;

        const items: (string | PolicySubSection)[] = [];
        const bodySubs = section.bodySubSections || [];

        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const header = element.header || {};
                    const subTitle = pyTruthy(header) ? (header.text ?? null) : null;
                    const iconId = pyTruthy(header) ? safeGet(header, ['icon', 'id']) : null;

                    const texts = extractTextItems(element.items || []);

                    if (pyTruthy(subTitle) && pyTruthy(texts)) {
                        items.push({
                            iconId,
                            title: subTitle,
                            items: texts,
                        });
                    } else if (pyTruthy(texts)) {
                        items.push(...texts);
                    }
                }
            }
        }

        if (pyTruthy(items)) {
            policiesList.push({
                title: sectionTitle,
                items,
            });
        }
    }

    return policiesList;
}

/** Extract important information items. */
export function extractImportantInfo(contentData: any): string[] {
    const infoItems: string[] = [];

    const important = safeGet(
        contentData,
        ['data', 'propertyInfo', 'propertyContentSectionGroups', 'importantInfo'],
        {},
    );
    const sections = important.sections || [];

    for (const section of asArray(sections)) {
        const bodySubs = section.bodySubSections || [];
        for (const sub of asArray(bodySubs)) {
            const elementsV2 = sub.elementsV2 || [];
            for (const elemGroup of asArray(elementsV2)) {
                for (const element of asArray(elemGroup.elements)) {
                    const texts = extractTextItems(element.items || []);
                    infoItems.push(...texts);
                }
            }
        }
    }

    return infoItems;
}

/** Extract structured house rules from policies. */
export function extractHouseRules(policies: any): HouseRules {
    const result: HouseRules = {
        checkInTime: null,
        checkOutTime: null,
        smokingAllowed: null,
        petsAllowed: null,
        eventsAllowed: null,
    };

    const checkinPattern = /[Cc]heck[- ]?in[:\s]+(?:after\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)/i;
    const checkoutPattern = /[Cc]heck[- ]?out[:\s]+(?:before\s+)?(\d{1,2}(?::\d{2})?\s*(?:[AaPp][Mm])?)/i;

    const smokingNoPattern = /no\s+smoking|smoking\s+(?:is\s+)?not\s+(?:allowed|permitted)|non[- ]?smoking/i;
    const smokingYesPattern = /smoking\s+(?:is\s+)?(?:allowed|permitted)/i;

    const petsNoPattern = /no\s+pets|pets?\s+(?:are\s+)?not\s+allowed|pet[- ]?free/i;
    const petsYesPattern = /pets?\s+(?:are\s+)?allowed|pets?\s+welcome|pet[- ]?friendly/i;

    const eventsNoPattern = /no\s+(?:events?|parties)|(?:events?|parties)\s+(?:are\s+)?not\s+allowed/i;
    const eventsYesPattern = /(?:events?|parties)\s+(?:are\s+)?allowed|suitable\s+for\s+events/i;

    function searchPolicies(obj: any): string[] {
        const texts: string[] = [];
        if (isDict(obj)) {
            for (const [key, val] of Object.entries(obj)) {
                if ((key === 'text' || key === 'title' || key === 'value') && typeof val === 'string') {
                    texts.push(val);
                } else {
                    texts.push(...searchPolicies(val));
                }
            }
        } else if (Array.isArray(obj)) {
            for (const item of obj) {
                texts.push(...searchPolicies(item));
            }
        } else if (typeof obj === 'string') {
            texts.push(obj);
        }
        return texts;
    }

    const allText = searchPolicies(policies).join(' ');

    let match = checkinPattern.exec(allText);
    if (match) {
        result.checkInTime = match[1].trim();
    }

    match = checkoutPattern.exec(allText);
    if (match) {
        result.checkOutTime = match[1].trim();
    }

    if (smokingNoPattern.test(allText)) {
        result.smokingAllowed = false;
    } else if (smokingYesPattern.test(allText)) {
        result.smokingAllowed = true;
    }

    if (petsNoPattern.test(allText)) {
        result.petsAllowed = false;
    } else if (petsYesPattern.test(allText)) {
        result.petsAllowed = true;
    }

    if (eventsNoPattern.test(allText)) {
        result.eventsAllowed = false;
    } else if (eventsYesPattern.test(allText)) {
        result.eventsAllowed = true;
    }

    return result;
}
