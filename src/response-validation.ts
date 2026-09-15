/**
 * Validate that a GraphQL response is for the property we requested.
 *
 * Faithful port of vrbo_client.validate_property_response. A valid property
 * always returns a non-blank name; dead listings and unresolved legacy IDs echo
 * the id with an empty/blank name, which must count as a failed scrape (not a
 * silent success with name=null). Also catches an endpoint returning a different
 * property than requested.
 */

/**
 * `not-found` means the id is dead (deterministic, don't retry); `wrong-property`
 * means the endpoint answered about someone else (an anomaly, worth a retry).
 */
export type ValidationResult =
    | { valid: true; reason: string }
    | { valid: false; reason: string; kind: 'not-found' | 'wrong-property' };

export function validatePropertyResponse(responseData: any, expectedId: string): ValidationResult {
    const summary = responseData?.data?.propertyInfo?.summary ?? {};
    const responseId = summary.id;
    const responseName = summary.name;

    if (!(responseName && String(responseName).trim())) {
        return {
            valid: false,
            kind: 'not-found',
            reason: `Empty response - no property name returned for ID ${responseId || expectedId}`,
        };
    }

    const expectedNum = String(expectedId).replace(/[a-zA-Z]+$/, '');
    const responseNum = responseId ? String(responseId).replace(/[a-zA-Z]+$/, '') : '';

    if (responseNum && expectedNum !== responseNum) {
        return {
            valid: false,
            kind: 'wrong-property',
            reason: `Wrong property: requested ${expectedId}, got ${responseId} ('${responseName}')`,
        };
    }

    return { valid: true, reason: 'Valid' };
}
